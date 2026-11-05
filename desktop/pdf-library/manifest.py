"""API v2 in-process contract. No URL, socket, DB credential or cleanup executor."""
import hashlib
import json
import uuid
import re
from pathlib import Path
from reader import source
from registry import registry,walk,GROUPS,exclusive


def digest(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def attach_catalog(backup,directory):
    """Use only selected document IDs from an explicit single-owner offline export."""
    with exclusive(directory,'inventory'):
        db=registry(directory)
        try:
            tables=json.loads(Path(backup).read_bytes())['tables']
            books={b['id']:b for b in tables['library_books']}
            wanted={r[0] for r in db.execute("select distinct w.legacy_id from web_registration w join location l using(path) where l.state='verified' and w.registration_root is not null")}
            hints=[]
            for d in tables['library_documents']:
                if d['id'] not in wanted:continue
                b=books[d['book_id']]
                if b.get('source_data',{}).get('app')!='Local PDF':continue
                uuid.UUID(d['id']);uuid.UUID(b['id'])
                bib={}
                for key in ('title','author','publisher','isbn'):
                    value=b.get(key)
                    if isinstance(value,str) and value.strip() and not re.search(r'[/\\]|[A-Za-z]:|[a-f0-9]{64}|\.(?:pdf|sqlite)\b',value,re.I):
                        bib[key]=value[:300]
                hints.append((d['id'],b['id'],int(b['version']),json.dumps(bib,ensure_ascii=False)))
            db.execute('create table if not exists catalog_hint(doc text primary key,book text,version integer,bib text)')
            db.execute('delete from catalog_hint')
            db.executemany('insert into catalog_hint values(?,?,?,?)',hints)
            db.commit()
            return {'hints':len(hints)}
        finally:db.close()


class MockCatalog:
    def __init__(self, token, catalog=None):
        if token!='local-test': raise PermissionError('모의 기기 승인 필요')
        self.batches={}
        self.sealed=False
        self.applied=False
        self.catalog=catalog or {}
        self.header=None

    def start(self, header):
        if header['schemaVersion']!=2 or not header['rootAvailable'] or not header['scanComplete']:
            raise ValueError('완료된 스캔이 필요합니다.')
        self.header=header

    def put(self, operation, items):
        if not self.header or len(items)>200 or not items:raise ValueError('잘못된 배치')
        if self.sealed and self.batches.get(operation)!=items:raise ValueError('이미 봉인한 manifest')
        for item in items:
            if set(item)!={'operationId','contentKey','legacyDocumentId','bookId','registrationRoot','action','bibliography','expectedBookVersion'} or item['registrationRoot'] not in GROUPS.values() or item['action']!='select':
                raise ValueError('허용되지 않은 전송 항목')
            for key in ('operationId','contentKey','legacyDocumentId'):uuid.UUID(item[key])
            if set(item['bibliography'])-{'pageCount','title','author','publisher','isbn'}:raise ValueError('서지 필드 오류')
            expected=self.catalog.get(item['legacyDocumentId'])
            if expected and (item['bookId'],item['expectedBookVersion'])!=expected:
                raise ValueError('409 conflict: 도서 ID 또는 버전 불일치')
        if operation in self.batches and self.batches[operation]!=items:raise ValueError('동일 요청의 내용이 다릅니다.')
        self.batches[operation]=items

    def seal(self):
        rows=[row for batch in self.batches.values() for row in batch]
        if sum(self.header['physicalByRoot'].values())!=self.header['physicalCount'] or sum(self.header['copiesById'].values())!=self.header['physicalCount'] or set(self.header['copiesById'])!={r['legacyDocumentId'] for r in rows}:
            raise ValueError('물리 사본 수와 선택 목록 불일치')
        if len(rows)!=self.header['uniqueCount'] or len({r['legacyDocumentId'] for r in rows})!=len(rows) or digest(rows)!=self.header['itemsDigest']:
            raise ValueError('수신 집합 불일치')
        self.sealed=True

    def preview(self):
        if not self.sealed:raise ValueError('seal 필요')
        return {'unique':self.header['uniqueCount'],'physical':self.header['physicalCount']}

    def apply_selection(self,approved):
        if not self.sealed or not approved:raise ValueError('모의 승인 필요')
        self.applied=True

    def cleanup_preview(self):
        return {'schemaVersion':2,'manifestId':self.header['manifestId'],'dryRun':True,'applyEnabled':False,
                'batchTemplate':{'manifestId':self.header['manifestId'],'planId':None,'approvalId':None,'batchId':None,'execute':False},
                'message':'실제 삭제는 5단계에서만 가능합니다.'}


def preview(index,root,directory):
    with exclusive(directory,'inventory'):
        return _preview(index,Path(root).absolute(),directory)


def _preview(index,root,directory,server_items=False):
    from contextlib import closing
    database = source(Path(directory)/'desktop-registry-v2.sqlite') if server_items else closing(registry(directory))
    with database as db:
        run=db.execute('select * from scan_runs order by rowid desc limit 1').fetchone()
        if not run or run['state']!='complete' or str(root)!=run['root']:
            raise ValueError('완전한 스캔을 먼저 수행하세요.')
        volume=db.execute('select volume from scan_volume where run=?',(run['id'],)).fetchone()
        if not volume or str(root.stat().st_dev)!=volume[0]:
            raise ValueError('저장소가 달라졌습니다. 다시 스캔하세요.')
        physical=total=0
        byroot={group:0 for group in GROUPS.values()}
        copies={}
        by_document={}
        hints={r['doc']:r for r in db.execute('select * from catalog_hint')} if db.execute("select 1 from sqlite_master where name='catalog_hint'").fetchone() else {}
        selected={}
        with source(index) as src:
            for path in walk(root):
                total+=1
                st=path.stat()
                row=db.execute('select l.*,w.legacy_id,w.registration_root from location l join web_registration w using(path) where l.path=? and run=?',(str(path),run['id'])).fetchone()
                if not row or (st.st_size,str(st.st_mtime_ns))!=(row['size'],row['mtime']):raise ValueError('스캔 후 파일 변경')
                group=GROUPS.get(path.relative_to(root).parts[0])
                if not group:continue
                physical+=1
                byroot[group]+=1
                if row['state']!='verified' or group!=row['registration_root'] or not row['legacy_id']:
                    raise ValueError('선택 파일 식별 검토 필요')
                doc=row['legacy_id']
                by_document.setdefault(doc,dict.fromkeys(GROUPS.values(),0))[group]+=1
                copies[doc]=copies.get(doc,0)+1
                if doc not in selected or group=='christian':
                    sha=db.execute('select sha from content where id=?',(row['content'],)).fetchone()[0]
                    page=src.execute('select page_count from documents where id=? and sha256=?',(doc,sha)).fetchone()
                    if not page:raise ValueError('문서 누락')
                    item=dict(contentKey=row['content'],legacyDocumentId=doc,bookId=None,registrationRoot=group,action='select',bibliography={'pageCount':page[0]} if page[0] else {},expectedBookVersion=None)
                    if doc in hints:
                        item.update(bookId=hints[doc]['book'],expectedBookVersion=hints[doc]['version'])
                        item['bibliography'].update(json.loads(hints[doc]['bib']))
                    item['operationId']=str(uuid.uuid5(uuid.NAMESPACE_OID,digest(item)))
                    selected[doc]=item
        if total!=run['files'] or not physical:raise ValueError('선택 집합 불완전')
        items=[selected[k] for k in sorted(selected)]
        if server_items:
            return [dict(legacyDocumentId=i["legacyDocumentId"],bookId=i["bookId"],
                         expectedBookVersion=i["expectedBookVersion"],copiesByRoot=by_document[i["legacyDocumentId"]])
                    for i in items]
        header=dict(schemaVersion=2,scanComplete=True,rootAvailable=True,physicalCount=physical,physicalByRoot=byroot,copiesById=copies,uniqueCount=len(items),itemsDigest=digest(items))
        header['manifestId']=str(uuid.uuid5(uuid.NAMESPACE_OID,digest(header)))
        trusted={doc:(row['book'],row['version']) for doc,row in hints.items()}
        mock=MockCatalog('local-test',trusted)
        # Queue locally before simulated delivery. Rebuilding the same complete
        # manifest retries pending deliveries after an interrupted run.
        payload={'header':header,'items':items}
        db.execute('insert or ignore into outbox values(?,?,?)',(header['manifestId'],digest(payload),json.dumps(payload,ensure_ascii=False)))
        db.execute('create table if not exists mock_ack(manifest text primary key,digest text not null,registered integer)')
        db.commit()
        mock.start(header)
        for i in range(0,len(items),200):
            batch=items[i:i+200];operation=str(uuid.uuid5(uuid.UUID(header['manifestId']),str(i)))
            mock.put(operation,batch);mock.put(operation,batch)
        mock.seal();result=mock.preview();mock.apply_selection(True)
        db.execute('insert or ignore into mock_ack values(?,?,?)',(header['manifestId'],digest(payload),len(items)))
        db.commit()
        return dict(result,manifestId=header['manifestId'],mock=True,cleanup=mock.cleanup_preview())
