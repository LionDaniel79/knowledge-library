"""Standalone PDF library. Original PDFs and the optional legacy index are read-only.

Every durable mutation belongs to management-v1.sqlite in a separate private
directory. Public functions accept JSON-compatible arguments and return JSON
objects for the short-lived desktop worker; no listener/server is started.
"""
import base64
import hashlib
import http.client
import io
import json
import os
import re
import sqlite3
import ssl
import sys
import time
import unicodedata
import uuid
from collections import Counter, defaultdict
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path, PureWindowsPath
from urllib.parse import urlsplit

from reader import source, terms
from registry import exclusive as _legacy_exclusive

DB_NAME = 'management-v1.sqlite'
APP_ID = 843028
ROOTS = {'기독도서': 'christian', '일반도서': 'general'}
REGISTRATIONS = """
create table if not exists registrations(id text primary key,resource_id text not null references resources(id),
 legacy_document_id text unique references aliases(document_id),title text not null default '',
 book_id text,server_document_id text,book_version integer,web_state text,last_synced text);
create index if not exists registrations_resource on registrations(resource_id);
create trigger if not exists resources_web_au after update of book_id,server_document_id,book_version,web_state,last_synced on resources begin
 update registrations set book_id=new.book_id,server_document_id=new.server_document_id,book_version=new.book_version,
 web_state=new.web_state,last_synced=new.last_synced where id=new.id and resource_id=new.id;
end;
"""
SCHEMA = """
create table settings(key text primary key,value text not null);
create table resources(id text primary key,sha256 text unique not null,title text not null,
 kind text not null,total_pages integer not null default 0,error text,book_id text,
 server_document_id text,book_version integer,web_state text,last_synced text,
 author text not null default '',publisher text not null default '',isbn text not null default '',metadata_checked integer not null default 0);
create index resources_title on resources(title,id);
create table aliases(document_id text primary key,resource_id text not null references resources(id));
create index aliases_resource on aliases(resource_id);
create table scans(id text primary key,root text not null,volume text,state text not null,
 files integer not null default 0,hashed integer not null default 0,started_at text not null,finished_at text);
create table locations(path text primary key,root text not null,resource_id text not null references resources(id),
 size integer not null,mtime text not null,ctime text not null,inode text not null,volume text not null,
 state text not null,run text not null references scans(id),checked_at text not null,
 legacy_document_id text references aliases(document_id),legacy_evidence text not null default 'schema2');
create index locations_resource on locations(resource_id,state);
create table pages(id integer primary key,resource_id text not null references resources(id),
 page_number integer not null,text text not null,method text not null,unique(resource_id,page_number));
create virtual table pages_fts using fts5(text,content='pages',content_rowid='id',tokenize='trigram');
create trigger pages_ai after insert on pages begin insert into pages_fts(rowid,text) values(new.id,new.text); end;
create trigger pages_ad after delete on pages begin insert into pages_fts(pages_fts,rowid,text) values('delete',old.id,old.text); end;
create trigger pages_au after update on pages begin
 insert into pages_fts(pages_fts,rowid,text) values('delete',old.id,old.text);
 insert into pages_fts(rowid,text) values(new.id,new.text); end;
create table queue(resource_id text not null references resources(id),page_number integer not null,
 state text not null default 'pending',attempts integer not null default 0,error text,
 updated_at text not null,primary key(resource_id,page_number));
create index queue_state on queue(state,updated_at,resource_id,page_number);
create table outbox(request_id text primary key,payload text not null,state text not null,
 created_at text not null,attempts integer not null default 0,error text,response text);
create index outbox_state on outbox(state);
create table outbox_items(request_id text references outbox(request_id),resource_id text not null,
 fingerprint text not null,primary key(request_id,resource_id));
create table web_ack(resource_id text primary key,fingerprint text not null);
"""


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def valid_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value.lower()
    except (ValueError, AttributeError):
        return False


def _plain_directory(directory):
    directory = Path(directory).absolute()
    for path in (directory, *directory.parents):
        if path.exists():
            require(not path.is_symlink() and not getattr(path.lstat(), 'st_file_attributes', 0) & 1024,
                    '연결된 경로 대신 실제 전용 폴더를 선택하세요.')
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def database(directory):
    """Only open our fixed-name, application-stamped DB; never initialize another DB."""
    directory = _plain_directory(directory)
    with exclusive(directory, 'management-database-open'):
        return _database_open(directory)


@contextmanager
def exclusive(directory, name):
    directory = _plain_directory(directory)
    lock = directory / (name + '.lock')
    if lock.exists():
        require(not lock.is_symlink() and lock.stat().st_nlink == 1 and not getattr(lock.lstat(), 'st_file_attributes', 0) & 1024,
                '공유 잠금 파일은 사용할 수 없습니다.')
    with _legacy_exclusive(directory, name):
        yield


def _database_open(directory):
    path = directory / DB_NAME
    exists = path.exists()
    if exists:
        require(not path.is_symlink() and path.stat().st_nlink == 1, '공유 DB는 사용할 수 없습니다.')
        with path.open('rb') as handle:
            header = handle.read(72)
        require(header[:16] == b'SQLite format 3\0' and int.from_bytes(header[68:72], 'big') == APP_ID,
                '관리 전용 DB가 아닙니다.')
    for suffix in ('-journal', '-wal', '-shm'):
        side = Path(str(path) + suffix)
        if side.exists():
            require(not side.is_symlink() and side.stat().st_nlink == 1, '관리 DB 보조 파일이 안전하지 않습니다.')
    db = sqlite3.connect(path, timeout=5)
    db.row_factory = sqlite3.Row
    try:
        db.execute('pragma foreign_keys=on')
        db.execute('pragma synchronous=full')
        if not exists:
            db.executescript('begin immediate;' + SCHEMA + REGISTRATIONS + f'pragma application_id={APP_ID};pragma user_version=3;commit;')
        version = db.execute('pragma user_version').fetchone()[0]
        require(version in (1, 2, 3), '관리 DB 버전을 확인하세요.')
        if version == 1:
            db.execute('begin immediate')
            columns = {r[1] for r in db.execute('pragma table_info(resources)')}
            for name, definition in (('author', "text not null default ''"), ('publisher', "text not null default ''"), ('isbn', "text not null default ''"), ('metadata_checked', 'integer not null default 0')):
                if name not in columns:
                    db.execute('alter table resources add column ' + name + ' ' + definition)
            db.execute('pragma user_version=2')
            db.commit()
            version = 2
        if version == 2:
            db.execute('begin immediate')
            columns = {r[1] for r in db.execute('pragma table_info(locations)')}
            if 'legacy_document_id' not in columns:
                db.execute('alter table locations add column legacy_document_id text references aliases(document_id)')
            if 'legacy_evidence' not in columns:
                db.execute("alter table locations add column legacy_evidence text not null default 'schema2'")
            # executescript would commit an in-progress transaction. Execute
            # these complete statements individually to retain atomic migration.
            script = ''
            for line in REGISTRATIONS.splitlines(True):
                script += line
                if sqlite3.complete_statement(script):
                    db.execute(script)
                    script = ''
            for resource in db.execute('select * from resources').fetchall():
                _ensure_registrations(db, resource['id'], preserve_default=True)
            db.execute('pragma user_version=3')
            db.commit()
        return db
    except BaseException:
        db.close()
        raise


def _setting(db, key, default=None):
    row = db.execute('select value from settings where key=?', (key,)).fetchone()
    return row[0] if row else default


def _set(db, key, value):
    db.execute('insert into settings values(?,?) on conflict(key) do update set value=excluded.value', (key, str(value)))


def _used_no_legacy_binding(db, resource):
    for row in db.execute("select o.payload from outbox o join outbox_items i using(request_id) where i.resource_id=? and (o.attempts>0 or o.state='applied')", (resource,)):
        if any(item['resourceId'] == resource and not item.get('legacyDocumentId') for item in json.loads(row[0])['items']):
            return True
    return False


def _protected_default(db, resource):
    row = db.execute('select legacy_document_id,book_id from registrations where id=? and resource_id=?', (resource, resource)).fetchone()
    return bool(row and row['legacy_document_id'] is None and (row['book_id'] or _used_no_legacy_binding(db, resource)))


