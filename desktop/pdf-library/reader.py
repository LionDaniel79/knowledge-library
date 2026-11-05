"""Offline search and original-page rendering. No network or index initialization."""
import base64
import json
import os
import re
import sqlite3
import time
from contextlib import contextmanager,closing
from pathlib import Path


@contextmanager
def source(path):
    path = Path(path).resolve(strict=True)
    # The legacy index is a quiescent snapshot. Never create WAL/SHM on its drive.
    def stamp():
        if any(Path(str(path) + suffix).exists() for suffix in ('-wal', '-journal')):
            raise ValueError('색인을 사용 중입니다. 닫힌 스냅샷을 선택하세요.')
        st = path.stat()
        return st.st_size, st.st_mtime_ns
    before = stamp()
    db = sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)
    db.row_factory = sqlite3.Row
    try:
        db.execute('PRAGMA query_only=ON')
        yield db
        if before != stamp():
            raise ValueError('조회 중 색인이 변경되었습니다. 다시 조회하세요.')
    finally:
        db.close()


def terms(query):
    tokens = re.findall(r'"([^"]+)"|([^\s"]+)', query.replace('“', '"').replace('”', '"'))
    normalized = query.replace('“', '"').replace('”', '"').strip()
    if len(query) > 200 or not re.fullmatch(r'(?:\"[^"]+\"|[^\s"]+)(?:\s+(?:\"[^"]+\"|[^\s"]+))*', normalized):
        raise ValueError('단어는 띄어 쓰고 어구는 큰따옴표로 닫으세요.')
    result = [a or b for a,b in tokens]
    if len(result) > 8 or any(len(t.strip()) < 2 for t in result):
        raise ValueError('두 글자 이상인 단어나 어구를 8개까지 입력하세요.')
    return result


def safe_location(path, root, size=None, mtime=None):
    try:
        p = Path(path)
        physical = p.resolve(strict=True)
        if physical!=p.absolute() or Path(root).resolve(strict=True)!=Path(root).absolute():
            return False
        if not physical.is_relative_to(Path(root).resolve(strict=True)) or physical.suffix.lower() != '.pdf':
            return False
        st = physical.stat()
        return physical.is_file() and (size is None or (st.st_size, str(st.st_mtime_ns)) == (size, str(mtime)))
    except (OSError, ValueError):
        return False


def locations(db, row, side):
    if safe_location(row['path'],row['root'],row['bytes'],row['mtime_ns']):
        return row['path']
    options = []
    if side and Path(side).is_file():
        with closing(sqlite3.connect(Path(side).resolve().as_uri()+'?mode=ro',uri=True,timeout=1)) as sc:
            options.extend(tuple(r) for r in sc.execute(
                "select l.path,l.root,l.size,l.mtime from location l join web_registration w using(path) where w.legacy_id=? and l.state='verified' order by l.path", (row['id'],)))
    return next((p for p,r,b,m in options if safe_location(p,r,b,m)), None)


def search(index, query, kind='', document='', seconds=10, side=None):
    clauses = terms(query)
    if seconds <= 0:
        raise sqlite3.OperationalError('검색 제한 시간 초과')
    args = []
    conditions = ["d.status not in ('error','locked','changed')"]
    with source(index) as db:
        deadline = time.monotonic() + seconds
        db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 500)
        # Document restriction comes first, avoiding a collection-wide phrase rank/sort.
        tables = 'documents d cross join pages p on p.document_id=d.id'
        long = [t for t in clauses if len(t) >= 3]
        if document:
            conditions.append('d.id=?')
            args.append(document)
        elif long:
            tables = 'pages_fts cross join pages p on p.id=pages_fts.rowid join documents d on d.id=p.document_id'
            conditions.append('pages_fts match ?')
            args.append(' AND '.join('"'+t.replace('"','""')+'"' for t in long))
        if kind:
            conditions.append('d.material_kind=?')
            args.append(kind)
        # Match all terms on the same page, including short Korean terms.
        db.create_function('contains_term',2,lambda s,t:int(t.casefold() in s.casefold()))
        for t in clauses:
            conditions.append('contains_term(p.text,?)')
            args.append(t)
        sql = 'select d.id,d.title,d.path,d.root,d.bytes,d.mtime_ns,d.material_kind,d.status,p.page_number,p.method,p.text from '+tables+' where '+' and '.join(conditions)+' limit 40'
        hits = []
        for row in db.execute(sql,args):
            match = re.search('|'.join(map(re.escape,clauses)),row['text'],re.I)
            start = max(0,match.start()-55) if match else 0
            hits.append(dict(id=row['id'],title=row['title'],kind=row['material_kind'],page=row['page_number'],method=row['method'],status=row['status'],available=bool(locations(db,row,side)),snippet=row['text'][start:start+240]))
        return dict(hits=hits,terms=clauses)


def render(index, document, page, side=None):
    import pypdfium2 as pdfium
    import io
    with source(index) as db:
        row=db.execute('select * from documents where id=?',(document,)).fetchone()
        path=locations(db,row,side) if row else None
        if not path:
            raise ValueError('파일 위치를 확인할 수 없습니다. 외장하드와 이동 검산 상태를 확인하세요.')
        with pdfium.PdfDocument(path) as pdf:
            if not 1 <= page <= len(pdf):
                raise ValueError('PDF 쪽 범위를 벗어났습니다.')
            pg=pdf[page-1]
            try:
                bitmap=pg.render(scale=min(2,1600/max(pg.get_size())))
                try:
                    with bitmap.to_pil() as img:
                        stream=io.BytesIO()
                        img.save(stream,format='PNG')
                finally:
                    bitmap.close()
            finally:
                pg.close()
            return dict(page=page,total=len(pdf),image=base64.b64encode(stream.getvalue()).decode())
