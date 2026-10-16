"""PDF storage maintenance: originals are never modified."""
import argparse, json, shutil, sqlite3, time, hashlib
from pathlib import Path
from pdf_library import signature
from pdf_job_state import write_state,processing_lock

def readonly(path):
    db=sqlite3.connect(Path(path).resolve(strict=True).as_uri()+'?mode=ro',uri=True,timeout=30)
    db.row_factory=sqlite3.Row
    return db

def table_counts(db):
    names=('documents','pages','page_ocr')
    existing={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    return {name:db.execute('SELECT count(*) FROM '+name).fetchone()[0] for name in names if name in existing}

def copy_index(source,destination,min_free_bytes=8*1024**3):
    source=Path(source).resolve(strict=True);destination=Path(destination).resolve()
    if source==destination:raise ValueError('원본과 복사 위치가 같습니다.')
    if destination.exists():raise FileExistsError('기존 색인은 덮어쓰지 않습니다.')
    destination.parent.mkdir(parents=True,exist_ok=True)
    if shutil.disk_usage(destination.parent).free < source.stat().st_size*1.3+min_free_bytes:
        raise RuntimeError('복사본과 검증 작업을 저장할 공간이 부족합니다.')
    # Reserve the final name exclusively; an interrupted copy never gets a verified marker.
    with destination.open('xb'):pass
    src=readonly(source);dst=sqlite3.connect(destination)
    started=time.time();last=[0]
    def progress(status,remaining,total):
        if time.time()-last[0]>20:
            print(json.dumps({'phase':'copy','pagesCopied':total-remaining,'pagesTotal':total}),flush=True);last[0]=time.time()
    try:
        src.execute('BEGIN')
        expected=table_counts(src)
        src.backup(dst,pages=8192,progress=progress)
        print(json.dumps({'phase':'verify'}),flush=True)
        if dst.execute('PRAGMA quick_check').fetchall()!=[('ok',)]:raise RuntimeError('복사본 무결성 검사 실패')
        if table_counts(dst)!=expected:raise RuntimeError('복사본 자료 건수가 다릅니다.')
        # Progress queries must not re-read gigabytes of page text on every refresh.
        dst.execute('CREATE INDEX IF NOT EXISTS pages_document_method ON pages(document_id,method)')
        dst.execute('CREATE INDEX IF NOT EXISTS documents_progress ON documents(processing_scope,status,page_count,indexed_pages,text_pages,sha256,id)')
        dst.commit()
        result={'integrity':'ok','counts':expected,'source':str(source),'destination':str(destination),'elapsedSeconds':round(time.time()-started,1)}
        destination.with_suffix('.verified.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        return result
    finally:dst.close();src.close()

def checked_path(row,root):
    path=Path(row['path']).resolve(strict=True)
    if not path.is_relative_to(root) or path.suffix.lower()!='.pdf' or not path.is_file():
        raise ValueError('등록한 PDF 폴더 밖의 경로')
    return path

def file_hash(path,delay=0.05,on_progress=None):
    digest=hashlib.sha256();last=time.monotonic()
    with path.open('rb') as stream:
        while chunk:=stream.read(1024*1024):
            digest.update(chunk)
            if delay:time.sleep(delay)
            if on_progress and time.monotonic()-last>20:on_progress();last=time.monotonic()
    return digest.hexdigest()

def hash_documents(index,root,limit=0,delay=0.05):
    root=Path(root).resolve(strict=True)
    db=sqlite3.connect(index,timeout=30);db.row_factory=sqlite3.Row
    counts={'hashed':0,'changed':0,'missing':0,'blocked':0,'errors':0,'processed':0}
    try:
        rows=db.execute("SELECT id,path,signature FROM documents WHERE sha256 IS NULL AND status NOT IN ('missing','changed') ORDER BY bytes,id").fetchall()
        write_state(index,'hash','running',counts)
        for row in rows[:limit or len(rows)]:
            counts['processed']+=1
            try:
                path=checked_path(row,root)
                if signature(path.stat())!=row['signature']:counts['changed']+=1;continue
                digest=file_hash(path,delay,lambda:write_state(index,'hash','running',counts))
                if signature(path.stat())!=row['signature']:counts['changed']+=1;continue
                updated=db.execute('UPDATE documents SET sha256=? WHERE id=? AND signature=? AND sha256 IS NULL',(digest,row['id'],row['signature'])).rowcount;db.commit()
                counts['hashed']+=updated
            except FileNotFoundError:counts['missing']+=1
            except ValueError:counts['blocked']+=1
            except Exception:db.rollback();counts['errors']+=1
            finally:
                write_state(index,'hash','running',counts)
                if counts['processed']%20==0:print(json.dumps(counts),flush=True)
        write_state(index,'hash','completed' if len(rows)<=counts['processed'] else 'paused',counts,'batch_limit' if limit and len(rows)>limit else None)
        return counts
    except BaseException:
        write_state(index,'hash','failed',counts,'interrupted');raise
    finally:db.close()

def audit(index,root):
    root=Path(root).resolve(strict=True);db=readonly(index)
    try:
        rows=[dict(r) for r in db.execute('SELECT id,path,relative_path,title,sha256,signature,status,error,material_kind,processing_scope FROM documents ORDER BY id')]
        groups={};verified=0;unavailable=0;pending=0;issues=[]
        for row in rows:
            reason=None
            try:
                path=checked_path(row,root)
                if signature(path.stat())!=row['signature']:reason='changed'
            except FileNotFoundError:reason='missing'
            except ValueError:reason='outside_root'
            except OSError:reason='unavailable'
            if reason:
                if row['sha256']:unavailable+=1
                issues.append({'id':row['id'],'relativePath':row['relative_path'],'reason':reason,'processingScope':row['processing_scope']})
            elif row['sha256']:
                verified+=1;groups.setdefault(row['sha256'],[]).append({'id':row['id'],'title':row['title'],'relativePath':row['relative_path']})
            else:pending+=1
        return {'version':1,'createdAt':time.time(),'files':len(rows),'hashes':{'stored':sum(bool(r['sha256']) for r in rows),'verified':verified,'staleOrUnavailable':unavailable,'pending':pending},'fileIssues':issues,'duplicates':[{'sha256':key,'documents':value} for key,value in groups.items() if len(value)>1],'errors':[{'id':r['id'],'relativePath':r['relative_path'],'status':r['status'],'error':r['error'],'processingScope':r['processing_scope'],'materialKind':r['material_kind']} for r in rows if r['status'] in ('error','locked','missing','changed')],'review':[{'id':r['id'],'relativePath':r['relative_path']} for r in rows if r['material_kind']=='review']}
    finally:db.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['copy','hash','audit']);parser.add_argument('--index',required=True);parser.add_argument('--destination');parser.add_argument('--root');parser.add_argument('--limit',type=int,default=0);parser.add_argument('--delay',type=float,default=0.05);parser.add_argument('--output')
    args=parser.parse_args()
    if args.action=='copy':result=copy_index(args.index,args.destination)
    elif args.action=='hash':
        with processing_lock(args.index,'hash'):result=hash_documents(args.index,args.root,args.limit,args.delay)
    else:result=audit(args.index,args.root)
    if args.output:Path(args.output).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result if args.action!='audit' else {'files':result['files'],'hashes':result['hashes'],'duplicateGroups':len(result['duplicates']),'errors':len(result['errors']),'review':len(result['review'])},ensure_ascii=False),flush=True)