def _ensure_registrations(db, resource, preserve_default=False, titles=None):
    """Book identities are independent; pages and OCR stay content-addressed."""
    row = db.execute('select * from resources where id=?', (resource,)).fetchone()
    ids = [r[0] for r in db.execute('select document_id from aliases where resource_id=? order by document_id', (resource,))]
    default = db.execute('select * from registrations where id=?', (resource,)).fetchone()
    protected = _protected_default(db, resource) or (preserve_default and (_used_no_legacy_binding(db, resource) or (row['book_id'] and row['server_document_id'] not in ids)))
    historical = row['server_document_id'] if row['server_document_id'] in ids else ids[0] if len(ids) == 1 else None
    history = []
    if preserve_default:
        for saved in db.execute('select o.payload from outbox o join outbox_items i using(request_id) where i.resource_id=? order by o.rowid', (resource,)):
            history.extend(item for item in json.loads(saved[0])['items'] if item['resourceId'] == resource)
        previous_ids = {item['legacyDocumentId'] for item in history if item.get('legacyDocumentId') in ids}
        if historical is None and len(previous_ids) == 1:
            historical = next(iter(previous_ids))
    if protected:
        historical = None
    already_bound = historical and db.execute('select 1 from registrations where legacy_document_id=?', (historical,)).fetchone()
    if preserve_default and not default and not already_bound and (not ids or historical or row['book_id'] or history):
        db.execute('insert into registrations(id,resource_id,legacy_document_id,book_id,server_document_id,book_version,web_state,last_synced) values(?,?,?,?,?,?,?,?)',
                   (resource, resource, historical, row['book_id'], row['server_document_id'], row['book_version'], row['web_state'], row['last_synced']))
        default = db.execute('select * from registrations where id=?', (resource,)).fetchone()
        if historical and len(ids) > 1:
            # Schema2 could have queued its formerly unique alias before a
            # second alias was discovered. Preserve only its recorded locations.
            approved = {(location['rootKey'], location['relativePath']) for item in history if item.get('legacyDocumentId') == historical for location in item['locations']}
            for location in db.execute('select path,root from locations where resource_id=? and legacy_document_id is null', (resource,)).fetchall():
                parts = Path(location['path']).relative_to(location['root']).parts
                if len(parts) > 1 and (ROOTS.get(parts[0]), '/'.join(parts[1:])) in approved:
                    db.execute('update locations set legacy_document_id=? where path=?', (historical, location['path']))
    if not protected and default and default['legacy_document_id'] is None and len(ids) == 1 and not default['book_id']:
        # An unused first-user binding may acquire its first legacy identity.
        # Sent/attempted no-legacy bodies are never reinterpreted as another book.
        used = db.execute("select 1 from outbox_items i join outbox o using(request_id) where i.resource_id=? and (o.attempts>0 or o.state='applied') limit 1", (resource,)).fetchone()
        if not used:
            db.execute('update registrations set legacy_document_id=? where id=?', (ids[0], resource))
    for document in ids:
        logical = str(uuid.uuid5(uuid.UUID(resource), 'legacy:' + document.lower()))
        db.execute('insert or ignore into registrations(id,resource_id,legacy_document_id,title) values(?,?,?,?)',
                   (logical, resource, document, (titles or {}).get(document, '')))
        if (titles or {}).get(document):
            db.execute('update registrations set title=? where legacy_document_id=? and resource_id=?', ((titles or {})[document], document, resource))
    if not ids and not default:
        db.execute('insert into registrations(id,resource_id) values(?,?)', (resource, resource))
    if len(ids) == 1 and not protected:
        db.execute("update locations set legacy_document_id=?,legacy_evidence='single' where resource_id=? and legacy_document_id is null", (ids[0], resource))


def _ensure_all_registrations(db):
    for row in db.execute('select id from resources').fetchall():
        _ensure_registrations(db, row['id'])


def _registration_update(db, logical, **values):
    columns = ','.join(key + '=?' for key in values)
    db.execute('update registrations set ' + columns + ' where id=?', (*values.values(), logical))
    registration = db.execute('select resource_id from registrations where id=?', (logical,)).fetchone()
    if registration and registration[0] == logical:
        # Retain schema2 compatibility fields only for its original binding.
        db.execute('update resources set ' + columns + ' where id=?', (*values.values(), logical))


def _signature(path):
    stat = path.stat()
    return (stat.st_size, str(stat.st_mtime_ns), str(stat.st_ctime_ns), str(stat.st_ino), str(stat.st_dev))


def _safe_file(path, root):
    try:
        path, root = Path(path).absolute(), Path(root).absolute()
        if not root.is_dir() or not path.is_file() or path.suffix.lower() != '.pdf' or not path.is_relative_to(root):
            return False
        for part in (path, *path.parents):
            if part.is_symlink() or getattr(part.lstat(), 'st_file_attributes', 0) & 1024:
                return False
            if part == root:
                break
        return path.resolve(strict=True) == path and root.resolve(strict=True) == root
    except (OSError, ValueError):
        return False


def _available(row):
    try:
        return row['state'] == 'verified' and _safe_file(row['path'], row['root']) and _signature(Path(row['path'])) == tuple(row[k] for k in ('size', 'mtime', 'ctime', 'inode', 'volume'))
    except (OSError, ValueError):
        return False


def _location(db, resource):
    return next((r for r in db.execute("select * from locations where resource_id=? and state='verified' order by path", (resource,)) if _available(r)), None)


def _walk(root, stop):
    def fail(error):
        raise error
    for parent, dirs, files in os.walk(root, onerror=fail):
        if stop():
            raise InterruptedError('스캔 중단')
        for name in dirs + files:
            path = Path(parent, name)
            require(not path.is_symlink() and not getattr(path.lstat(), 'st_file_attributes', 0) & 1024,
                    '연결 경로가 있어 전체 확인을 중단했습니다.')
        for name in sorted(files):
            if name.lower().endswith('.pdf'):
                yield Path(parent, name)


def _hash(path, stop):
    signature = _signature(path)
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        while block := handle.read(1024 * 1024):
            if stop():
                raise InterruptedError('파일 확인 중단')
            digest.update(block)
    require(signature == _signature(path), '확인 중 PDF가 변경되었습니다.')
    return digest.hexdigest()


def _inspect(path, bibliography=None):
    import pypdfium2 as pdfium
    with pdfium.PdfDocument(str(path)) as pdf:
        count = len(pdf)
        require(0 < count <= 100000, 'PDF 쪽 수를 확인할 수 없습니다.')
        try:
            metadata = pdf.get_metadata_dict()
        except Exception:
            metadata = {}
        if bibliography is not None:
            evidence = [str(metadata.get(k) or '') for k in ('Subject', 'Keywords')]
            try:
                publisher = pdf.get_metadata_value('Publisher')
                isbn = pdf.get_metadata_value('ISBN')
            except Exception:
                publisher, isbn = '', ''
            evidence.append('ISBN ' + isbn if isbn else '')
            for number in range(min(2, count)):
                try:
                    page = pdf[number]
                    try:
                        textpage = page.get_textpage()
                        try:
                            evidence.append(textpage.get_text_bounded()[:100000])
                        finally:
                            textpage.close()
                    finally:
                        page.close()
                except Exception:
                    # Bibliography is optional. A damaged text layer must not
                    # block rendering/OCR of the actual PDF pages.
                    continue
            bibliography.update(author=_metadata_text(metadata.get('Author')), publisher=_metadata_text(publisher),
                                isbn=discover_isbn('\n'.join(evidence)))
        return _title(metadata.get('Title') or path.stem), count


def _metadata_text(value):
    return _title(value) if str(value or '').strip() else ''


def isbn13(value):
    """Same ISBN-10/13 checksums and 978 conversion as src/lib/bibliography.ts."""
    value = re.sub(r'[^0-9X]', '', str(value).upper())
    if re.fullmatch(r'97[89]\d{10}', value) and sum(int(n) * (3 if i % 2 else 1) for i, n in enumerate(value)) % 10 == 0:
        return value
    if re.fullmatch(r'\d{9}[\dX]', value) and sum((10 if n == 'X' else int(n)) * (10 - i) for i, n in enumerate(value)) % 11 == 0:
        base = '978' + value[:9]
        return base + str((-sum(int(n) * (3 if i % 2 else 1) for i, n in enumerate(base))) % 10)
    return ''


