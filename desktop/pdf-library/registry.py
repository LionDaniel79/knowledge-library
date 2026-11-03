"""Durable local inventory. A failed or partial walk never authorizes a manifest."""
import hashlib
import os
import sqlite3
import uuid
from collections import Counter,defaultdict
from contextlib import contextmanager
from pathlib import Path
from reader import source

GROUPS={'기독도서':'christian','일반도서':'general'}
SCHEMA="""
create table content(id text primary key,sha text unique not null);
create table legacy_document_binding(id text primary key,content text not null);
create table location(path text primary key,root text,size integer,mtime text,content text,state text,run text);
create table web_registration(path text primary key,registration_root text,legacy_id text,state text);
create table scan_runs(id text primary key,root text,state text,files integer default 0,hashed integer default 0);
create table outbox(id text primary key,digest text unique,payload text);
create index location_content on location(content,state);
create index binding_content on legacy_document_binding(content);
"""


def registry(directory):
    directory=Path(directory).resolve()
    directory.mkdir(parents=True,exist_ok=True)
    path=directory/'desktop-registry-v2.sqlite'
    if path.exists():
        # Header check does not open a writable arbitrary database. A private
        # hot rollback journal from cancellation is recovered by SQLite below.
        with path.open('rb') as f:
            header=f.read(72)
        if path.is_symlink() or path.stat().st_nlink!=1 or header[:16]!=b'SQLite format 3\0' or int.from_bytes(header[68:72],'big')!=843026:
            raise ValueError('사이드카 전용 DB가 아닙니다.')
    db=sqlite3.connect(path,timeout=3)
    db.row_factory=sqlite3.Row
    if not db.execute('pragma application_id').fetchone()[0]:
        db.executescript('BEGIN;'+SCHEMA+'PRAGMA application_id=843026;COMMIT;')
    db.execute("""create view if not exists legacy_status as
        select b.id,case when (select state from scan_runs order by rowid desc limit 1) is not 'complete' then 'unverified'
        when exists(select 1 from web_registration w join location l using(path) where w.legacy_id=b.id and l.state='verified' and l.run=(select id from scan_runs order by rowid desc limit 1)) then 'available'
        else 'missing' end as state from legacy_document_binding b""")
    return db


def walk(root):
    if any(getattr(p.lstat(),'st_file_attributes',0)&1024 for p in (root,*root.parents)):
        raise ValueError('저장소 루트는 연결 경로일 수 없습니다.')
    if not root.is_dir() or any(not (root/name).is_dir() for name in GROUPS):
        raise ValueError('저장소 또는 두 선택 폴더가 없습니다.')
    def fail(error): raise error
    for parent,dirs,files in os.walk(root,onerror=fail):
        for name in dirs+files:
            path=Path(parent,name)
            if path.is_symlink() or getattr(path.lstat(),'st_file_attributes',0)&1024:
                raise ValueError('연결 경로가 있어 완전 스캔을 중단했습니다.')
        for name in files:
            if name.lower().endswith('.pdf'):
                yield Path(parent,name)


def fingerprint(path, stop):
    before=path.stat()
    digest=hashlib.sha256()
    with path.open('rb') as f:
        while block:=f.read(2**20):
            if stop():raise InterruptedError('검산 중단')
            digest.update(block)
    after=path.stat()
    if (before.st_size,before.st_mtime_ns,before.st_ino)!=(after.st_size,after.st_mtime_ns,after.st_ino):
        raise ValueError('검산 중 파일이 변경되었습니다.')
    return digest.hexdigest()


def scan(index, root, directory, stop=lambda:False, progress=lambda n,h:None):
    root=Path(root).absolute()
    with exclusive(directory,'inventory'):
        return _scan(index,root,directory,stop,progress)


@contextmanager
def exclusive(directory, name):
    """Kernel releases this single writer lock even if the child is cancelled."""
    import msvcrt
    directory=Path(directory).resolve()
    directory.mkdir(parents=True,exist_ok=True)
    with (directory/(name+'.lock')).open('a+b') as lock:
        lock.seek(0)
        try: msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
        except OSError: raise ValueError('같은 작업이 이미 실행 중입니다.') from None
        try: yield
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(),msvcrt.LK_UNLCK,1)


