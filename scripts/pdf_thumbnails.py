"""Create small first-page previews in the private index directory. Never alter PDFs."""
import argparse,hashlib,json,os,sqlite3
from pathlib import Path
import pypdfium2 as pdfium
def run(index):
    db=sqlite3.connect(index,timeout=10)
    db.row_factory=sqlite3.Row
    rows=db.execute("SELECT id,path,root,signature,status FROM documents WHERE status NOT IN ('error','locked','missing','changed') ORDER BY bytes").fetchall()
    db.close()
    destination=Path(index).parent/'pdf-covers';destination.mkdir(exist_ok=True)
    made=failed=existing=0
    for row in rows:
        key=hashlib.sha256(row['signature'].encode()).hexdigest()[:16]
        out=destination/f"{row['id']}-{key}.jpg"
        if out.exists():existing+=1;continue
        try:
            path=Path(row['path']).resolve();root=Path(row['root']).resolve()
            if not path.is_relative_to(root):raise ValueError('outside root')
            before=path.stat()
            if f'{before.st_size}:{before.st_mtime_ns}'!=row['signature']:raise ValueError('changed')
            with pdfium.PdfDocument(path) as doc:
                if not len(doc):raise ValueError('empty')
                page=doc[0]
                try:
                    width,height=page.get_size()
                    bitmap=page.render(scale=min(320/max(width,1),460/max(height,1),1))
                    try:
                        image=bitmap.to_pil().convert('RGB')
                        try:
                            after=path.stat()
                            if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('changed')
                            temp=out.with_suffix('.tmp');image.save(temp,format='JPEG',quality=85);os.replace(temp,out)
                        finally:image.close()
                    finally:bitmap.close()
                finally:page.close()
            made+=1
        except Exception:failed+=1
        if (made+failed)%250==0:print(json.dumps(dict(created=made,failed=failed,cached=existing,total=len(rows))),flush=True)
    print(json.dumps(dict(created=made,failed=failed,cached=existing,total=len(rows),complete=True)),flush=True)
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--index',required=True);args=parser.parse_args();run(args.index)
