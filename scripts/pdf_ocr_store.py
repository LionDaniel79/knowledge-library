"""Book-ordered OCR selection and single-writer evidence validation."""
from pathlib import Path
import hashlib
from pdf_library import signature

ELIGIBLE = ('needs_ocr','partial_ocr','ocr_review')

def is_resource_error(error):
    return isinstance(error,MemoryError) or (isinstance(error,OSError) and getattr(error,'winerror',None) in (8,14,1450,1455))


def pending_pages(db, retry_failed=False, priority='book', should_stop=None):
    if priority not in ('book','identity-first'):raise ValueError('Unknown OCR priority')
    should_stop=should_stop or (lambda:False)
    if should_stop():return
    methods = ['needs_ocr'] + (['ocr_empty','ocr_error'] if retry_failed else [])
    marks = ','.join('?' for _ in methods)
    # The covering (document_id, method) index eliminates already processed
    # books before seeking their edge/body ranges on the external disk.
    books = db.execute(f"SELECT id,path,root,signature,page_count FROM documents d WHERE processing_scope='full' AND status IN ('needs_ocr','partial_ocr','ocr_review') AND indexed_pages>=page_count AND EXISTS(SELECT 1 FROM pages p WHERE p.document_id=d.id AND p.method IN ({marks})) ORDER BY id",methods).fetchall()
    initialized=set()
    # Global passes: every book's edges precede even the first book's body.
    for phase in (('edges','body') if priority=='identity-first' else ('all',)):
        for book in books:
            if should_stop():return
            edge_end=max(12,book['page_count']-8)
            # Separate bounded ranges make SQLite seek directly to the back pages.
            # A single OR predicate can scan the entire body before reaching them.
            ranges=((0,min(12,book['page_count'])),(edge_end,book['page_count'])) if phase=='edges' else ((12,edge_end),) if phase=='body' else ((0,book['page_count']),)
            for lower,upper in ranges:
                last=lower
                while last<upper:
                    if should_stop():return
                    pages = db.execute(f'SELECT id AS page_id,page_number,method,text<>\'\' AS had_text FROM pages WHERE document_id=? AND page_number>? AND page_number<=? AND method IN ({marks}) ORDER BY page_number LIMIT 100', [book['id'],last,upper,*methods]).fetchall()
                    if not pages:break
                    if book['id'] not in initialized:
                        # Reconcile once per book, including after a resumed priority pass.
                        db.execute('UPDATE documents SET text_pages=(SELECT count(*) FROM pages WHERE document_id=? AND text<>\'\') WHERE id=? AND signature=?', (book['id'],book['id'],book['signature']))
                        db.commit();initialized.add(book['id'])
                    for page in pages:
                        last=page['page_number']
                        yield {**dict(book),**dict(page)}


def source_status(row):
    try:
        actual=Path(row['path']).resolve(strict=True)
        root=Path(row['root']).resolve(strict=True)
        if not actual.is_relative_to(root) or actual.suffix.lower()!='.pdf' or not actual.is_file():return 'changed'
        return None if signature(actual.stat())==row['signature'] else 'changed'
    except FileNotFoundError:return 'missing'
    except OSError as error:
        if is_resource_error(error):raise
        return 'changed'


def mark_source_stale(db,row,status):
    db.execute("UPDATE documents SET status=? WHERE id=? AND signature=? AND processing_scope='full'", (status,row['id'],row['signature']))
    db.commit()


def current_page(db,row):
    current=db.execute('SELECT d.signature,d.processing_scope,d.status,p.method,p.text<>\'\' AS had_text FROM pages p JOIN documents d ON d.id=p.document_id WHERE p.id=? AND d.id=? AND p.page_number=?', (row['page_id'],row['id'],row['page_number'])).fetchone()
    return current if current and current['signature']==row['signature'] and current['processing_scope']=='full' and current['status'] in ELIGIBLE and current['method']==row['method'] else None


def save_page(db,row,image,result=None,error=None):
    status=source_status(row)
    if status:
        mark_source_stale(db,row,status)
        return 'stale'
    text='' if error is not None else str(result.get('text','')).replace('\x00','').strip()
    if len(text)>100000:raise ValueError('OCR 페이지 결과 길이 초과')
    try:
        db.execute('BEGIN IMMEDIATE')
        current=current_page(db,row)
        if not current:
            db.rollback();return 'stale'
        if error is not None:
            db.execute("UPDATE pages SET method='ocr_error' WHERE id=?",(row['page_id'],))
            db.execute('INSERT OR REPLACE INTO page_ocr(document_id,page_number,signature,engine,language,text_hash,image_hash,error) VALUES(?,?,?,?,?,?,?,?)', (row['id'],row['page_number'],row['signature'],'unknown','unknown','','',str(error)[:300]))
            outcome='errors'
        else:
            db.execute('UPDATE pages SET text=?,method=? WHERE id=?', (text,'ocr_unverified' if text else 'ocr_empty',row['page_id']))
            db.execute('INSERT OR REPLACE INTO page_ocr(document_id,page_number,signature,engine,language,text_hash,image_hash,width,height) VALUES(?,?,?,?,?,?,?,?,?)', (row['id'],row['page_number'],row['signature'],str(result.get('engine','unknown')),str(result.get('language','unknown')),hashlib.sha256(text.encode()).hexdigest(),hashlib.sha256(image['png']).hexdigest(),image['width'],image['height']))
            db.execute("UPDATE documents SET text_pages=max(0,text_pages+?),status=CASE WHEN EXISTS(SELECT 1 FROM pages WHERE document_id=? AND method IN ('needs_ocr','ocr_error')) THEN 'partial_ocr' ELSE 'ocr_review' END,updated_at=datetime('now') WHERE id=?", (int(bool(text))-int(current['had_text']),row['id'],row['id']))
            outcome='text' if text else 'empty'
        db.commit()
        return outcome
    except BaseException:
        db.rollback();raise
