"""Local-only quality OCR batch. CLI works even when the cloud DB is unavailable."""
import argparse
import json
import math
import os
from pathlib import Path
import shutil
import sys
import time
import sqlite3
import threading
from contextlib import contextmanager
import pypdfium2 as pdfium
from pdf_job_state import processing_lock, resolved_index
from pdf_ocr import WindowsOcr, OcrEngineError
from pdf_ocr_store import is_resource_error
from pdf_ocr_quality import recognize_body, repeated_margins, probe, deskew
from pdf_reocr_store import ReocrStore


@contextmanager
def heartbeat(index,owner,job):
    stop=threading.Event()
    def update():
        while not stop.wait(10):
            try:
                db=sqlite3.connect(index,timeout=2)
                try:db.execute("UPDATE reocr_jobs SET updated=? WHERE id=? AND owner=? AND state IN ('running','applying','restoring')",(time.time(),job,owner));db.commit()
                finally:db.close()
            except sqlite3.Error:pass
    thread=threading.Thread(target=update,daemon=True);thread.start()
    try:yield
    finally:stop.set();thread.join(timeout=3)


class QualityRenderer:
    def __init__(self):self.pdf=None;self.path=None
    def render(self,row,page_number=None):
        path=row['path']
        if path!=self.path:
            self.close();self.pdf=pdfium.PdfDocument(path);self.path=path
        page=self.pdf[(page_number or row['page_number'])-1]
        try:
            width,height=page.get_size();scale=min(300/72,math.sqrt(24_000_000/max(1,width*height)))
            bitmap=page.render(scale=scale)
            try:return bitmap.to_pil().convert('RGB')
            finally:bitmap.close()
        finally:page.close()
    def close(self):
        if self.pdf:self.pdf.close()
        self.pdf=self.path=None