def discover_isbn(text):
    """Accept one checksum-valid front-matter candidate, never a reference list."""
    text = unicodedata.normalize('NFKC', text[:200000])
    text = re.sub(r'[‐‑‒–—−]', '-', text)
    if re.search(r'참고\s*(?:문헌|도서)|신간\s*(?:안내|소개)|도서\s*목록|bibliograph|references|other books|also available', text, re.I):
        return ''
    found = set()
    for match in re.finditer(r'(?<![\dA-Z])(?:97[89](?:[\s-]*\d){10}|\d(?:[\s-]*\d){8}[\s-]*[\dX])(?![\dX])', text, re.I):
        candidate = isbn13(match[0])
        labelled = re.search(r'ISBN(?:[\s-]*1[03])?\s*[:：]?\s*$', text[max(0, match.start() - 32):match.start()], re.I)
        if candidate and (labelled or len(re.sub(r'[^0-9X]', '', match[0], flags=re.I)) == 13):
            found.add(candidate)
    return next(iter(found)) if len(found) == 1 else ''


def _fill_bibliography(db, resource, metadata):
    db.execute("update resources set author=case when author='' then ? else author end,publisher=case when publisher='' then ? else publisher end,isbn=case when isbn='' then ? else isbn end,metadata_checked=1 where id=?",
               (metadata.get('author', ''), metadata.get('publisher', ''), metadata.get('isbn', ''), resource))


def _title(value):
    value = re.sub(r'[\x00-\x1f\x7f-\x9f]', ' ', str(value)).strip()
    if re.match(r'^(?:[A-Za-z]:[\\/]|\\\\|/)', value):
        value = PureWindowsPath(value).stem
    # The server's JS string bound counts UTF-16 code units.
    return value.encode('utf-16-le', errors='replace')[:600].decode('utf-16-le', errors='ignore') or 'PDF'


def _legacy(index):
    if not index:
        return []
    with source(index) as db:
        return [dict(row) for row in db.execute('select * from documents')]


def _legacy_ready(index, document):
    # Read only the newly bound document. Do not load millions of old page IDs on
    # every incremental scan, or copy any old page body into the management DB.
    with source(index) as db:
        ready = {row[0] for row in db.execute("select page_number from pages where document_id=? and length(trim(text))>0 and method not in ('needs_ocr','ocr_error')", (document,))}
        front = '\n'.join(row[0] for row in db.execute("select substr(text,1,100000) from pages where document_id=? and page_number between 1 and 20 and method not in ('needs_ocr','ocr_error') order by page_number limit 20", (document,)))
        return ready, discover_isbn(front)


def _legacy_metadata(doc):
    try:
        metadata = json.loads(doc.get('metadata') or '{}')
        if not isinstance(metadata, dict):
            metadata = {}
    except (ValueError, TypeError):
        metadata = {}
    return dict(author=_metadata_text(doc.get('author') or metadata.get('Author')),
                publisher=_metadata_text(doc.get('publisher') or metadata.get('Publisher')),
                isbn=isbn13(doc.get('isbn') or metadata.get('ISBN') or ''))


def _kind(path, root):
    names = path.relative_to(root).parts[:-1]
    return 'paper' if '논문' in names else 'periodical' if any(n in ('간행물', '정기간행물') for n in names) else 'book'


def _enqueue(db, resource, total, ready=()):
    for page in range(1, total + 1) if total else (0,):
        if page not in ready:
            db.execute("insert or ignore into queue(resource_id,page_number,state,updated_at) values(?,?,'pending',?)", (resource, page, now()))


def _legacy_hint(path, size, mtime):
    return (Path(path).name.casefold(), size, str(mtime))


def _legacy_location(path, signature, candidates, paths, hints, previous=(), identities=None, evidence=False):
    """Choose a logical book only from independent location evidence."""
    def selected(document, proof):
        return (document, proof) if evidence else document
    previous = [row for row in previous if row['legacy_document_id']
             and (os.path.normcase(row['path']) == os.path.normcase(str(path)) or os.path.normcase(row['path']) not in paths
                  or (identities is not None and identities.get(os.path.normcase(row['path'])) != (row['volume'], row['inode'])))]
    prior = {row['legacy_document_id'] for row in previous if row.get('legacy_evidence') in ('path', 'hint', 'inode')}
    if prior:
        return selected(next(iter(prior)), 'inode') if len(prior) == 1 else selected(None, 'ambiguous')
    exact = {doc['id'] for doc in candidates if os.path.normcase(doc['path']) == os.path.normcase(str(path))
             and doc.get('bytes') == signature[0] and str(doc.get('mtime_ns')) == signature[1]}
    if exact:
        return selected(next(iter(exact)), 'path') if len(exact) == 1 else selected(None, 'ambiguous')
    ids = {doc['id'] for doc in candidates}
    if len(ids) == 1:
        return selected(next(iter(ids)), 'single')
    marker = _legacy_hint(path, signature[0], signature[1])
    if hints[marker] == 1:
        matches = {doc['id'] for doc in candidates if os.path.normcase(doc['path']) not in paths
                   and _legacy_hint(doc['path'], doc.get('bytes'), doc.get('mtime_ns')) == marker}
        if len(matches) == 1:
            return selected(next(iter(matches)), 'hint')
    prior = {row['legacy_document_id'] for row in previous}
    if len(prior) == 1:
        return selected(next(iter(prior)), 'single')
    return selected(None, 'ambiguous')


