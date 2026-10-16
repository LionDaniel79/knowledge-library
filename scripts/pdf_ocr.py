"""Local, resumable OCR. Originals and native text are never rewritten."""
import argparse, base64, hashlib, json, os, queue, shutil, subprocess, tempfile, threading, sys, time
from pathlib import Path
from pdf_library import connect, signature, apply_scope
from pdf_job_state import write_state, processing_lock, request_stop, stop_requested, resolved_index
from pdf_ocr_pipeline import CachedRenderer
from pdf_ocr_store import pending_pages, source_status, mark_source_stale, current_page, save_page, is_resource_error
from concurrent.futures import ThreadPoolExecutor
from collections import deque

REQUEST_TIMEOUT_SECONDS = 60


class OcrEngineError(RuntimeError):
    """Fatal transport/engine failure: do not mark subsequent pages as bad."""


class WindowsOcr:
    def __init__(self, language='ko', recycle_after=250):
        if recycle_after < 1:raise ValueError('OCR recycle interval must be positive')
        self.language=language;self.recycle_after=recycle_after
        self._start()

    def _start(self):
        self.pages=0
        self.process=subprocess.Popen([sys.executable,'-X','utf8',str(Path(__file__).with_name('windows_ocr.py')),self.language],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        try:
            self.responses=queue.Queue()
            process,responses=self.process,self.responses
            def read():
                try:
                    for line in process.stdout: responses.put(line)
                finally:responses.put(None)
            self.reader=threading.Thread(target=read,daemon=True);self.reader.start()
            if not self._response().get('ready'): raise OcrEngineError('OCR 초기화 실패')
        except BaseException:
            self.close();raise

    def _response(self, timeout=None):
        try: line=self.responses.get(timeout=REQUEST_TIMEOUT_SECONDS if timeout is None else timeout)
        except queue.Empty:
            self.close();raise OcrEngineError('OCR 응답 시간 초과')
        if not line:
            diagnostic=self.process.stderr.read(1500) if self.process.poll() is not None else ''
            raise OcrEngineError('Windows OCR 초기화/실행 실패: '+diagnostic)
        result=json.loads(line)
        if result.get('error'): raise RuntimeError(result['error'])
        return result

    def __call__(self,path):
        return self._request({'path':str(Path(path).resolve())})

    def recognize_png(self, png):
        if not isinstance(png, bytes) or not 0 < len(png) <= 32*1024*1024:
            raise ValueError('OCR 이미지 크기가 허용 범위를 벗어났습니다.')
        return self._request({'png':base64.b64encode(png).decode('ascii')})

    def _request(self, request):
        if self.process.poll() is not None:raise OcrEngineError('Windows OCR 프로세스가 종료되었습니다.')
        if self.pages >= self.recycle_after:
            try:self.close();self._start()
            except Exception as error:
                raise OcrEngineError('Windows OCR 실행기를 다시 준비하지 못했습니다. 완료한 페이지는 보존됩니다.') from error
        deadline=time.monotonic()+REQUEST_TIMEOUT_SECONDS
        sent=queue.Queue(maxsize=1)
        def send():
            try:
                self.process.stdin.write(json.dumps(request)+'\n');self.process.stdin.flush()
            except (OSError,ValueError) as error:sent.put(error)
            else:sent.put(None)
        # A full pipe must not block the deadline or the coordinator's cleanup.
        threading.Thread(target=send,daemon=True).start()
        try:
            error=sent.get(timeout=max(0,deadline-time.monotonic()))
        except queue.Empty:
            self.close();raise OcrEngineError('OCR 요청 전송 시간 초과')
        if error is not None:
            self.close()
            raise OcrEngineError('Windows OCR 연결이 끊어졌습니다.') from error
        try:return self._response(timeout=max(0,deadline-time.monotonic()))
        finally:self.pages+=1

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:self.process.kill();self.process.wait()
        reader=getattr(self,'reader',None)
        if reader is not None and reader.ident is not None:reader.join(timeout=2)
        for stream in (self.process.stdin,self.process.stdout,self.process.stderr):
            if stream:
                try:stream.close()
                except OSError:pass


def prepare(db):
    db.executescript('''
      CREATE TABLE IF NOT EXISTS page_ocr(document_id TEXT NOT NULL,page_number INTEGER NOT NULL,signature TEXT NOT NULL,engine TEXT NOT NULL,language TEXT NOT NULL,text_hash TEXT NOT NULL,image_hash TEXT NOT NULL,width INTEGER,height INTEGER,error TEXT,recognized_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(document_id,page_number));
      CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE OF text ON pages BEGIN
        INSERT INTO pages_fts(pages_fts,rowid,text) VALUES('delete',old.id,old.text);
        INSERT INTO pages_fts(rowid,text) VALUES(new.id,new.text);
      END;
    ''')


def recognize_image(recognizer,png,index):
    if hasattr(recognizer,'recognize_png'):
        return recognizer.recognize_png(png)
    # Compatibility for existing file recognizers; production uses memory only.
    with tempfile.TemporaryDirectory(prefix='library-ocr-',dir=resolved_index(index).parent) as temp:
        path=Path(temp)/'page.png';path.write_bytes(png)
        return recognizer(path)


def ocr_work(index, recognize, limit=0, min_free_bytes=8*1024**3, retry_failed=False, should_stop=None, priority='book'):
    engines=list(recognize) if isinstance(recognize,(list,tuple)) else [recognize]
    if len(engines) not in (1,2):raise ValueError('OCR 작업 수는 1 또는 2여야 합니다.')
    if limit<0:raise ValueError('처리 한도는 음수일 수 없습니다.')
    should_stop=should_stop or (lambda:False)
    index_dir=resolved_index(index).parent
    apply_scope(index);db=connect(index);prepare(db)
    counts={'processed':0,'text':0,'empty':0,'errors':0,'stale':0}
    if priority=='identity-first':counts.update(front_back=0,body=0)
    pending=deque();renderer=CachedRenderer()
    pool=ThreadPoolExecutor(max_workers=len(engines),thread_name_prefix='ocr-bridge')
    rows=pending_pages(db,retry_failed,priority,should_stop);finished=False;scheduled=0;reason=None
    last_persist=0
    def persist(force=False):
        nonlocal last_persist
        if force or time.monotonic()-last_persist>=2:
            write_state(index,'ocr','running',counts);last_persist=time.monotonic()
    def record(row,image,result=None,error=None):
        outcome=save_page(db,row,image,result,error)
        if priority=='identity-first':counts['front_back' if row['page_number']<=12 or row['page_number']>max(12,row['page_count']-8) else 'body']+=1
        counts[outcome]+=1;counts['processed']+=1;persist()
        if counts['processed']%20==0:print(json.dumps(counts),flush=True)
    try:
        persist(True)
        while pending or not finished:
            if shutil.disk_usage(index_dir).free<min_free_bytes:
                reason='low_disk';raise RuntimeError('OCR 저장 공간이 부족합니다. 완료한 페이지는 보존됩니다.')
            if should_stop():reason='requested_stop';finished=True
            while not finished and len(pending)<len(engines):
                if limit and counts['processed']+len(pending)>=limit:
                    reason='batch_limit';finished=True;break
                if should_stop():reason='requested_stop';finished=True;break
                try:row=next(rows)
                except StopIteration:
                    finished=True
                    if should_stop():reason='requested_stop'
                    break
                status=source_status(row)
                if status:
                    mark_source_stale(db,row,status)
                    counts['stale']+=1;counts['processed']+=1;persist();continue
                if not current_page(db,row):
                    counts['stale']+=1;counts['processed']+=1;persist();continue
                try:image=renderer.render(row)
                except Exception as error:
                    if is_resource_error(error):raise OcrEngineError('OCR 이미지 처리 자원이 부족합니다.') from error
                    renderer.close();record(row,None,error=error);continue
                engine=engines[scheduled%len(engines)];scheduled+=1
                future=pool.submit(recognize_image,engine,image['png'],index)
                pending.append((row,image,future))
            if pending:
                row,image,future=pending.popleft()
                try:
                    result=future.result()
                except (OcrEngineError,BrokenPipeError,queue.Empty):raise
                except Exception as error:
                    if is_resource_error(error):raise OcrEngineError('OCR 처리 자원이 부족합니다.') from error
                    record(row,image,error=error)
                else:
                    # Database/storage failures are fatal, never OCR page errors.
                    try:
                        if len(str(result.get('text','')))>100000:raise ValueError('OCR 페이지 결과 길이 초과')
                    except (AttributeError,ValueError) as error:record(row,image,error=error)
                    else:record(row,image,result=result)
        write_state(index,'ocr','paused' if reason else 'completed',counts,reason)
        return counts
    except BaseException:
        try:write_state(index,'ocr','paused' if reason=='low_disk' else 'failed',counts,reason or 'interrupted')
        except Exception as state_error:
            print('Could not publish OCR failure state: '+str(state_error),file=sys.stderr,flush=True)
        raise
    finally:
        pool.shutdown(wait=True,cancel_futures=True)
        renderer.close();db.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--index',required=True);parser.add_argument('--language',default='ko');parser.add_argument('--limit',type=int,default=0);parser.add_argument('--retry-failed',action='store_true');parser.add_argument('--min-free-gb',type=float,default=8)
    parser.add_argument('--workers',type=int,choices=(1,2),default=1)
    parser.add_argument('--priority',choices=('book','identity-first'),default='book')
    parser.add_argument('--stop',action='store_true')
    args=parser.parse_args()
    if args.stop:
        print(json.dumps({'stopRequestedForPid':request_stop(args.index,'ocr')}));sys.exit(0)
    engines=[]
    with processing_lock(args.index,'ocr'):
        try:
            try:
                for _ in range(args.workers):engines.append(WindowsOcr(args.language))
            except BaseException:
                write_state(args.index,'ocr','failed',{},'engine_unavailable');raise
            print(json.dumps(ocr_work(args.index,engines,args.limit,int(args.min_free_gb*1024**3),args.retry_failed,lambda:stop_requested(args.index,'ocr'),args.priority)),flush=True)
        finally:
            for engine in engines:engine.close()
