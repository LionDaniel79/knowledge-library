"""Consistent, read-only SQLite snapshot plus image assets and source manifest."""
import argparse,hashlib,json,shutil,sqlite3,time,re
from pathlib import Path

def sha256(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(4*1024*1024),b''):h.update(block)
    return h.hexdigest()

def asset_inventory(assets):
    assets=Path(assets).resolve(strict=True);files=[]
    for path in assets.rglob('*'):
        if path.is_file() and (path.suffix.lower() in ('.png','.jpg','.jpeg','.webp','.gif') or re.fullmatch('[a-f0-9]{64}',path.name)):
            if not path.resolve(strict=True).is_relative_to(assets):raise ValueError('Asset link escapes the source directory')
            files.append((path,path.relative_to(assets),path.stat().st_size))
    return files

def copy_assets(files,output):
    images=[]
    for path,relative,_ in files:
        target=output/relative;target.parent.mkdir(parents=True,exist_ok=True)
        if target.exists():raise FileExistsError('Asset destination already exists')
        shutil.copyfile(path,target);digest=sha256(target)
        if digest!=sha256(path):raise RuntimeError('Image copy verification failed')
        if re.fullmatch('[a-f0-9]{64}',path.name) and digest!=path.name:raise RuntimeError('Original asset hash mismatch')
        images.append({'path':str(relative),'bytes':target.stat().st_size,'sha256':digest})
    return images

def backup_index(index,output,assets=None,min_free=5*1024**3,progress=None):
    index=Path(index).resolve(strict=True);output=Path(output).absolute()
    if output.exists():raise FileExistsError('Choose a new backup directory')
    if not output.parent.is_dir():raise ValueError('Backup parent must exist')
    asset_files=[]
    if assets:
        asset_files=asset_inventory(assets)
    expected=index.stat().st_size+sum(size for _,_,size in asset_files)
    if shutil.disk_usage(output.parent).free<expected+min_free:raise RuntimeError('Insufficient backup space')
    output.mkdir();started=time.time()
    source=sqlite3.connect(index.as_uri()+'?mode=ro',uri=True,timeout=30)
    destination=sqlite3.connect(output/'pdf-library.sqlite')
    try:
        source.execute('BEGIN')
        # A read transaction fixes the snapshot while OCR continues in WAL mode.
        manifest=source.execute('SELECT relative_path,bytes,signature,sha256 FROM documents ORDER BY relative_path').fetchall()
        def check(status,remaining,total):
            if time.time()-started>3600:raise TimeoutError('Backup exceeded one hour; incomplete directory retained')
            if shutil.disk_usage(output).free<min_free:raise RuntimeError('Backup reserve exhausted')
            if progress:progress(status,remaining,total)
        source.backup(destination,pages=4096,progress=check,sleep=.05)
        source.rollback()
        if destination.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('Backup SQLite check failed')
    finally:destination.close();source.close()
    images=copy_assets(asset_files,output/'assets')
    (output/'pdf-source-manifest.json').write_text(json.dumps({'columns':['relative_path','bytes','signature','sha256'],'files':manifest},ensure_ascii=False),encoding='utf-8')
    report={'complete':True,'snapshotStartedAt':started,'finishedAt':time.time(),'indexBytes':(output/'pdf-library.sqlite').stat().st_size,'indexSha256':sha256(output/'pdf-library.sqlite'),'sqliteCheck':'ok','sourceFiles':len(manifest),'sourceBytes':sum(row[1] for row in manifest),'pdfOriginalsCopied':False,'images':images}
    (output/'verification.json').write_text(json.dumps(report,ensure_ascii=False),encoding='utf-8')
    return report

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--index',required=True);p.add_argument('--output',required=True);p.add_argument('--assets');a=p.parse_args()
    last=[0]
    def progress(status,remaining,total):
        if time.time()-last[0]>20:
            print(json.dumps({'copiedPages':total-remaining,'totalPages':total}),flush=True);last[0]=time.time()
    result=backup_index(a.index,a.output,a.assets,progress=progress)
    print(json.dumps({k:v for k,v in result.items() if k!='images'}),flush=True)
