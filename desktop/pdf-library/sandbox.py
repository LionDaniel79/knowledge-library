"""Bounded private copy for OCR inspection. Only this application can create it."""
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
from reader import locations,source
from registry import exclusive

APP_ID=843027


def sample_db(directory,index):
    directory=Path(directory).resolve()
    directory.mkdir(parents=True,exist_ok=True)
    dest=directory/'ocr-inspection.sqlite'
    if dest.resolve()==Path(index).resolve() or dest.is_symlink():
        raise ValueError('원본과 분리된 검수 사본이 필요합니다.')
    if dest.exists():
        if dest.stat().st_nlink!=1:raise ValueError('공유 파일은 사용할 수 없습니다.')
        with source(dest) as check:
            if check.execute('pragma application_id').fetchone()[0]!=APP_ID:
                raise ValueError('검수 전용 사본이 아닙니다.')
    db=sqlite3.connect(dest)
    db.row_factory=sqlite3.Row
    if not db.execute('pragma application_id').fetchone()[0]:
        db.executescript("""
        begin;
        create table sample(document_id text,page_number integer,signature text,old_method text,
            old_text text,state text,candidate text,engine text,error text,primary key(document_id,page_number,signature));
        pragma application_id=843027;
        commit;""")
    return db


def candidate(path,page):
    sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
    import pypdfium2 as pdfium
    from pdf_ocr_pipeline import CachedRenderer
    from pdf_ocr_languages import AdaptiveWindowsOcr
    with pdfium.PdfDocument(path) as pdf:
        pg=pdf[page-1]
        try:
            textpage=pg.get_textpage()
            try:text=textpage.get_text_bounded().strip()
            finally:textpage.close()
        finally:pg.close()
    if text:return text,'PDFium'
    renderer=CachedRenderer()
    try:image=renderer.render({'path':path,'page_number':page})
    finally:renderer.close()
    engine=AdaptiveWindowsOcr()
    try:
        result=engine.recognize_png(image['png'])
        return result['text'],result.get('language','Windows OCR')
    finally:engine.close()


def process_one(index,directory,document,recognize=candidate):
    if not document:raise ValueError('검수할 문서 ID를 입력하세요.')
    with exclusive(directory,'ocr'),source(index) as src,closing(sample_db(directory,index)) as db:
        d=src.execute('select * from documents where id=?',(document,)).fetchone()
        if not d:raise ValueError('문서를 찾을 수 없습니다.')
        path=locations(src,d,Path(directory)/'desktop-registry-v2.sqlite')
        if not path:raise ValueError('검산된 파일 위치가 필요합니다.')
        stat=Path(path).stat()
        signature=str(d['bytes'])+':'+str(d['mtime_ns'])
        for row in src.execute("select page_number,method,text from pages where document_id=? and method in ('needs_ocr','ocr_error') order by page_number limit 5",(document,)):
            db.execute("insert or ignore into sample values(?,?,?,?,?,'pending',null,null,null)",(document,row['page_number'],signature,row['method'],row['text']))
        db.commit()
        row=db.execute("select * from sample where document_id=? and signature=? and state in ('pending','error') order by case state when 'pending' then 0 else 1 end,page_number limit 1",(document,signature)).fetchone()
        if row:
            page=row['page_number']
            try:
                text,engine=recognize(path,page)
                now=Path(path).stat()
                if (now.st_size,now.st_mtime_ns)!=(stat.st_size,stat.st_mtime_ns):raise ValueError('검수 중 원본이 변경되었습니다.')
                db.execute("update sample set state='review',candidate=?,engine=?,error=null where document_id=? and page_number=? and signature=?",(text,engine,document,page,signature))
            except Exception as e:
                db.execute("update sample set state='error',error=? where document_id=? and page_number=? and signature=?",(str(e)[:300],document,page,signature))
            db.commit()
        counts=dict(db.execute('select state,count(*) from sample where document_id=? and signature=? group by state',(document,signature)))
        return dict(document=document,page=row['page_number'] if row else None,counts=counts,
                    candidates=[dict(r) for r in db.execute('select page_number,state,engine,substr(candidate,1,500) as preview,error from sample where document_id=? and signature=? order by page_number',(document,signature))])