def scan(root, directory, index=None, stop=lambda: False, progress=lambda n, h: None):
    """Initial full inventory; later stat-based incremental hashing. No source writes."""
    root = Path(root).absolute()
    require(not Path(directory).absolute().is_relative_to(root), '관리 폴더는 PDF 저장소 밖에 두세요.')
    state = _plain_directory(directory)
    with exclusive(state, 'management-scan'), closing(database(state)) as db:
        run = str(uuid.uuid4())
        db.execute("insert into scans(id,root,state,started_at) values(?,?,'scanning',?)", (run, str(root), now()))
        db.commit()
        n = hashed = 0
        try:
            require(root.is_dir() and root.resolve(strict=True) == root, 'PDF 저장소 연결을 확인하세요.')
            for parent in (root, *root.parents):
                require(not parent.is_symlink() and not getattr(parent.lstat(), 'st_file_attributes', 0) & 1024, '실제 PDF 저장소를 선택하세요.')
            volume = str(root.stat().st_dev)
            db.execute('update scans set volume=? where id=?', (volume, run))
            selected_index = index or _setting(db, 'index')
            docs = _legacy(selected_index)
            by_hash = {}
            without_hash = {}
            for doc in docs:
                if doc.get('sha256'):
                    by_hash.setdefault(doc['sha256'].lower(), []).append(doc)
                elif doc.get('status') not in ('error', 'locked', 'changed'):
                    without_hash.setdefault(os.path.normcase(doc['path']), []).append(doc)
            inventory = {path: _signature(path) for path in _walk(root, stop)}
            paths = {os.path.normcase(str(path)) for path in inventory}
            identities = {os.path.normcase(str(path)): (stamp[4], stamp[3]) for path, stamp in inventory.items()}
            hints = Counter(_legacy_hint(path, stamp[0], stamp[1]) for path, stamp in inventory.items())
            prior = defaultdict(list)
            for location in db.execute("select l.*,r.sha256 from locations l join resources r on r.id=l.resource_id where l.state='verified' and l.legacy_document_id is not null"):
                prior[(location['sha256'], location['volume'], location['inode'])].append(dict(location))
            seen = {}
            for path, inventoried in inventory.items():
                if stop():
                    raise InterruptedError('스캔 중단')
                require(_safe_file(path, root), '스캔 중 PDF 경로가 변경되었습니다.')
                signature = _signature(path)
                require(signature == inventoried, '확인 중 PDF가 변경되었습니다.')
                old = db.execute('select l.*,r.sha256 from locations l join resources r on r.id=l.resource_id where path=?', (str(path),)).fetchone()
                if old and signature == tuple(old[k] for k in ('size', 'mtime', 'ctime', 'inode', 'volume')):
                    digest = old['sha256']
                else:
                    digest = _hash(path, stop)
                    hashed += 1
                candidates = by_hash.get(digest, [])
                candidates = candidates + [d for d in without_hash.get(os.path.normcase(str(path)), [])
                                            if d.get('bytes') == signature[0] and str(d.get('mtime_ns')) == signature[1]]
                row = db.execute('select * from resources where sha256=?', (digest,)).fetchone()
                if row:
                    resource = row['id']
                    total = row['total_pages']
                    if not row['metadata_checked']:
                        bibliography = {}
                        try:
                            _inspect(path, bibliography)
                            _fill_bibliography(db, resource, bibliography)
                        except Exception:
                            pass
                else:
                    resource = str(uuid.uuid4())
                    error = None
                    bibliography = {}
                    try:
                        title, total = _inspect(path, bibliography)
                    except Exception:
                        title, total, error = _title(path.stem), 0, 'PDF 열기 실패: 재시도에서 다시 확인하세요.'
                    if candidates:
                        title = _title(candidates[0].get('title') or title)
                    kind = candidates[0].get('material_kind') if candidates else None
                    db.execute('insert into resources(id,sha256,title,kind,total_pages,error) values(?,?,?,?,?,?)',
                               (resource, digest, title, kind if kind in ('book', 'paper', 'periodical', 'review') else _kind(path, root), total, error))
                    if not error:
                        _fill_bibliography(db, resource, bibliography)
                old_ready = set()
                for doc in candidates:
                    if valid_uuid(doc['id']):
                        existing = db.execute('select resource_id from aliases where document_id=?', (doc['id'],)).fetchone()
                        if not existing or existing[0] == resource:
                            new_alias = db.execute('insert or ignore into aliases values(?,?)', (doc['id'], resource)).rowcount
                            legacy_metadata = _legacy_metadata(doc) if len(candidates) == 1 else {}
                            if (not row or new_alias or not row['metadata_checked']) and doc.get('status') not in ('error', 'locked', 'changed'):
                                ready_pages, legacy_isbn = _legacy_ready(selected_index, doc['id'])
                                old_ready.update(ready_pages)
                                if legacy_isbn and not legacy_metadata.get('isbn'):
                                    legacy_metadata['isbn'] = legacy_isbn
                            if legacy_metadata:
                                _fill_bibliography(db, resource, legacy_metadata)
                if not row:
                    _enqueue(db, resource, total, old_ready)
                # Drop only work already covered by legacy OCR; preserve own completed pages.
                for page in old_ready:
                    db.execute("delete from queue where resource_id=? and page_number=? and state in ('pending','error')", (resource, page))
                _ensure_registrations(db, resource, titles={doc['id']: _title(doc.get('title') or path.stem) for doc in candidates})
                allowed = {row[0] for row in db.execute('select document_id from aliases where resource_id=?', (resource,))}
                if _protected_default(db, resource):
                    legacy_document, legacy_evidence = None, 'retained'
                else:
                    legacy_document, legacy_evidence = _legacy_location(path, signature, [doc for doc in candidates if doc['id'] in allowed], paths, hints,
                                                                        prior.get((digest, signature[4], signature[3]), ()), identities, evidence=True)
                require(signature == _signature(path), '확인 중 PDF가 변경되었습니다.')
                db.execute('insert into locations values(?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(path) do update set root=excluded.root,resource_id=excluded.resource_id,size=excluded.size,mtime=excluded.mtime,ctime=excluded.ctime,inode=excluded.inode,volume=excluded.volume,state=excluded.state,run=excluded.run,checked_at=excluded.checked_at,legacy_document_id=excluded.legacy_document_id,legacy_evidence=excluded.legacy_evidence',
                           (str(path), str(root), resource, *signature, 'verified', run, now(), legacy_document, legacy_evidence))
                seen[str(path)] = signature
                n += 1
                db.execute('update scans set files=?,hashed=? where id=?', (n, hashed, run))
                db.commit()
                progress(n, hashed)
            # A failed walk or unplugged drive never authorizes "missing" state.
            final = {str(path): _signature(path) for path in _walk(root, stop)}
            require(final == seen and str(root.stat().st_dev) == volume, '스캔 중 저장소 목록이 변경되었습니다.')
            completed_at = now()
            counts = Counter(Path(path).relative_to(root).parts[0] for path in seen)
            checked_roots = []
            for name, key in ROOTS.items():
                selected = root / name
                available = selected.is_dir() and not selected.is_symlink() and not getattr(selected.lstat(), 'st_file_attributes', 0) & 1024
                entry = dict(rootKey=key, available=bool(available))
                if available:
                    entry['checkedCount'] = counts[name]
                checked_roots.append(entry)
            db.execute("update locations set state='missing' where root=? and run<>?", (str(root), run))
            db.execute("update scans set state='complete',finished_at=? where id=?", (completed_at, run))
            # Historical completion evidence is immutable even if files change
            # or the drive disconnects before HTTPS delivery.
            _set(db, 'scan_web_latest', _canonical(dict(scanId=run, action='complete', completedAt=completed_at, roots=checked_roots)))
            _set(db, 'root', str(root))
            if index:
                _set(db, 'index', str(Path(index).absolute()))
            db.commit()
            return dict(run=run, files=n, hashed=hashed, state='complete')
        except BaseException:
            db.rollback()
            db.execute("update scans set state='incomplete',finished_at=? where id=?", (now(), run))
            db.commit()
            raise


def _resolve(db, document):
    row = db.execute('select id from resources where id=? union select resource_id from aliases where document_id=? union select resource_id from registrations where id=? or server_document_id=?', (document, document, document, document)).fetchone()
    require(row is not None, '문서를 찾을 수 없습니다.')
    return row[0]


def _document_id(db, resource):
    ids = [r[0] for r in db.execute('select document_id from aliases where resource_id=? order by document_id', (resource,))]
    return ids[0] if len(ids) == 1 else resource


def _completed_scan(db):
    value = _setting(db, 'scan_web_latest')
    return json.loads(value) if value else None


def _pending_scan(db):
    value = _completed_scan(db)
    return value if value and _setting(db, 'scan_web_ack') != value['scanId'] else None


def _web_pending_count(db):
    return db.execute("select count(*) from outbox where state='pending'").fetchone()[0] + db.execute("select count(*) from registrations where web_state='version_conflict'").fetchone()[0]


def status(directory, limit=100):
    require(limit is None or (type(limit) is int and 1 <= limit <= 1000), '진행 목록 표시 범위가 올바르지 않습니다.')
    with closing(database(directory)) as db:
        queue = dict.fromkeys(('pending', 'running', 'done', 'error'), 0)
        queue.update(dict(db.execute('select state,count(*) from queue group by state')))
        # Polling progress must not stat tens of thousands of PDFs. These global
        # counts represent the last scan on still-connected volumes; displayed
        # documents and exhaustive audit independently validate actual files.
        copies_by_resource = Counter()
        online = {}
        for row in db.execute("select resource_id,root,volume,count(*) as copies from locations where state='verified' group by resource_id,root,volume"):
            key = (row['root'], row['volume'])
            if key not in online:
                try:
                    online[key] = Path(key[0]).is_dir() and str(Path(key[0]).stat().st_dev) == key[1]
                except OSError:
                    online[key] = False
            if online[key]:
                copies_by_resource[row['resource_id']] += row['copies']
        totals = db.execute('select count(*) as resources,coalesce(sum(total_pages),0) as pages from resources').fetchone()
        documents = []
        for row in db.execute('select * from resources order by title,id' + (' limit ?' if limit else ''), (limit,) if limit else ()):
            counts = dict(db.execute('select state,count(*) from queue where resource_id=? group by state', (row['id'],)))
            copies = sum(_available(r) for r in db.execute('select * from locations where resource_id=?', (row['id'],)))
            errors = [dict(r) for r in db.execute("select page_number as page,error,attempts from queue where resource_id=? and state='error' order by page_number limit 20", (row['id'],))]
            aliases = [r[0] for r in db.execute('select document_id from aliases where resource_id=? order by document_id', (row['id'],))]
            registrations = [dict(value) for value in db.execute('select id,legacy_document_id,book_id,book_version,web_state from registrations where resource_id=? order by id', (row['id'],))]
            unresolved = db.execute("select count(*) from locations where resource_id=? and legacy_document_id is null and state='verified'", (row['id'],)).fetchone()[0] if aliases else 0
            unresolved_books = db.execute("select count(*) from registrations g where g.resource_id=? and g.legacy_document_id is not null and not exists(select 1 from locations l where l.resource_id=g.resource_id and l.legacy_document_id=g.legacy_document_id and l.state='verified')", (row['id'],)).fetchone()[0]
            web_issue = '같은 내용의 기존 도서 중 실제 파일의 연결을 확인하지 못한 도서·사본이 있습니다.' if unresolved or unresolved_books else None
            web_state = registrations[0]['web_state'] if len(registrations) == 1 else row['web_state']
            documents.append(dict(id=_document_id(db, row['id']), resourceId=row['id'], title=row['title'], kind=row['kind'], totalPages=row['total_pages'],
                                  author=row['author'], publisher=row['publisher'], isbn=row['isbn'],
                                  available=bool(copies), copies=copies, queue=counts, errors=errors, error=row['error'], webState=web_state, legacyDocumentIds=aliases, webIssue=web_issue, registrations=registrations, unresolvedCopies=unresolved, unresolvedRegistrations=unresolved_books))
        latest = db.execute('select id,state,files,hashed,started_at,finished_at from scans order by rowid desc limit 1').fetchone()
        active = db.execute("select q.resource_id,q.page_number,r.title from queue q join resources r on r.id=q.resource_id where q.state='running' limit 1").fetchone()
        return dict(resources=totals['resources'], availableCopies=sum(copies_by_resource.values()), queue=queue, paused=_setting(db, 'paused', '0') == '1', engineError=_setting(db, 'engine_error', ''), documents=documents,
                    documentsTruncated=totals['resources'] > len(documents), totalPages=totals['pages'],
                    completedPages=max(0, totals['pages'] - db.execute("select count(*) from queue where page_number>0 and state in ('pending','running','error')").fetchone()[0]),
                    scan=dict(latest) if latest else None, current=dict(active) if active else None,
                    lastCompletedScan=_completed_scan(db), scanPending=_pending_scan(db) is not None,
                    webHeld=db.execute("select count(*) from registrations g where g.web_state in ('excluded','conflict') or (g.legacy_document_id is not null and exists(select 1 from locations l where l.resource_id=g.resource_id and l.state='verified') and not exists(select 1 from locations l where l.resource_id=g.resource_id and l.legacy_document_id=g.legacy_document_id and l.state='verified'))").fetchone()[0],
                    webUnresolvedCopies=db.execute("select count(*) from locations l where l.state='verified' and l.legacy_document_id is null and exists(select 1 from aliases a where a.resource_id=l.resource_id)").fetchone()[0],
                    webPending=_web_pending_count(db))


