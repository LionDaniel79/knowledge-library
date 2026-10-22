"""Local OCR candidates and atomic apply/restore in the source index transaction."""
import hashlib
import json
import time
import uuid
from pdf_library import connect
from pdf_ocr import prepare
from pdf_ocr_store import source_status

def text_hash(text):return hashlib.sha256(str(text).encode('utf-8')).hexdigest()


class ReocrStore:
    def __init__(self,index):
        self.db=connect(index);prepare(self.db)
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS reocr_jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,state TEXT NOT NULL,scope TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL,pause INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',sample INTEGER NOT NULL DEFAULT 0,initialized INTEGER NOT NULL DEFAULT 0,mode TEXT NOT NULL DEFAULT 'running');
          CREATE UNIQUE INDEX IF NOT EXISTS reocr_one_active ON reocr_jobs(owner) WHERE state<>'complete';
          CREATE TABLE IF NOT EXISTS reocr_pages(job TEXT NOT NULL,document_id TEXT NOT NULL,page_number INTEGER NOT NULL,page_id INTEGER NOT NULL,signature TEXT NOT NULL,old_text TEXT,old_method TEXT NOT NULL,old_ocr TEXT,new_text TEXT,result TEXT,state TEXT NOT NULL DEFAULT 'pending',error TEXT NOT NULL DEFAULT '',PRIMARY KEY(job,document_id,page_number));
          CREATE INDEX IF NOT EXISTS reocr_page_state ON reocr_pages(job,state,document_id,page_number);
          CREATE TABLE IF NOT EXISTS page_ocr_auxiliary(document_id TEXT NOT NULL,page_number INTEGER NOT NULL,signature TEXT NOT NULL,text TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(document_id,page_number));
          CREATE VIEW IF NOT EXISTS pages_metadata AS SELECT p.document_id,p.page_number,
            CASE WHEN p.method='ocr_excluded' THEN coalesce(a.text,'') ELSE p.text END AS text,
            CASE WHEN p.method='ocr_excluded' THEN 'ocr_unverified' ELSE p.method END AS method
            FROM pages p JOIN documents d ON d.id=p.document_id LEFT JOIN page_ocr_auxiliary a ON a.document_id=p.document_id AND a.page_number=p.page_number AND a.signature=d.signature;
        ''')
        self.db.commit()

    def close(self):self.db.close()

    def required(self,owner,job):
        row=self.db.execute('SELECT * FROM reocr_jobs WHERE owner=? AND id=?',(owner,job)).fetchone()
        if not row:raise ValueError('재인식 작업을 찾을 수 없습니다.')
        return dict(row)

    def create(self,owner,scope='all',sample=False,defer=False):
        if not owner or scope not in ('all','unfinished'):raise ValueError('재인식 범위를 확인하세요.')
        job=str(uuid.uuid4())
        try:
            self.db.execute("INSERT INTO reocr_jobs(id,owner,state,scope,created,updated,sample) VALUES(?,?,'queued',?,?,?,?)",(job,owner,scope,time.time(),time.time(),int(sample)))
            self.db.commit()
            if not defer:self.initialize(owner,job)
            return job
        except BaseException:self.db.rollback();raise

    def initialize(self,owner,job):
        current=self.required(owner,job)
        if current['initialized']:return
        methods="'ocr_unverified','ocr_empty','ocr_error','needs_ocr'" if current['scope']=='all' else "'ocr_empty','ocr_error','needs_ocr'"
        self.db.execute(f'''INSERT INTO reocr_pages(job,document_id,page_number,page_id,signature,old_method)
          SELECT ?,d.id,p.page_number,p.id,d.signature,p.method FROM pages p JOIN documents d ON d.id=p.document_id
          WHERE d.processing_scope='full' AND d.material_kind='book' AND d.status IN ('needs_ocr','partial_ocr','ocr_review')
          AND p.method IN ({methods}) ORDER BY d.id,p.page_number {'LIMIT 5' if current['sample'] else ''}''',(job,))
        self.db.execute('UPDATE reocr_jobs SET initialized=1,updated=? WHERE id=?',(time.time(),job));self.db.commit()

    def start(self,owner,job,retry=False,mode='running'):
        current=self.required(owner,job)
        if mode not in ('running','applying','restoring'):raise ValueError('작업 종류 오류')
        if current['state']=='complete' and mode=='running':raise ValueError('완료한 작업입니다. 새 작업을 시작하세요.')
        if retry:self.db.execute("UPDATE reocr_pages SET state='pending',error='' WHERE job=? AND state='error'",(job,))
        self.db.execute("UPDATE reocr_jobs SET state=?,mode=?,pause=0,error='',updated=? WHERE id=?",(mode,mode,time.time(),job));self.db.commit()

    def queue(self,owner,job,mode=None,retry=False):
        current=self.required(owner,job);mode=mode or current['mode']
        if current['state'] in ('running','applying','restoring') and time.time()-current['updated']<120:raise ValueError('현재 작업이 실행 중입니다.')
        if self.db.execute("SELECT 1 FROM reocr_jobs WHERE owner=? AND id<>? AND state<>'complete'",(owner,job)).fetchone():raise ValueError('다른 OCR 작업을 먼저 종료해 주세요.')
        if retry:self.db.execute("UPDATE reocr_pages SET state='pending',error='' WHERE job=? AND state='error'",(job,))
        self.db.execute("UPDATE reocr_jobs SET state='queued',mode=?,pause=0,error='',updated=? WHERE id=?",(mode,time.time(),job));self.db.commit()

    def pause(self,owner,job):
        self.required(owner,job);self.db.execute('UPDATE reocr_jobs SET pause=1 WHERE id=?',(job,));self.db.commit()

    def finish(self,owner,job,state,error=''):
        if state not in ('paused','complete','failed'):raise ValueError('작업 상태 오류')
        self.required(owner,job);self.db.execute('UPDATE reocr_jobs SET state=?,error=?,updated=? WHERE id=?',(state,error,time.time(),job));self.db.commit()

    def heartbeat(self,owner,job):
        self.required(owner,job);self.db.execute('UPDATE reocr_jobs SET updated=? WHERE id=?',(time.time(),job));self.db.commit()

    def next_page(self,owner,job):
        self.required(owner,job)
        row=self.db.execute("SELECT p.*,d.path,d.root,d.title,d.page_count FROM reocr_pages p JOIN documents d ON d.id=p.document_id WHERE p.job=? AND p.state='pending' ORDER BY p.document_id,p.page_number LIMIT 1",(job,)).fetchone()
        if not row:return None
        row=dict(row)
        if row['old_text'] is None:
            current=self.db.execute('SELECT d.signature,p.text,p.method FROM pages p JOIN documents d ON d.id=p.document_id WHERE p.id=? AND d.id=?',(row['page_id'],row['document_id'])).fetchone()
            if not current or current['signature']!=row['signature'] or current['method']!=row['old_method']:
                self.mark(owner,job,row,'stale','대상 준비 후 내용 변경');return {'stale_selection':True}
            old=self.db.execute('SELECT * FROM page_ocr WHERE document_id=? AND page_number=?',(row['document_id'],row['page_number'])).fetchone()
            row['old_text']=current['text'];row['old_ocr']=json.dumps(dict(old)) if old else None
            self.db.execute('UPDATE reocr_pages SET old_text=?,old_ocr=? WHERE job=? AND page_id=?',(row['old_text'],row['old_ocr'],job,row['page_id']));self.db.commit()
        return row

    def source_current(self,row,check_provenance=True):
        if source_status(row):return False
        current=self.db.execute('SELECT d.signature,d.processing_scope,d.material_kind,d.status,p.text,p.method FROM pages p JOIN documents d ON d.id=p.document_id WHERE p.id=? AND d.id=? AND p.page_number=?',(row['page_id'],row['document_id'],row['page_number'])).fetchone()
        same=bool(current and current['signature']==row['signature'] and current['processing_scope']=='full' and current['material_kind']=='book' and current['status'] in ('needs_ocr','partial_ocr','ocr_review') and current['text']==row['old_text'] and current['method']==row['old_method'])
        if same and check_provenance and 'old_ocr' in row:
            current_ocr=self.db.execute('SELECT * FROM page_ocr WHERE document_id=? AND page_number=?',(row['document_id'],row['page_number'])).fetchone()
            same=(json.loads(row['old_ocr']) if row['old_ocr'] else None)==(dict(current_ocr) if current_ocr else None)
        return same

    def save_candidate(self,owner,job,row,result):
        self.required(owner,job)
        if not self.source_current(row):self.mark(owner,job,row,'stale','원본·기존 내용이 변경됨');return False
        text=str(result.get('text','')).replace('\x00','').strip()
        if len(text)>100000:raise ValueError('OCR 결과가 너무 큽니다.')
        # Empty output cannot improve the index. Keep the active text rather
        # than asking the reader to approve a result that cannot be applied.
        state='rejected' if not text else 'review' if result.get('review') else 'ready'
        self.db.execute('UPDATE reocr_pages SET new_text=?,result=?,state=?,error=\'\' WHERE job=? AND document_id=? AND page_number=? AND state=\'pending\'',(text,json.dumps(result,ensure_ascii=False),state,job,row['document_id'],row['page_number']))
        self.heartbeat(owner,job);return True

    def mark(self,owner,job,row,state,error=''):
        if state not in ('error','stale','rejected'):raise ValueError('페이지 상태 오류')
        self.required(owner,job);self.db.execute('UPDATE reocr_pages SET state=?,error=? WHERE job=? AND document_id=? AND page_number=?',(state,error,job,row['document_id'],row['page_number']));self.db.commit()

    def _reconcile(self,document):
        self.db.execute("UPDATE documents SET text_pages=(SELECT count(*) FROM pages WHERE document_id=? AND text<>''),status=CASE WHEN EXISTS(SELECT 1 FROM pages WHERE document_id=? AND method IN ('needs_ocr','ocr_error')) THEN 'partial_ocr' ELSE 'ocr_review' END,updated_at=datetime('now') WHERE id=?",(document,document,document))

    def apply(self,owner,job,include_review=False,page_id=None):
        if self.required(owner,job)['state']=='running':raise ValueError('작업을 중지한 뒤 반영하세요.')
        states="('ready','review')" if include_review else "('ready')"
        rows=self.db.execute(f"SELECT p.*,d.path,d.root FROM reocr_pages p JOIN documents d ON d.id=p.document_id WHERE job=? AND p.state IN {states} AND (? IS NULL OR p.page_id=?)",(job,page_id,page_id)).fetchall();applied=0
        for r in rows:
            row=dict(r)
            try:
                self.db.execute('BEGIN IMMEDIATE')
                if not self.source_current(row):
                    self.db.rollback();self.mark(owner,job,row,'stale','기존 내용·원본 변경: 덮어쓰지 않음');continue
                result=json.loads(row['result'])
                auxiliary=bool(result.get('auxiliaryOnly'))
                if not row['new_text'] and not auxiliary:
                    self.db.rollback();continue
                active_text='' if auxiliary else row['new_text'];method='ocr_excluded' if auxiliary else 'ocr_unverified'
                self.db.execute("UPDATE pages SET text=?,method=? WHERE id=?",(active_text,method,row['page_id']))
                if auxiliary:self.db.execute('INSERT OR REPLACE INTO page_ocr_auxiliary VALUES(?,?,?,?,?)',(row['document_id'],row['page_number'],row['signature'],row['new_text'] or row['old_text'],job))
                self.db.execute('INSERT OR REPLACE INTO page_ocr(document_id,page_number,signature,engine,language,text_hash,image_hash,width,height) VALUES(?,?,?,?,?,?,?,?,?)',(row['document_id'],row['page_number'],row['signature'],result.get('engine','Windows.Media.Ocr')+'/'+result.get('profile','quality')+'/job='+job,result.get('language','ko'),text_hash(active_text),result.get('image_hash',''),result.get('width'),result.get('height')))
                self.db.execute("UPDATE reocr_pages SET state='applied' WHERE job=? AND page_id=?",(job,row['page_id']))
                self._reconcile(row['document_id']);self.db.commit();applied+=1
            except BaseException:self.db.rollback();raise
        return applied

    def exclude(self,owner,job,page_id):
        if self.required(owner,job)['state'] in ('running','applying','restoring'):raise ValueError('먼저 작업을 중지해 주세요.')
        row=self.db.execute("SELECT result FROM reocr_pages WHERE job=? AND page_id=? AND state IN ('ready','review')",(job,page_id)).fetchone()
        if not row:raise ValueError('검토할 결과를 찾을 수 없습니다.')
        result=json.loads(row['result']);result['auxiliaryOnly']=True
        self.db.execute('UPDATE reocr_pages SET result=? WHERE job=? AND page_id=?',(json.dumps(result,ensure_ascii=False),job,page_id));self.db.commit()
        return self.apply(owner,job,True,page_id)

    def restore(self,owner,job,page_id=None):
        if self.required(owner,job)['state']=='running':raise ValueError('작업을 중지한 뒤 복원하세요.')
        rows=self.db.execute("SELECT p.*,d.path,d.root FROM reocr_pages p JOIN documents d ON d.id=p.document_id WHERE job=? AND p.state='applied' AND (? IS NULL OR p.page_id=?)",(job,page_id,page_id)).fetchall();restored=0
        for r in rows:
            row=dict(r)
            try:
                self.db.execute('BEGIN IMMEDIATE')
                current=self.db.execute('SELECT text,method FROM pages WHERE id=?',(row['page_id'],)).fetchone()
                provenance=self.db.execute('SELECT engine FROM page_ocr WHERE document_id=? AND page_number=?',(row['document_id'],row['page_number'])).fetchone()
                auxiliary=bool(json.loads(row['result']).get('auxiliaryOnly'))
                if not provenance or not provenance['engine'].endswith('/job='+job) or not self.source_current({**row,'old_text':'' if auxiliary else row['new_text'],'old_method':'ocr_excluded' if auxiliary else 'ocr_unverified'},False):
                    self.db.rollback();self.mark(owner,job,row,'stale','반영 후 내용·원본 변경: 복원 보류');continue
                self.db.execute('UPDATE pages SET text=?,method=? WHERE id=?',(row['old_text'],row['old_method'],row['page_id']))
                self.db.execute('DELETE FROM page_ocr WHERE document_id=? AND page_number=?',(row['document_id'],row['page_number']))
                self.db.execute('DELETE FROM page_ocr_auxiliary WHERE document_id=? AND page_number=? AND generation=?',(row['document_id'],row['page_number'],job))
                if row['old_ocr']:
                    old=json.loads(row['old_ocr']);columns=['document_id','page_number','signature','engine','language','text_hash','image_hash','width','height','error','recognized_at']
                    self.db.execute('INSERT INTO page_ocr('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')',[old.get(c) for c in columns])
                self.db.execute("UPDATE reocr_pages SET state='restored' WHERE job=? AND page_id=?",(job,row['page_id']));self._reconcile(row['document_id']);self.db.commit();restored+=1
            except BaseException:self.db.rollback();raise
        return restored

    def summary(self,owner,job=None,page=1):
        if not job:
            current=self.db.execute('SELECT id FROM reocr_jobs WHERE owner=? ORDER BY created DESC LIMIT 1',(owner,)).fetchone()
            if not current:return {'job':None}
            job=current['id']
        current=self.required(owner,job)
        counts=dict(self.db.execute('SELECT state,count(*) FROM reocr_pages WHERE job=? GROUP BY state',(job,)).fetchall())
        rows=self.db.execute("SELECT p.document_id,p.page_number,p.page_id,substr(p.old_text,1,6000) AS old_text,substr(p.new_text,1,6000) AS new_text,p.state,p.error,json_extract(p.result,'$.review') AS review,d.title FROM reocr_pages p JOIN documents d ON d.id=p.document_id WHERE p.job=? ORDER BY p.document_id,p.page_number LIMIT 10 OFFSET ?",(job,(page-1)*10)).fetchall()
        return {'job':current,'total':sum(counts.values()),'counts':counts,'pages':[dict(r) for r in rows],'history':[dict(r) for r in self.db.execute('SELECT id,state,created FROM reocr_jobs WHERE owner=? ORDER BY created DESC',(owner,))]}