def _scan(index, root, directory, stop, progress):
    db=registry(directory)
    run=str(uuid.uuid4())
    n=hashed=0
    try:
        db.execute("insert into scan_runs(id,root,state) values(?,?,'scanning')",(run,str(root)))
        db.commit()
        volume=str(root.stat().st_dev)
        db.execute('create table if not exists scan_volume(run text primary key,volume text)')
        db.execute('insert into scan_volume values(?,?)',(run,volume))
        db.commit()
        old_volume=db.execute("select v.volume from scan_runs s join scan_volume v on s.id=v.run where s.root=? and s.state='complete' order by s.rowid desc limit 1",(str(root),)).fetchone()
        changed_volume=old_volume is not None and old_volume[0]!=volume
        with source(index) as src:
            old=list(src.execute('select id,path,bytes,mtime_ns,sha256 from documents'))
        bypath={os.path.normcase(d['path']):d for d in old}
        byhash=defaultdict(list)
        for d in old:
            if d['sha256']:
                byhash[d['sha256']].append(d)
                db.execute('insert or ignore into content values(?,?)',(str(uuid.uuid4()),d['sha256']))
                db.execute('insert or replace into legacy_document_binding select ?,id from content where sha=?',(d['id'],d['sha256']))
        db.commit()
        files=list(walk(root))
        paths={os.path.normcase(str(path)) for path in files}
        def hint(path,size,mt):
            return (Path(path).name.casefold(),size,str(mt))
        hints=Counter()
        for path in files:
            stat=path.stat()
            hints[hint(path,stat.st_size,stat.st_mtime_ns)]+=1
        for path in files:
            if stop():raise InterruptedError('스캔 중단')
            if path.resolve(strict=True)!=path.absolute():raise ValueError('검산 도중 경로 변경')
            st=path.stat()
            size,mt=st.st_size,str(st.st_mtime_ns)
            key=str(path)
            group=GROUPS.get(path.relative_to(root).parts[0])
            direct=bypath.get(os.path.normcase(key))
            same=direct and direct['bytes']==size and direct['mtime_ns']==mt and direct['sha256']
            cached=db.execute("select c.sha from location l join content c on c.id=l.content where l.path=? and l.size=? and l.mtime=? and l.state in ('verified','review')",(key,size,mt)).fetchone()
            if same and not changed_volume: sha=direct['sha256']
            elif cached and not changed_volume: sha=cached[0]
            else:
                sha=fingerprint(path,stop)
                hashed+=1
            db.execute('insert or ignore into content values(?,?)',(str(uuid.uuid4()),sha))
            content=db.execute('select id from content where sha=?',(sha,)).fetchone()[0]
            candidates=byhash[sha]
            doc=direct['id'] if same and sha==direct['sha256'] else candidates[0]['id'] if len(candidates)==1 else None
            # Identical bytes can back independent books. A unique old/new
            # filename+size+mtime pair distinguishes a relocation only after
            # the digest agrees and the old location is absent.
            marker=hint(path,size,mt)
            if doc is None and hints[marker]==1:
                matches=[d for d in candidates if os.path.normcase(d['path']) not in paths and hint(d['path'],d['bytes'],d['mtime_ns'])==marker]
                if len(matches)==1:doc=matches[0]['id']
            state='verified' if doc else 'review'
            db.execute('insert or replace into location values(?,?,?,?,?,?,?)',(key,str(root),size,mt,content,state,run))
            db.execute('insert or replace into web_registration values(?,?,?,?)',(key,group,doc,state))
            n+=1
            db.execute('update scan_runs set files=?,hashed=? where id=?',(n,hashed,run))
            db.commit()
            if n%100==0:progress(n,hashed)
        # Repeat cheap metadata enumeration to catch changes during a long hash pass.
        seen=0
        for path in walk(root):
            if stop(): raise InterruptedError('검산 중단')
            st=path.stat()
            if not db.execute('select 1 from location where run=? and path=? and size=? and mtime=?',(run,str(path),st.st_size,str(st.st_mtime_ns))).fetchone():
                raise ValueError('스캔 중 목록이 변했습니다.')
            seen+=1
        if seen!=n or str(root.stat().st_dev)!=volume:raise ValueError('스캔 중 저장소 또는 목록이 변했습니다.')
        db.execute("update location set state='missing' where root=? and run<>?",(str(root),run))
        db.execute("update scan_runs set state='complete' where id=?",(run,))
        db.commit()
        return dict(run=run,files=n,hashed=hashed)
    except BaseException:
        db.rollback()
        db.execute("update scan_runs set state='incomplete' where id=?",(run,))
        db.commit()
        raise
    finally:db.close()