def pause(directory, paused=True):
    require(type(paused) is bool, '일시정지 값이 올바르지 않습니다.')
    with closing(database(directory)) as db:
        _set(db, 'paused', int(paused))
        if not paused:
            _set(db, 'engine_error', '')
        db.commit()
    return {'paused': paused}


def retry(directory, document=None):
    with closing(database(directory)) as db:
        resource = _resolve(db, document) if document else None
        count = db.execute("update queue set state='pending',error=null,updated_at=? where state='error'" + (' and resource_id=?' if resource else ''),
                           (now(), resource) if resource else (now(),)).rowcount
        db.commit()
    return {'retried': count}


def _engine_failure(error):
    # The default recognizer imports pdf_ocr from the copied script bundle.
    # Inspect its actual exception type without importing another engine or
    # starting a subprocess when callers supply a recognizer for isolated tests.
    engine_error = getattr(sys.modules.get('pdf_ocr'), 'OcrEngineError', None)
    return (isinstance(error, (MemoryError, BrokenPipeError, ImportError))
            or (isinstance(error, OSError) and getattr(error, 'winerror', None) in (8, 14, 1450, 1455))
            or (isinstance(engine_error, type) and isinstance(error, engine_error)))


def ocr_step(directory, index=None, recognize=None, stop=lambda: False):
    """Commit at most one page. Abandoned running pages recover under the OS lock."""
    with exclusive(_plain_directory(directory), 'management-ocr'), closing(database(directory)) as db:
        db.execute("update queue set state='pending' where state='running'")
        db.commit()
        if _setting(db, 'paused', '0') == '1':
            return {'state': 'paused', 'engineError': _setting(db, 'engine_error', '')}
        if stop():
            raise InterruptedError('OCR 중단')
        # Offline resources remain pending; process any other connected resource.
        task = location = None
        availability = {}
        for row in db.execute("select q.*,r.title from queue q join resources r on r.id=q.resource_id where q.state='pending' order by q.updated_at,q.resource_id,q.page_number"):
            if stop():
                raise InterruptedError('OCR 중단')
            if row['resource_id'] not in availability:
                availability[row['resource_id']] = _location(db, row['resource_id'])
            candidate_location = availability[row['resource_id']]
            if candidate_location:
                task, location = row, candidate_location
                break
        if not task:
            pending = db.execute("select count(*) from queue where state='pending'").fetchone()[0]
            return {'state': 'offline' if pending else 'idle'}
        resource, page = task['resource_id'], task['page_number']
        if recognize is None:
            from quality_recognition import candidate
            recognize = lambda path, number: candidate(
                path, number, cache_directory=Path(directory) / 'ocr-layout', content_key=resource)
        document = _document_id(db, resource)
        db.execute("update queue set state='running',attempts=attempts+1,updated_at=? where resource_id=? and page_number=?", (now(), resource, page))
        db.commit()
        try:
            metadata_changed = False
            if page == 0:
                before = tuple(db.execute('select total_pages,author,publisher,isbn from resources where id=?', (resource,)).fetchone())
                bibliography = {}
                title, total = _inspect(Path(location['path']), bibliography)
                require(_available(location), 'OCR 중 파일 위치가 변경되었습니다.')
                db.execute('update resources set total_pages=?,error=null where id=?', (total, resource))
                _fill_bibliography(db, resource, bibliography)
                _enqueue(db, resource, total)
                metadata_changed = before != tuple(db.execute('select total_pages,author,publisher,isbn from resources where id=?', (resource,)).fetchone())
            else:
                text, method = recognize(location['path'], page)
                require(isinstance(text, str) and isinstance(method, str), 'OCR 결과를 확인할 수 없습니다.')
                require(len(text) <= 4000000, 'OCR 쪽 결과가 너무 큽니다.')
                require(_available(location), 'OCR 중 파일이 변경되었습니다. 다시 스캔하세요.')
                if stop():
                    raise InterruptedError('OCR 중단')
                if _setting(db, 'paused', '0') == '1':
                    db.execute("update queue set state='pending',updated_at=? where resource_id=? and page_number=?", (now(), resource, page))
                    db.commit()
                    return dict(state='paused', document=document, page=page)
                db.execute('insert into pages(resource_id,page_number,text,method) values(?,?,?,?) on conflict(resource_id,page_number) do update set text=excluded.text,method=excluded.method', (resource, page, text, method[:200]))
                if page <= 20:
                    candidate_isbn = discover_isbn(text)
                    if candidate_isbn:
                        metadata_changed = db.execute("update resources set isbn=? where id=? and isbn=''", (candidate_isbn, resource)).rowcount > 0
            db.execute("update queue set state='done',error=null,updated_at=? where resource_id=? and page_number=?", (now(), resource, page))
            db.commit()
            return dict(state='done', document=document, title=task['title'], page=page, webMetadataChanged=metadata_changed)
        except InterruptedError:
            db.rollback()
            db.execute("update queue set state='pending',updated_at=? where resource_id=? and page_number=?", (now(), resource, page))
            db.commit()
            raise
        except Exception as error:
            db.rollback()
            if _engine_failure(error):
                message = 'OCR 실행기 오류로 일시정지했습니다 (' + type(error).__name__ + '). 설치·언어·메모리를 확인한 뒤 OCR 계속을 누르세요.'
                db.execute("update queue set state='pending',error=null,updated_at=? where resource_id=? and page_number=?", (now(), resource, page))
                _set(db, 'paused', '1')
                _set(db, 'engine_error', message)
                db.commit()
                return dict(state='paused', document=document, title=task['title'], page=page, engineError=message)
            # Native OCR errors can contain absolute paths; retain a safe class only.
            message = 'OCR 처리 실패 (' + type(error).__name__ + '). 재시도할 수 있습니다.'
            db.execute("update queue set state='error',error=?,updated_at=? where resource_id=? and page_number=?", (message, now(), resource, page))
            db.commit()
            return dict(state='error', document=document, title=task['title'], page=page, error=message)


