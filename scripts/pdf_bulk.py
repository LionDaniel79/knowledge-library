"""Read-only source access for the UI import worker. JSON-lines RPC; no shell paths."""
import hashlib
import json
import os
from pathlib import Path
import sys
import uuid
from pdf_scope import classify, SCOPE_VERSION
from pdf_library import connect, signature, index_document


def is_link(path):
    return path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction())


def inventory(root):
    root = Path(root).resolve(strict=True)
    if not root.is_dir():
        raise ValueError('폴더를 찾을 수 없습니다.')
    def failed(_):
        raise ValueError('읽을 수 없는 하위 폴더가 있습니다. 폴더 권한을 확인하세요.')
    for parent, dirs, files in os.walk(root, followlinks=False, onerror=failed):
        dirs[:] = sorted(d for d in dirs if not is_link(Path(parent, d)))
        for name in sorted(files):
            path = Path(parent, name)
            if not name.lower().endswith('.pdf') or is_link(path):
                continue
            path = path.resolve(strict=True)
            if not path.is_relative_to(root):
                continue
            st = path.stat()
            relative = str(path.relative_to(root))
            scope, kind, reason = classify(relative, path.stem)
            yield dict(id=str(uuid.uuid5(uuid.NAMESPACE_URL, os.path.normcase(str(path)))),
                       root=str(root), path=str(path), relative_path=relative, title=path.stem,
                       author='', page_count=None, bytes=st.st_size, mtime_ns=str(st.st_mtime_ns),
                       processing_scope=scope, material_kind=kind, scope_reason=reason, scope_version=SCOPE_VERSION)


def checked_path(root, doc):
    raw = Path(doc['path'])
    root = Path(root).resolve(strict=True)
    if is_link(raw):
        raise ValueError('링크 파일은 등록하지 않습니다.')
    path = raw.resolve(strict=True)
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError('지정한 폴더 밖의 파일입니다.')
    st = path.stat()
    if st.st_size != doc['bytes'] or str(st.st_mtime_ns) != doc['mtime_ns']:
        raise ValueError('조사 후 파일이 변경되었습니다. 폴더를 다시 조사하세요.')
    return path


def file_hash(root, doc):
    path = checked_path(root, doc)
    before = path.stat()
    with path.open('rb') as f:
        digest = hashlib.file_digest(f, 'sha256').hexdigest()
    checked_path(root, doc)
    if path.stat().st_ctime_ns != before.st_ctime_ns:
        raise ValueError('원본이 변경되었습니다.')
    return digest


def prepare(root, index, doc, digest):
    path = checked_path(root, doc)
    db = connect(index)
    try:
        previous = db.execute('SELECT signature FROM documents WHERE id=?', (doc['id'],)).fetchone()
        sig = signature(path.stat())
        if previous and previous['signature'] != sig:
            raise ValueError('기존 색인 원본이 변경되었습니다. 자동 교체하지 않습니다.')
        db.execute('''INSERT INTO documents(id,root,path,relative_path,title,author,bytes,mtime_ns,signature,sha256,processing_scope,material_kind,scope_reason,scope_version,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET sha256=excluded.sha256''',
            (doc['id'], str(root), str(path), doc['relative_path'], doc['title'], '', doc['bytes'], doc['mtime_ns'], sig, digest,
             doc['processing_scope'], doc['material_kind'], doc['scope_reason'], doc['scope_version']))
        db.commit()
    finally:
        db.close()
    return True


def identity(root, index, doc):
    import pypdfium2 as pdfium
    path = checked_path(root, doc)
    pages = []
    with pdfium.PdfDocument(str(path)) as pdf:
        count = len(pdf)
        metadata = pdf.get_metadata_dict()
        for n in sorted(set(range(min(12, count))) | set(range(max(0, count-8), count))):
            page = pdf[n]
            try:
                textpage = page.get_textpage()
                try:
                    text = textpage.get_text_bounded().replace('\x00', '').strip()[:100000]
                finally:
                    textpage.close()
            finally:
                page.close()
            pages.append(dict(pageNumber=n+1, text=text, method='text' if text else 'needs_ocr'))
    checked_path(root, doc)
    return dict(pageCount=count, author=metadata.get('Author', '')[:300], pages=pages)


def handle(action, root, index, p):
    if action == 'hash':
        return file_hash(root, p['document'])
    if action == 'prepare':
        return prepare(root, index, p['document'], p['hash'])
    if action == 'identity':
        return identity(root, index, p['document'])
    if action == 'index':
        doc = p['document']
        checked_path(root, doc)
        index_document(index, doc['id'], 50)
        db = connect(index)
        try:
            row = db.execute('SELECT status,error,indexed_pages,page_count FROM documents WHERE id=?', (doc['id'],)).fetchone()
            return dict(row)
        finally:
            db.close()
    raise ValueError('지원하지 않는 작업입니다.')


def main():
    # Environment owned by the authenticated local worker, never browser-supplied command text.
    root, index = os.environ['LIBRARY_IMPORT_ROOT'], os.environ['LIBRARY_PDF_INDEX']
    for line in sys.stdin:
        try:
            p = json.loads(line)
            if p['action'] == 'inventory':
                for doc in inventory(root):
                    print(json.dumps({'event': 'document', 'document': doc}, ensure_ascii=False), flush=True)
                result = True
            else:
                result = handle(p['action'], root, index, p)
            print(json.dumps({'result': result}, ensure_ascii=False), flush=True)
        except Exception as error:
            # Do not leak platform exception text or potentially sensitive paths through the API.
            safe = str(error) if isinstance(error, ValueError) else '파일 처리 실패. PDF 손상·암호·폴더 권한을 확인하세요.'
            print(json.dumps({'error': safe[:200]}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
