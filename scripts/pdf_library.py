"""Read-only PDF collection scanner and resumable, local page index."""
import argparse, hashlib, json, os, sqlite3, time, uuid, shutil
from pathlib import Path
from pdf_scope import classify, SCOPE_VERSION

def connect(index):
    Path(index).parent.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(index,timeout=30); db.row_factory=sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL'); db.execute('PRAGMA busy_timeout=30000')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,root TEXT NOT NULL,path TEXT NOT NULL UNIQUE,relative_path TEXT NOT NULL,title TEXT NOT NULL,author TEXT NOT NULL DEFAULT '',bytes INTEGER NOT NULL,mtime_ns TEXT NOT NULL,signature TEXT NOT NULL,sha256 TEXT,page_count INTEGER,indexed_pages INTEGER NOT NULL DEFAULT 0,text_pages INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',error TEXT,metadata TEXT NOT NULL DEFAULT '{}',toc TEXT NOT NULL DEFAULT '[]',seen TEXT,updated_at TEXT);
      CREATE TABLE IF NOT EXISTS pages(id INTEGER PRIMARY KEY,document_id TEXT NOT NULL,page_number INTEGER NOT NULL,text TEXT NOT NULL,method TEXT NOT NULL,UNIQUE(document_id,page_number));
      CREATE INDEX IF NOT EXISTS pages_document ON pages(document_id,page_number);
      CREATE INDEX IF NOT EXISTS pages_document_method ON pages(document_id,method);
      CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(text,content='pages',content_rowid='id',tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN INSERT INTO pages_fts(rowid,text) VALUES(new.id,new.text); END;
      CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN INSERT INTO pages_fts(pages_fts,rowid,text) VALUES('delete',old.id,old.text); END;
    ''')
    columns = {r['name'] for r in db.execute('PRAGMA table_info(documents)')}
    for name, definition in {
        'processing_scope': "TEXT NOT NULL DEFAULT 'metadata_only'",
        'material_kind': "TEXT NOT NULL DEFAULT 'review'",
        'scope_reason': "TEXT NOT NULL DEFAULT '범위 분류 대기'",
        'scope_version': "TEXT NOT NULL DEFAULT ''",
        'scope_override': "INTEGER NOT NULL DEFAULT 0",
        'basic_checked_signature': "TEXT NOT NULL DEFAULT ''",
    }.items():
        if name not in columns: db.execute('ALTER TABLE documents ADD COLUMN '+name+' '+definition)
    db.execute('CREATE INDEX IF NOT EXISTS documents_progress ON documents(processing_scope,status,page_count,indexed_pages,text_pages,sha256,id)')
    db.commit()
    return db

def apply_scope(index):
    db=connect(index)
    try:
        for row in db.execute('SELECT id,relative_path,title FROM documents WHERE scope_override=0').fetchall():
            scope,kind,reason=classify(row['relative_path'],row['title'])
            db.execute("UPDATE documents SET processing_scope=?,material_kind=?,scope_reason=?,scope_version=?,status=CASE WHEN ?='full' AND status='metadata_only' THEN 'pending' ELSE status END WHERE id=?", (scope,kind,reason,SCOPE_VERSION,scope,row['id']))
        db.commit()
        return [dict(r) for r in db.execute('SELECT processing_scope,material_kind,count(*) AS files FROM documents GROUP BY processing_scope,material_kind')]
    finally: db.close()

def signature(st): return str(st.st_size)+':'+str(st.st_mtime_ns)

def scan(root,index):
    root=Path(root).resolve(strict=True)
    if not root.is_dir(): raise ValueError('PDF root must be a directory')
    db=connect(index); seen=str(uuid.uuid4()); count=0; changed=0
    try:
        for parent,dirs,files in os.walk(root,followlinks=False):
            dirs[:]=[d for d in dirs if not Path(parent,d).is_symlink()]
            for name in sorted(files):
                if not name.lower().endswith('.pdf'): continue
                path=Path(parent,name)
                if path.is_symlink(): continue
                path=path.resolve()
                if not path.is_relative_to(root): continue
                st=path.stat(); key=str(uuid.uuid5(uuid.NAMESPACE_URL,os.path.normcase(str(path)))); sig=signature(st)
                old=db.execute('SELECT signature FROM documents WHERE id=?',(key,)).fetchone()
                if old and old['signature']!=sig:
                    db.execute('DELETE FROM pages WHERE document_id=?',(key,)); db.execute("UPDATE documents SET status='pending',indexed_pages=0,text_pages=0,page_count=NULL,sha256=NULL,error=NULL,metadata='{}',toc='[]' WHERE id=?",(key,)); changed+=1
                db.execute('''INSERT INTO documents(id,root,path,relative_path,title,bytes,mtime_ns,signature,seen,updated_at) VALUES(?,?,?,?,?,?,?,?,?,datetime('now'))
                  ON CONFLICT(id) DO UPDATE SET bytes=excluded.bytes,mtime_ns=excluded.mtime_ns,signature=excluded.signature,seen=excluded.seen,updated_at=excluded.updated_at,status=CASE WHEN documents.status='missing' THEN 'pending' ELSE documents.status END''',
                  (key,str(root),str(path),str(path.relative_to(root)),path.stem,st.st_size,str(st.st_mtime_ns),sig,seen))
                count+=1
                if count%250==0: db.commit()
        db.execute("UPDATE documents SET status='missing' WHERE root=? AND seen<>?",(str(root),seen)); db.commit()
        apply_scope(index)
        return {'files':count,'changed':changed,'bytes':db.execute('SELECT coalesce(sum(bytes),0) FROM documents WHERE root=? AND seen=?',(str(root),seen)).fetchone()[0]}
    finally: db.close()

def index_document(index,document_id,page_budget=100):
    import pypdfium2 as pdfium
    db=connect(index)
    try:
        row=db.execute('SELECT * FROM documents WHERE id=?',(document_id,)).fetchone()
        if not row: return
        if row['scope_version'] != SCOPE_VERSION and not row['scope_override']:
            scope,kind,reason=classify(row['relative_path'],row['title'])
            db.execute('UPDATE documents SET processing_scope=?,material_kind=?,scope_reason=?,scope_version=? WHERE id=?',(scope,kind,reason,SCOPE_VERSION,document_id)); db.commit()
            row=db.execute('SELECT * FROM documents WHERE id=?',(document_id,)).fetchone()
        if row['processing_scope']=='metadata_only' and row['basic_checked_signature']==row['signature']: return
        path=Path(row['path'])
        if not path.exists():
            db.execute("UPDATE documents SET status='missing' WHERE id=?",(document_id,)); db.commit(); return
        if signature(path.stat())!=row['signature']:
            db.execute('DELETE FROM pages WHERE document_id=?',(document_id,)); db.execute("UPDATE documents SET status='changed',error='파일이 변경되었습니다. 목록을 다시 스캔해 주세요.' WHERE id=?",(document_id,)); db.commit(); return
        db.execute("UPDATE documents SET status='indexing',error=NULL WHERE id=?",(document_id,)); db.commit()
        with pdfium.PdfDocument(str(path)) as pdf:
            count=len(pdf); metadata=pdf.get_metadata_dict(); toc=[]
            if row['processing_scope']=='metadata_only':
                # Read document header only; never visit pages or bookmarks for excluded materials.
                db.execute("UPDATE documents SET page_count=?,metadata=?,author=?,basic_checked_signature=?,status=CASE WHEN indexed_pages=0 THEN 'metadata_only' ELSE ? END,error=NULL,updated_at=datetime('now') WHERE id=?",(count,json.dumps(metadata,ensure_ascii=False),metadata.get('Author','')[:300],row['signature'],row['status'],document_id)); db.commit(); return
            for item in pdf.get_toc(max_depth=8):
                dest=item.get_dest(); page=dest.get_index() if dest else None
                toc.append({'title':item.get_title(),'page':page+1 if page is not None else None,'level':item.level})
                if len(toc)>=1000: break
            start=row['indexed_pages']; end=min(count,start+page_budget)
            for n in range(start,end):
                page=pdf[n]
                try:
                    tp=page.get_textpage()
                    try: text=tp.get_text_bounded().replace('\x00','').strip()
                    finally: tp.close()
                finally: page.close()
                # Preserve exact extracted text; never fill empty scanned pages with guessed text.
                db.execute('INSERT OR IGNORE INTO pages(document_id,page_number,text,method) VALUES(?,?,?,?)',(document_id,n+1,text,'text' if text else 'needs_ocr'))
                db.execute('UPDATE documents SET indexed_pages=? WHERE id=?',(n+1,document_id))
                if n%20==0: db.commit()
            if signature(path.stat())!=row['signature']:
                db.execute('DELETE FROM pages WHERE document_id=?',(document_id,)); db.execute("UPDATE documents SET status='changed',indexed_pages=0,error='색인 도중 파일이 변경되었습니다.' WHERE id=?",(document_id,)); db.commit(); return
            text_pages=db.execute("SELECT count(*) FROM pages WHERE document_id=? AND method='text'",(document_id,)).fetchone()[0]
            status='indexing' if end<count else ('ready' if text_pages==count else 'needs_ocr' if text_pages==0 else 'partial_ocr')
            # Full content hashes are computed for small files here. Large-file hashes can
            # be added by the --hash command; size/name is never an exact duplicate claim.
            sha=row['sha256']
            if end==count and row['bytes']<=4*1024*1024:
                with path.open('rb') as f: sha=hashlib.file_digest(f,'sha256').hexdigest()
            db.execute('UPDATE documents SET page_count=?,text_pages=?,status=?,metadata=?,toc=?,author=?,sha256=?,updated_at=datetime(\'now\') WHERE id=?',(count,text_pages,status,json.dumps(metadata,ensure_ascii=False),json.dumps(toc,ensure_ascii=False),metadata.get('Author','')[:300],sha,document_id)); db.commit()
    except Exception as e:
        db.rollback(); db.execute("UPDATE documents SET status=?,error=? WHERE id=?",('locked' if getattr(e,'err_code',None)==4 else 'error',str(e)[:500],document_id)); db.commit()
    finally: db.close()

def work(index,page_budget=100,limit=0,min_free_bytes=2*1024**3):
    apply_scope(index)
    done=0
    while not limit or done<limit:
        if shutil.disk_usage(Path(index).resolve().parent).free < min_free_bytes:
            raise RuntimeError('색인 저장 공간이 부족하여 중단했습니다. 완료한 페이지는 보존됩니다.')
        db=connect(index)
        row=db.execute("SELECT id FROM documents WHERE processing_scope='full' AND status IN ('pending','indexing') ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,updated_at,bytes LIMIT 1").fetchone(); db.close()
        if not row: break
        index_document(index,row['id'],page_budget); done+=1
        if done%20==0: print(json.dumps({'batches':done,**status(index)}),flush=True)
    return status(index)

def status(index):
    db=connect(index)
    try: return {'states':dict(db.execute('SELECT status,count(*) FROM documents WHERE processing_scope=\'full\' GROUP BY status').fetchall()),'scope':[dict(r) for r in db.execute('SELECT processing_scope,material_kind,count(*) AS files FROM documents GROUP BY processing_scope,material_kind')],'pages':db.execute('SELECT count(*) FROM pages p JOIN documents d ON d.id=p.document_id WHERE d.processing_scope=\'full\'').fetchone()[0]}
    finally: db.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('action',choices=['scan','work','status','hash','scope','basic']); parser.add_argument('--index',required=True); parser.add_argument('--root'); parser.add_argument('--page-budget',type=int,default=100); parser.add_argument('--limit',type=int,default=0); parser.add_argument('--min-free-gb',type=float,default=8)
    args=parser.parse_args()
    if args.action=='scan': result=scan(args.root,args.index)
    elif args.action=='work': result=work(args.index,args.page_budget,args.limit,int(args.min_free_gb*1024**3))
    elif args.action=='scope': result=apply_scope(args.index)
    elif args.action=='basic':
        apply_scope(args.index); db=connect(args.index)
        # Reuse basic headers already collected by earlier indexing; do not re-open thousands of PDFs.
        db.execute("UPDATE documents SET basic_checked_signature=signature WHERE processing_scope='metadata_only' AND page_count IS NOT NULL AND metadata<>'{}' AND status NOT IN ('missing','locked','error','changed')"); db.commit()
        rows=db.execute("SELECT id FROM documents WHERE processing_scope='metadata_only' AND basic_checked_signature<>signature AND status NOT IN ('missing','locked','error','changed')").fetchall(); db.close()
        for row in rows[:args.limit or len(rows)]: index_document(args.index,row['id'])
        result={'basic_checked':min(args.limit or len(rows),len(rows))}
    elif args.action=='hash':
        db=connect(args.index); count=0
        for row in db.execute("SELECT id,path,signature FROM documents WHERE sha256 IS NULL AND status NOT IN ('missing','changed')").fetchall():
            path=Path(row['path'])
            if path.exists() and signature(path.stat())==row['signature']:
                with path.open('rb') as f: digest=hashlib.file_digest(f,'sha256').hexdigest()
                if signature(path.stat())==row['signature']: db.execute('UPDATE documents SET sha256=? WHERE id=?',(digest,row['id'])); db.commit(); count+=1
            if args.limit and count>=args.limit: break
        db.close(); result={'hashed':count}
    else: result=status(args.index)
    print(json.dumps(result,ensure_ascii=False),flush=True)