def _hit(db, row, clauses, document=None):
    text = row['text']
    match = re.search('|'.join(map(re.escape, clauses)), text, re.I)
    start = max(0, match.start() - 55) if match else 0
    return dict(id=document or _document_id(db, row['resource_id']), resourceId=row['resource_id'], title=row['title'], kind=row['kind'], page=row['page_number'],
                method=row['method'], status='ready', available=_location(db, row['resource_id']) is not None, snippet=text[start:start + 240])


def search(directory, query, kind='', document='', index=None, seconds=10):
    clauses = terms(query)
    require(kind in ('', 'book', 'paper', 'periodical', 'review'), '자료 종류가 올바르지 않습니다.')
    if seconds <= 0:
        raise sqlite3.OperationalError('검색 제한 시간 초과')
    deadline = time.monotonic() + min(seconds, 60)
    with closing(database(directory)) as db:
        db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 500)
        resource = _resolve(db, document) if document else None
        db.create_function('contains_term', 2, lambda text, term: int(term.casefold() in text.casefold()))
        tables = 'pages p join resources r on r.id=p.resource_id'
        conditions, args = [], []
        long = [term for term in clauses if len(term) >= 3]
        if long and not document:
            tables = 'pages_fts join pages p on p.id=pages_fts.rowid join resources r on r.id=p.resource_id'
            conditions.append('pages_fts match ?')
            args.append(' AND '.join('"' + term.replace('"', '""') + '"' for term in long))
        if resource:
            conditions.append('r.id=?')
            args.append(resource)
        if kind:
            conditions.append('r.kind=?')
            args.append(kind)
        for term in clauses:
            conditions.append('contains_term(p.text,?)')
            args.append(term)
        rows = db.execute('select p.*,r.title,r.kind from ' + tables + ' where ' + ' and '.join(conditions) + ' limit 40', args)
        hits = []
        for row in rows:
            aliases = [r[0] for r in db.execute('select document_id from aliases where resource_id=? order by document_id', (row['resource_id'],))]
            for identity in ([document] if document else aliases or [row['resource_id']]):
                hits.append(_hit(db, row, clauses, identity))
        used = {(hit['id'], hit['page']) for hit in hits}
        legacy_index = index or _setting(db, 'index')
        if legacy_index and time.monotonic() < deadline:
            with source(legacy_index) as legacy:
                legacy.set_progress_handler(lambda: int(time.monotonic() >= deadline), 500)
                legacy.create_function('contains_term', 2, lambda text, term: int(term.casefold() in text.casefold()))
                allowed = dict(db.execute('select document_id,resource_id from aliases' + (' where resource_id=?' if resource else ''), (resource,) if resource else ()))
                if allowed:
                    # A read-only TEMP table is prohibited by query_only; filter IDs in Python.
                    legacy_conditions, legacy_args = ["d.status not in ('error','locked','changed')"], []
                    legacy_tables = 'pages p join documents d on d.id=p.document_id'
                    if long and not document:
                        legacy_tables = 'pages_fts join pages p on p.id=pages_fts.rowid join documents d on d.id=p.document_id'
                        legacy_conditions.append('pages_fts match ?')
                        legacy_args.append(' AND '.join('"' + term.replace('"', '""') + '"' for term in long))
                    if document and document in allowed:
                        legacy_conditions.append('d.id=?')
                        legacy_args.append(document)
                    for term in clauses:
                        legacy_conditions.append('contains_term(p.text,?)')
                        legacy_args.append(term)
                    for row in legacy.execute('select d.id,d.title as legacy_title,d.material_kind as legacy_kind,p.page_number,p.text,p.method from ' + legacy_tables + ' where ' + ' and '.join(legacy_conditions), legacy_args):
                        rid = allowed.get(row['id'])
                        if not rid or (row['id'], row['page_number']) in used:
                            continue
                        meta = db.execute('select title,kind from resources where id=?', (rid,)).fetchone()
                        legacy_kind = row['legacy_kind'] if row['legacy_kind'] in ('book', 'paper', 'periodical', 'review') else meta['kind']
                        if kind and legacy_kind != kind:
                            continue
                        # Own page is authoritative even if it does not match the query.
                        if db.execute('select 1 from pages where resource_id=? and page_number=?', (rid, row['page_number'])).fetchone():
                            continue
                        entry = dict(row)
                        entry.update(resource_id=rid, title=row['legacy_title'] or meta['title'], kind=legacy_kind)
                        hits.append(_hit(db, entry, clauses, row['id']))
                        used.add((row['id'], row['page_number']))
                        if len(hits) >= 40:
                            break
        return dict(hits=hits[:40], terms=clauses)


def render(directory, document, page, index=None):
    import pypdfium2 as pdfium
    require(type(page) is int, '쪽 번호가 올바르지 않습니다.')
    with closing(database(directory)) as db:
        resource = _resolve(db, document)
        location = _location(db, resource)
        require(location is not None, '파일 위치를 확인할 수 없습니다. 저장소 연결과 스캔을 확인하세요.')
        with pdfium.PdfDocument(location['path']) as pdf:
            require(1 <= page <= len(pdf), 'PDF 쪽 범위를 벗어났습니다.')
            pg = pdf[page - 1]
            try:
                bitmap = pg.render(scale=min(2, 1600 / max(pg.get_size())))
                try:
                    with bitmap.to_pil() as image:
                        stream = io.BytesIO()
                        image.save(stream, format='PNG')
                finally:
                    bitmap.close()
            finally:
                pg.close()
            require(_available(location), '렌더링 중 PDF가 변경되었습니다.')
            return dict(page=page, total=len(pdf), image=base64.b64encode(stream.getvalue()).decode())


def relative_path(value):
    require(isinstance(value, str) and 0 < len(value.encode('utf-16-le')) <= 2000, '상대경로가 올바르지 않습니다.')
    require(not re.search(r'[\\:%<>"|?*\x00-\x1f\x7f-\x9f]', value) and not value.startswith('/') and all(p not in ('', '.', '..') for p in value.split('/')), '안전한 상대경로가 필요합니다.')
    for component in value.split('/'):
        require(component.strip() == component and not component.endswith('.') and not re.fullmatch(r'(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', component, re.I), 'Windows 예약 경로는 등록할 수 없습니다.')
    require(value.lower().endswith('.pdf'), 'PDF 상대경로가 필요합니다.')
    return value


def _canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def _web_snapshot_ready(db):
    root = _setting(db, 'root')
    if not root or not Path(root).is_dir():
        return False
    latest = db.execute('select * from scans where root=? order by rowid desc limit 1', (root,)).fetchone()
    return bool(latest and latest['state'] == 'complete' and str(Path(root).stat().st_dev) == latest['volume']
                and all((Path(root) / name).is_dir() for name in ROOTS))


def _web_items(db, include_recoverable=False):
    root = _setting(db, 'root')
    if not _web_snapshot_ready(db):
        return []
    latest = db.execute('select * from scans where root=? order by rowid desc limit 1', (root,)).fetchone()
    items = []
    for registration in db.execute('select * from registrations order by id'):
        if registration['web_state'] in ('excluded', 'conflict'):
            continue
        if registration['web_state'] == 'version_conflict' and not include_recoverable:
            continue
        row = db.execute('select * from resources where id=?', (registration['resource_id'],)).fetchone()
        if registration['legacy_document_id'] is None and db.execute('select 1 from aliases where resource_id=?', (row['id'],)).fetchone() and not _protected_default(db, row['id']):
            continue
        locations = []
        for location in db.execute("select * from locations where resource_id=? and legacy_document_id is ? and root=? and run=? and state='verified' order by path", (row['id'], registration['legacy_document_id'], root, latest['id'])):
            if not _available(location):
                continue
            parts = Path(location['path']).relative_to(root).parts
            if len(parts) >= 2 and parts[0] in ROOTS:
                try:
                    relative = relative_path('/'.join(parts[1:]))
                except ValueError:
                    continue
                locations.append(dict(rootKey=ROOTS[parts[0]], relativePath=relative))
        if not locations:
            continue
        if len(locations) > 32:
            continue
        item = dict(resourceId=registration['id'], metadata=dict(title=_title(registration['title'] or row['title'])), locations=locations)
        for key in ('author', 'publisher', 'isbn'):
            if row[key]:
                item['metadata'][key] = row[key] if key == 'isbn' else _metadata_text(row[key])
        if row['total_pages']:
            item['metadata']['totalPages'] = row['total_pages']
        if registration['legacy_document_id']:
            item['legacyDocumentId'] = registration['legacy_document_id']
        if registration['book_id']:
            item.update(bookId=registration['book_id'], expectedBookVersion=registration['book_version'])
        items.append(item)
    return items