def run_batch(index,owner,job,recognize,renderer=None,min_free_bytes=2*1024**3):
    store=ReocrStore(index);renderer=renderer or QualityRenderer();margins={};last_beat=0;acquired=False
    try:
        with processing_lock(index,'ocr'),heartbeat(index,owner,job):
            acquired=True
            store.start(owner,job);store.initialize(owner,job)
            while True:
                if store.required(owner,job)['pause']:
                    store.finish(owner,job,'paused');break
                if shutil.disk_usage(resolved_index(index).parent).free<min_free_bytes:
                    store.finish(owner,job,'paused','색인 저장 공간 부족');break
                row=store.next_page(owner,job)
                if not row:store.finish(owner,job,'complete');break
                if row.get('stale_selection'):continue
                if not store.source_current(row):store.mark(owner,job,row,'stale','원본 변경·분리');continue
                try:
                    if row['document_id'] not in margins:
                        probes=[]
                        # Broadly separated probes prevent deleting a one-off title.
                        # Avoid covers/prefaces/end advertisements, which do
                        # not describe the body's odd/even running titles.
                        anchors=[max(1,row['page_count']//4),max(1,row['page_count']//2),max(1,3*row['page_count']//4)]
                        positions=sorted({min(row['page_count'],n+delta) for n in anchors for delta in (0,1)})
                        for n in positions:
                            if store.required(owner,job)['pause']:break
                            image=renderer.render(row,n)
                            prepared,angle=deskew(image);image.close()
                            try:
                                lines,meta=probe(prepared,recognize)
                                if abs(float(meta.get('textAngle') or 0))<=1:
                                    probes.append([{**line,'box':[x*1000/prepared.height for x in line['box']]} for line in lines])
                            finally:prepared.close()
                        margins[row['document_id']]=repeated_margins(probes,1000)
                    if store.required(owner,job)['pause']:
                        store.finish(owner,job,'paused');break
                    image=renderer.render(row)
                    try:result=recognize_body(image,recognize,margins[row['document_id']],row['old_text'])
                    finally:image.close()
                    # The atomic store checks source, active text and method again.
                    store.save_candidate(owner,job,row,result)
                except (OcrEngineError,BrokenPipeError,MemoryError):raise
                except Exception as error:
                    if is_resource_error(error):raise
                    store.mark(owner,job,row,'error','이미지·OCR 처리 실패: 원본과 실행기를 확인하세요.')
                if time.monotonic()-last_beat>2:store.heartbeat(owner,job);last_beat=time.monotonic()
    except BaseException:
        try:
            if acquired or store.required(owner,job)['state'] not in ('running','applying','restoring'):store.finish(owner,job,'failed','작업 중단: 기존 결과는 보존됩니다. 이어서 진행해 주세요.')
        except Exception:pass
        raise
    finally:renderer.close();store.close()


def run_application(index,owner,job,mode):
    store=ReocrStore(index);acquired=False
    try:
        with processing_lock(index,'ocr'),heartbeat(index,owner,job):
            acquired=True;store.start(owner,job,mode=mode)
            while True:
                if store.required(owner,job)['pause']:store.finish(owner,job,'paused');break
                state='ready' if mode=='applying' else 'applied'
                row=store.db.execute('SELECT page_id FROM reocr_pages WHERE job=? AND state=? ORDER BY document_id,page_number LIMIT 1',(job,state)).fetchone()
                if not row:store.finish(owner,job,'complete');break
                count=store.apply(owner,job,page_id=row['page_id']) if mode=='applying' else store.restore(owner,job,page_id=row['page_id'])
                # Empty outputs are review-only, never repeatedly selected.
                if not count:
                    store.db.execute("UPDATE reocr_pages SET state='review' WHERE job=? AND page_id=? AND state='ready'",(job,row['page_id']));store.db.commit()
                store.heartbeat(owner,job)
    except BaseException:
        if acquired:store.finish(owner,job,'failed','반영·복원 중단: 완료한 페이지부터 보존됩니다.')
        raise
    finally:store.close()


def control(index,owner,p):
    store=ReocrStore(index)
    try:
        action=p['action'];job=p.get('id')
        if action=='create':job=store.create(owner,p.get('scope','all'),bool(p.get('sample')),defer=True)
        elif action=='pause':store.pause(owner,job)
        elif action=='retry':store.queue(owner,job,'running',retry=True)
        elif action=='startup_failed':
            current=store.required(owner,job)
            if current['state'] in ('queued','paused'):store.finish(owner,job,'failed','PC OCR 작업자를 시작하지 못했습니다.')
        elif action=='discard':
            current=store.required(owner,job)
            if current['state'] in ('running','applying','restoring','queued') and time.time()-current['updated']<120:raise ValueError('먼저 일시 중지해 주세요.')
            store.finish(owner,job,'complete')
        elif action in ('apply','restore','exclude'):
            # Same disk reservation as OCR/hash workers, with an atomic SQLite
            # transaction for each page's search text + provenance + checkpoint.
            if p.get('pageId') is None:raise ValueError('전체 반영·복원은 백그라운드 작업을 사용하세요.')
            with processing_lock(index,'ocr'):
                if action=='apply':store.apply(owner,job,p.get('includeReview',False),p.get('pageId'))
                elif action=='exclude':store.exclude(owner,job,p.get('pageId'))
                else:store.restore(owner,job,p.get('pageId'))
        elif action not in ('status','resume','apply_all','restore_all'):raise ValueError('지원하지 않는 작업입니다.')
        if action in ('apply_all','restore_all'):
            store.queue(owner,job,'applying' if action=='apply_all' else 'restoring')
        if action=='resume':store.queue(owner,job)
        return store.summary(owner,job,int(p.get('page',1)))
    finally:store.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['control','work','apply','restore']);parser.add_argument('--index',required=True);parser.add_argument('--owner');parser.add_argument('--job');args=parser.parse_args()
    try:
        if not args.owner:
            try:args.owner=json.loads(Path(str(args.index)+'.connection.json').read_text(encoding='utf-8')).get('owner')
            except (OSError,ValueError):raise ValueError('PC 폴더 연결 설정이 없으면 --owner에 기존 서재의 계정 ID를 지정해 주세요.')
            if not isinstance(args.owner,str) or not 0<len(args.owner)<=128:raise ValueError('서재 소유자 설정을 확인하세요.')
        if args.action=='control':
            request=json.loads(sys.stdin.readline());print(json.dumps(control(args.index,args.owner,request),ensure_ascii=False),flush=True)
        elif args.action=='work':
            engine=WindowsOcr('ko')
            try:run_batch(args.index,args.owner,args.job,engine.recognize_png)
            finally:engine.close()
        else:run_application(args.index,args.owner,args.job,'applying' if args.action=='apply' else 'restoring')
    except Exception as e:
        if args.action!='control' and args.job:
            try:
                state=ReocrStore(args.index)
                current=state.required(args.owner,args.job)
                if current['state'] in ('queued','paused','failed'):state.finish(args.owner,args.job,'failed','OCR 실행기를 준비하지 못했습니다.')
                state.close()
            except Exception:pass
        message=str(e) if isinstance(e,ValueError) else 'OCR 설정·잠금·원본 연결을 확인해 주세요.'
        print(json.dumps({'error':message[:200]},ensure_ascii=False),flush=True);sys.exit(1)
