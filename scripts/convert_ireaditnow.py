"""Read a recovered iReadItNow HD Core Data database without modifying it."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sqlite3

TABLES = ('ZBOOK','ZNOTE','ZREVIEW','ZREADSESSION','ZBOOKMARK','ZRECORD',
          'ZTAG','ZLIST','Z_1TAGS','Z_1LISTS','Z_5TAGS','ZUNDERLINE','Z_9UNDERLINES')
EPOCH = dt.datetime(2001,1,1,tzinfo=dt.timezone.utc)
SEOUL = dt.timezone(dt.timedelta(hours=9))

def source_timestamp(value):
    if value is None or value <= 0: return None
    return (EPOCH+dt.timedelta(seconds=value)).isoformat().replace('+00:00','Z')

def source_date(value):
    if value is None or value <= 0: return None
    return (EPOCH+dt.timedelta(seconds=value)).astimezone(SEOUL).date().isoformat()

def book_format(value):
    if value == '전자책': return 'ebook'
    if value in ('양장본','비양장본','Paperback','book'): return 'paper'
    return 'unknown'

def record_id(row):
    return str(row.get('ZUUID') or row['Z_PK'])

def inline_image(value):
    return value[1:] if value.startswith(b'\x01') else value

def convert(tables, library_id, database_hash, covers=None):
    books=[]; notes=[]
    book_ids={b['Z_PK']:record_id(b) for b in tables['ZBOOK']}
    tags={t['Z_PK']:t.get('ZNAME','') for t in tables['ZTAG']}
    lists={t['Z_PK']:t for t in tables['ZLIST']}
    for b in tables['ZBOOK']:
        sessions=[]
        for s in tables['ZREADSESSION']:
            if s.get('ZBOOK') != b['Z_PK']: continue
            marks=[{'sourceId':record_id(m),'page':m.get('ZPAGE'),
                    'recordedAt':source_timestamp(m.get('ZTIMESTAMP'))}
                   for m in tables['ZBOOKMARK'] if m.get('ZSESSION')==s['Z_PK']]
            sessions.append({'sourceId':record_id(s),'statusCode':s.get('ZSTATUS'),
                             'startedOn':source_date(s.get('ZSTARTREADING')),
                             'endedOn':source_date(s.get('ZFINISHREADING')),'bookmarks':marks,'raw':s})
        source={'app':'iReadItNow HD','libraryId':library_id,'recordId':record_id(b),
                'statusCode':b.get('ZSTATUS'),'originalFormat':b.get('ZFORMAT') or '',
                'sessions':sessions,'raw':b,
                'lists':[lists[r['Z_4LISTS']] for r in tables['Z_1LISTS']
                         if r['Z_1BOOKS1']==b['Z_PK'] and r['Z_4LISTS'] in lists]}
        if covers and b['Z_PK'] in covers: source['cover']=covers[b['Z_PK']]
        books.append({'sourceId':record_id(b),'title':b.get('ZTITLE') or '',
                      'author':b.get('ZAUTHOR') or '', 'publisher':b.get('ZPUBLISHER') or '',
                      'isbn':b.get('ZISBN') or '', 'formats':[book_format(b.get('ZFORMAT'))],
                      'totalPages':b.get('ZNUMBEROFPAGES') or None,'shelf':'',
                      'tags':sorted(set(tags[r['Z_9TAGS']] for r in tables['Z_1TAGS']
                                if r['Z_1BOOKS']==b['Z_PK'] and tags.get(r['Z_9TAGS']))),
                      'sourceData':source,'sourceCreatedAt':source_timestamp(b.get('ZTIMESTAMP'))})
    for table, kind in [('ZNOTE','note'),('ZREVIEW','review')]:
        for n in tables[table]:
            content=(n.get('ZNOTE') or '') if kind=='note' else '\n\n'.join(
                str(n[k]) for k in ('ZSHORTREVIEW','ZFULLREVIEW') if n.get(k))
            snapshot=n.get('ZSNAPSHOT')
            if not content.strip() and not snapshot: continue
            if n.get('ZBOOK') not in book_ids:
                raise ValueError('Orphan note/review detected')
            notes.append({'sourceId':kind+':'+record_id(n),'bookSourceId':book_ids[n['ZBOOK']],
                          'title':'독서 메모' if kind=='note' else '서평',
                          'content':content if content.strip() else '사진으로 남긴 독서 메모',
                          'kind':kind,'page':None,'sourceCreatedAt':source_timestamp(n.get('ZTIMESTAMP')),
                          'sourceData':{'app':'iReadItNow HD','libraryId':library_id,
                                        'recordId':record_id(n),'raw':n,**({'image':snapshot} if snapshot else {})}})
    return {'schemaVersion':1,'source':'iReadItNowHD','sourceLibraryId':library_id,
            'databaseSha256':database_hash,'timezone':'Asia/Seoul','books':books,'notes':notes,
            'originalTables':tables}

def export_database(db_path, destination):
    db_path=Path(db_path).resolve(); destination=Path(destination).resolve()
    if list(db_path.parent.glob(db_path.name+'-wal')):
        raise ValueError('WAL exists; create a consistent SQLite snapshot before converting')
    if destination.exists(): raise ValueError('Choose a new output folder; existing output is preserved')
    destination.mkdir(parents=True)
    (destination/'assets').mkdir()
    connection=sqlite3.connect(db_path.as_uri()+'?mode=ro&immutable=1',uri=True)
    connection.row_factory=sqlite3.Row
    try:
        if connection.execute('PRAGMA integrity_check').fetchone()[0]!='ok':
            raise ValueError('SQLite integrity check failed')
        library_id=connection.execute('SELECT Z_UUID FROM Z_METADATA').fetchone()[0]
        external=db_path.parent/('.'+db_path.stem+'_SUPPORT')/'_EXTERNAL_DATA'
        def asset(value):
            if value is None: return None
            match=re.fullmatch(rb'[\x00-\x03]([0-9A-Fa-f-]{36})\x00',value)
            if match: value=(external/match[1].decode('ascii')).read_bytes()
            else: value=inline_image(value)
            mime='image/jpeg' if value.startswith(b'\xff\xd8\xff') else 'image/png' if value.startswith(b'\x89PNG\r\n\x1a\n') else None
            if not mime: raise ValueError('Unrecognized image attachment')
            digest=hashlib.sha256(value).hexdigest()
            target=destination/'assets'/digest
            if not target.exists(): target.write_bytes(value)
            return {'sha256':digest,'mime':mime,'bytes':len(value)}
        tables={}
        for name in TABLES:
            rows=[]
            for raw in connection.execute('SELECT * FROM '+name):
                row=dict(raw)
                for key,value in row.items():
                    if isinstance(value,bytes): row[key]=asset(value)
                rows.append(row)
            tables[name]=rows
        covers={r['ZBOOK']:asset(r['ZTHUMBNAIL'] or r['ZIMAGE']) for r in connection.execute('SELECT ZBOOK,ZTHUMBNAIL,ZIMAGE FROM ZCOVERIMAGE')}
        with db_path.open('rb') as stream:
            digest=hashlib.file_digest(stream,'sha256').hexdigest()
        result=convert(tables,library_id,digest,covers)
        path=destination/'ireaditnow-library.json'
        path.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
        print(json.dumps({'file':str(path),'books':len(result['books']),'notes':len(result['notes']),
                          'sessions':len(tables['ZREADSESSION']),'bookmarks':len(tables['ZBOOKMARK']),
                          'assets':len(list((destination/'assets').iterdir()))},ensure_ascii=True))
    finally: connection.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('database'); parser.add_argument('output')
    args=parser.parse_args()
    export_database(args.database,args.output)