def prepare_web(directory):
    """Persist immutable batches. Pending resource IDs block concurrent newer deltas."""
    with exclusive(_plain_directory(directory), 'management-web'), closing(database(directory)) as db:
        _ensure_all_registrations(db)
        current_items = _web_items(db)
        current = {item['resourceId']: item for item in current_items}
        if _web_snapshot_ready(db):
            for row in db.execute("select request_id,payload from outbox where state='pending'"):
                old = json.loads(row['payload'])
                if any(current.get(item['resourceId']) != item for item in old['items']):
                    db.execute("update outbox set state='superseded' where request_id=?", (row['request_id'],))
        pending = {r[0] for r in db.execute("select i.resource_id from outbox_items i join outbox o using(request_id) where o.state='pending'")}
        changed = []
        for item in current_items:
            if item['resourceId'] in pending:
                continue
            digest = hashlib.sha256(_canonical(item).encode()).hexdigest()
            ack = db.execute('select fingerprint from web_ack where resource_id=?', (item['resourceId'],)).fetchone()
            if not ack or ack[0] != digest:
                changed.append((item, digest))
        chunks, chunk, byte_count = [], [], 100
        for entry in changed:
            size = len(_canonical(entry[0]).encode('utf-8')) + 1
            if chunk and (len(chunk) == 100 or byte_count + size > 950000):
                chunks.append(chunk)
                chunk, byte_count = [], 100
            chunk.append(entry)
            byte_count += size
        if chunk:
            chunks.append(chunk)
        for chunk in chunks:
            request = dict(requestId=str(uuid.uuid4()), action='upsert', items=[item for item, _ in chunk])
            db.execute("insert into outbox(request_id,payload,state,created_at) values(?,?,'pending',?)", (request['requestId'], _canonical(request), now()))
            db.executemany('insert into outbox_items values(?,?,?)', [(request['requestId'], item['resourceId'], digest) for item, digest in chunk])
        db.commit()
        return _pending(db)


def _pending(db):
    return {'requests': [json.loads(r[0]) for r in db.execute("select payload from outbox where state='pending' order by rowid")]}


def pending_web(directory):
    with closing(database(directory)) as db:
        return _pending(db)


def apply_web_result(directory, request_id, result):
    with exclusive(_plain_directory(directory), 'management-web'), closing(database(directory)) as db:
        row = db.execute('select * from outbox where request_id=?', (request_id,)).fetchone()
        require(row is not None and isinstance(result, dict) and set(result) == {'requestId', 'items'} and result['requestId'] == request_id, '등록 응답 식별자가 올바르지 않습니다.')
        require(isinstance(result['items'], list), '등록 응답 목록이 올바르지 않습니다.')
        payload = json.loads(row['payload'])
        expected = {item['resourceId']: item for item in payload['items']}
        received = {}
        for item in result['items']:
            require(isinstance(item, dict) and set(item) == {'resourceId', 'bookId', 'documentId', 'bookVersion', 'state'}, '등록 응답 항목이 올바르지 않습니다.')
            require(item['resourceId'] in expected and item['resourceId'] not in received and item['state'] in ('registered', 'unchanged', 'excluded', 'conflict'), '등록 응답의 자료 또는 상태를 확인하세요.')
            successful = item['state'] in ('registered', 'unchanged')
            require((valid_uuid(item['bookId']) or (not successful and item['bookId'] is None)) and
                    (valid_uuid(item['documentId']) or (not successful and item['documentId'] is None)) and
                    ((type(item['bookVersion']) is int and 1 <= item['bookVersion'] <= 2147483647) or (not successful and item['bookVersion'] is None)), '등록 응답의 문서 또는 버전을 확인하세요.')
            old = expected[item['resourceId']]
            if old.get('bookId') and item['state'] in ('registered', 'unchanged'):
                require(old['bookId'] == item['bookId'] and item['bookVersion'] >= old['expectedBookVersion'], '등록 응답의 도서 연결이 변경되었습니다.')
            if old.get('legacyDocumentId') and item['state'] in ('registered', 'unchanged'):
                require(old['legacyDocumentId'] == item['documentId'], '기존 문서 연결이 변경되었습니다.')
            received[item['resourceId']] = item
        require(set(received) == set(expected), '등록 응답이 누락되었습니다.')
        if row['state'] == 'applied':
            require(row['response'] == _canonical(result), '완료된 등록 응답이 변경되었습니다.')
            return {'requestId': request_id, 'applied': len(received)}
        for resource, item in received.items():
            previous = db.execute('select book_id,server_document_id from registrations where id=?', (resource,)).fetchone()
            require(previous is not None, '등록 응답의 로컬 도서 연결을 찾을 수 없습니다.')
            retry_key = 'web_cas_retry:' + resource
            if item['state'] == 'conflict':
                # A version race may retry once, but only after an owner-scoped
                # lookup confirms the same existing book/document mapping.
                same_identity = (expected[resource].get('bookId') == previous['book_id'] == item['bookId']
                                 and previous['book_id'] is not None and previous['server_document_id'] == item['documentId']
                                 and previous['server_document_id'] is not None and type(item['bookVersion']) is int
                                 and item['bookVersion'] > expected[resource].get('expectedBookVersion', 2147483647))
                recoverable = same_identity and _setting(db, retry_key, '0') == '0'
                if recoverable:
                    _set(db, retry_key, '1')
                _registration_update(db, resource, web_state='version_conflict' if recoverable else 'conflict', last_synced=now())
                continue
            _registration_update(db, resource, book_id=item['bookId'], server_document_id=item['documentId'], book_version=item['bookVersion'], web_state=item['state'], last_synced=now())
            if item['state'] == 'excluded':
                continue
            _set(db, retry_key, '0')
            # Ack includes server IDs/version so an unchanged scan does not create a second batch.
            acknowledged = dict(expected[resource])
            if item['bookId']:
                acknowledged.update(bookId=item['bookId'], expectedBookVersion=item['bookVersion'])
            digest = hashlib.sha256(_canonical(acknowledged).encode()).hexdigest()
            db.execute('insert into web_ack values(?,?) on conflict(resource_id) do update set fingerprint=excluded.fingerprint', (resource, digest))
        db.execute("update outbox set state='applied',response=?,error=null where request_id=?", (_canonical(result), request_id))
        db.commit()
        return {'requestId': request_id, 'applied': len(received)}


def transport(origin, token):
    require(isinstance(origin, str) and re.fullmatch(r'https://[A-Za-z0-9.-]+(?::[0-9]+)?', origin) is not None, 'HTTPS 웹 주소가 필요합니다.')
    require(isinstance(token, str) and re.fullmatch(r'klw_[A-Za-z0-9_-]{43}', token) is not None, '기기 인증을 확인하세요.')
    target = urlsplit(origin)
    require(target.hostname and '..' not in target.hostname and (target.port is None or 1 <= target.port <= 65535), 'HTTPS 웹 주소가 올바르지 않습니다.')
    context = ssl.create_default_context()
    def request(path, payload):
        conn = http.client.HTTPSConnection(target.hostname, target.port, timeout=25, context=context)
        try:
            conn.request('POST', path, _canonical(payload).encode('utf-8'),
                         {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
            response = conn.getresponse()
            require(response.status in (200, 201), '웹 등록 HTTP ' + str(response.status) + ': 같은 대기 항목으로 재시도하세요.')
            raw = response.read(512001)
            require(len(raw) <= 512000, '웹 등록 응답이 너무 큽니다.')
            return json.loads(raw)
        finally:
            conn.close()
    def send(payload):
        return request('/api/desktop/library', payload)
    send.versions = lambda ids: request('/api/desktop/catalog/versions', {'documentIds': ids, 'allowPartial': True})
    send.scan = lambda payload: request('/api/desktop/library/scans', payload)
    return send


def _scan_receipt(payload, result):
    require(isinstance(result, dict) and set(result) == {'scanId', 'lastCompletedVerificationAt', 'receivedAt', 'roots', 'applied'}
            and result['scanId'] == payload['scanId'] and type(result['applied']) is bool
            and _canonical(result['roots']) == _canonical(payload['roots']), '위치 검사 등록 응답이 올바르지 않습니다.')
    try:
        completion = datetime.fromisoformat(result['lastCompletedVerificationAt'].replace('Z', '+00:00'))
        receipt = datetime.fromisoformat(result['receivedAt'].replace('Z', '+00:00'))
        original = datetime.fromisoformat(payload['completedAt'])
        require(completion.utcoffset() is not None and receipt.utcoffset() is not None and completion == original,
                '위치 검사 완료 시각을 확인할 수 없습니다.')
    except (ValueError, TypeError, AttributeError):
        raise ValueError('위치 검사 완료 시각을 확인할 수 없습니다.') from None


def refresh_versions(directory, fetch):
    """Refresh changed owned mappings without altering attempted request bodies."""
    with closing(database(directory)) as db:
        _ensure_all_registrations(db)
        db.commit()
        attempted = {row[0] for row in db.execute("select i.resource_id from outbox_items i join outbox o using(request_id) where o.state='pending' and o.attempts>0")}
        rows = []
        for item in _web_items(db, include_recoverable=True):
            resource = item['resourceId']
            if resource in attempted:
                continue
            ack = db.execute('select fingerprint from web_ack where resource_id=?', (resource,)).fetchone()
            if ack and ack[0] == hashlib.sha256(_canonical(item).encode()).hexdigest():
                continue
            previous = dict(db.execute('select id,book_id,server_document_id,book_version from registrations where id=?', (resource,)).fetchone())
            document = previous['server_document_id'] or item.get('legacyDocumentId')
            if document:
                previous['document_id'] = document
                rows.append(previous)
    by_document = {}
    for row in rows:
        by_document.setdefault(row['document_id'], []).append(row)
    documents = sorted(by_document)
    verified, unresolved = [], []
    for offset in range(0, len(documents), 200):
        ids = documents[offset:offset + 200]
        result = fetch(ids)
        require(isinstance(result, dict) and isinstance(result.get('items'), list), '도서 버전 확인 응답이 올바르지 않습니다.')
        values = {}
        for item in result['items']:
            require(isinstance(item, dict) and set(item) == {'legacyDocumentId', 'bookId', 'expectedBookVersion'} and item['legacyDocumentId'] in ids and item['legacyDocumentId'] not in values and valid_uuid(item['bookId']) and type(item['expectedBookVersion']) is int and 1 <= item['expectedBookVersion'] <= 2147483647, '도서 버전 또는 소유자를 확인할 수 없습니다.')
            values[item['legacyDocumentId']] = item
        missing = result.get('unresolvedDocumentIds', [])
        require(isinstance(missing, list) and all(valid_uuid(value) and value in ids for value in missing)
                and len(set(missing)) == len(missing) and not set(values).intersection(missing)
                and set(values).union(missing) == set(ids), '도서 버전 또는 소유자 확인이 누락되었습니다.')
        for document in ids:
            for previous in by_document[document]:
                item = values.get(document)
                if item is None or (previous['book_id'] and (previous['book_id'] != item['bookId'] or item['expectedBookVersion'] < previous['book_version'])):
                    unresolved.append(previous)
                else:
                    verified.append((previous, item))
    with exclusive(_plain_directory(directory), 'management-web'), closing(database(directory)) as db:
        for previous, item in verified:
            current = db.execute('select * from registrations where id=?', (previous['id'],)).fetchone()
            if current and current['book_id'] == previous['book_id'] and current['server_document_id'] == previous['server_document_id'] and current['web_state'] not in ('excluded', 'conflict'):
                _registration_update(db, previous['id'], book_id=item['bookId'], server_document_id=item['legacyDocumentId'], book_version=item['expectedBookVersion'],
                                     web_state='registered' if current['web_state'] == 'version_conflict' else current['web_state'])
        for previous in unresolved:
            # An owner-scoped unresolved old ID is held for review, never retried
            # as a new PDF without its legacy identity.
            current = db.execute('select book_id,server_document_id from registrations where id=?', (previous['id'],)).fetchone()
            if current and current['book_id'] == previous['book_id'] and current['server_document_id'] == previous['server_document_id']:
                _registration_update(db, previous['id'], web_state='conflict')
        db.commit()
    return {'verified': len(verified), 'unresolved': len(unresolved)}


def sync_web(directory, origin=None, token=None, send=None, stop=lambda: False):
    """No credential persistence/logging; never follows a redirect to another host."""
    sender = send or transport(origin, token)
    applied = 0
    # Separate transport lock prevents duplicate active sends while allowing UI pause/status.
    with exclusive(_plain_directory(directory), 'management-send'):
        if stop():
            raise InterruptedError('웹 등록 중단')
        with closing(database(directory)) as db:
            snapshot = _pending_scan(db)
        if snapshot and hasattr(sender, 'scan'):
            try:
                receipt = sender.scan(snapshot)
                _scan_receipt(snapshot, receipt)
                with exclusive(_plain_directory(directory), 'management-web'), closing(database(directory)) as db:
                    _set(db, 'scan_web_ack', snapshot['scanId'])
                    db.commit()
            except Exception:
                # Independent heartbeat failure must not block book registration;
                # the same immutable completion stays pending for the next sync.
                pass
        with closing(database(directory)) as db:
            if not _web_snapshot_ready(db):
                return dict(state='offline', applied=0, pending=_web_pending_count(db), scanPending=_pending_scan(db) is not None)
        if hasattr(sender, 'versions'):
            try:
                refresh_versions(directory, sender.versions)
            except Exception:
                raise ValueError('기존 도서의 소유자와 최신 버전을 확인하지 못했습니다. 연결 후 재시도하세요.') from None
        batches = prepare_web(directory)['requests']
        for payload in batches:
            if stop():
                raise InterruptedError('웹 등록 중단')
            with closing(database(directory)) as db:
                current = {item['resourceId']: item for item in _web_items(db)}
                if any(current.get(item['resourceId']) != item for item in payload['items']):
                    return dict(state='changed', applied=applied, pending=_web_pending_count(db))
            try:
                result = sender(payload)
                applied += apply_web_result(directory, payload['requestId'], result)['applied']
            except Exception as error:
                with closing(database(directory)) as db:
                    db.execute('update outbox set attempts=attempts+1,error=? where request_id=?', ('웹 등록 실패 (' + type(error).__name__ + ')', payload['requestId']))
                    db.commit()
                raise ValueError('웹 등록을 완료하지 못했습니다. 같은 대기 항목으로 재시도할 수 있습니다.') from None
        with closing(database(directory)) as db:
            return dict(applied=applied, pending=_web_pending_count(db), scanPending=_pending_scan(db) is not None)


def audit(directory):
    """Local-only location audit. Absolute paths never enter registration payloads."""
    with closing(database(directory)) as db:
        rows = []
        for row in db.execute('select l.*,r.title from locations l join resources r on r.id=l.resource_id order by l.path'):
            relative = Path(row['path']).relative_to(row['root']).parts
            root_key = ROOTS.get(relative[0]) if len(relative) > 1 else None
            registration = db.execute('select id,legacy_document_id,book_id from registrations where resource_id=? and legacy_document_id is ? order by id limit 1', (row['resource_id'], row['legacy_document_id'])).fetchone()
            if registration and registration['legacy_document_id'] is None and not _protected_default(db, row['resource_id']) and db.execute('select 1 from aliases where resource_id=?', (row['resource_id'],)).fetchone():
                registration = None
            rows.append(dict(resourceId=row['resource_id'], registrationId=registration[0] if registration else None, documentId=row['legacy_document_id'] or _document_id(db, row['resource_id']), title=row['title'], localPath=row['path'],
                             rootKey=root_key, relativePath='/'.join(relative[1:]) if root_key else None,
                             state='available' if _available(row) else 'offline' if not Path(row['root']).is_dir() else row['state'] if row['state'] == 'missing' else 'changed',
                             lastCheckedAt=row['checked_at']))
        return dict(locations=rows, physical=len(rows), available=sum(r['state'] == 'available' for r in rows),
                    registrationCopies=sum(r['state'] == 'available' and r['rootKey'] is not None and r['registrationId'] is not None for r in rows),
                    unresolvedRegistrationCopies=sum(r['state'] == 'available' and r['rootKey'] is not None and r['registrationId'] is None for r in rows))
