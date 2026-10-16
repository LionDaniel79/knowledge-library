import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import closing, suppress

from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas
import pypdfium2 as pdfium
import pdf_ocr
import pdf_job_state
from pdf_library import scan, work, connect


def book_fixture(root, name='book.pdf', pages=3):
    image = Image.new('RGB', (800, 400), 'white')
    ImageDraw.Draw(image).text((20, 40), 'Scanned source evidence', fill='black')
    png = root / 'fixture.png'
    image.save(png)
    path = root / name
    pdf = canvas.Canvas(str(path), pagesize=(400, 300))
    for number in range(pages):
        pdf.drawImage(str(png), 10, 50, width=380, height=190)
        pdf.setFillColorRGB(number%2,0,0)
        pdf.rect(10,10,20,10,fill=1,stroke=0)
        pdf.showPage()
    pdf.save()
    return path


class RenderTransportTests(unittest.TestCase):
    def renderer_class(self):
        self.assertIsNotNone(importlib.util.find_spec('pdf_ocr_pipeline'), 'Missing cached memory renderer')
        from pdf_ocr_pipeline import CachedRenderer
        return CachedRenderer

    def test_cache_reuses_book_and_closes_on_switch_without_changing_pixels(self):
        cls = self.renderer_class()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = book_fixture(root)
            second = book_fixture(root, 'second.pdf')
            opened = []
            real = pdfium.PdfDocument
            def tracking(*args, **kwargs):
                doc = real(*args, **kwargs)
                opened.append(doc)
                return doc
            with patch('pypdfium2.PdfDocument', side_effect=tracking):
                renderer = cls()
                try:
                    one = renderer.render({'path':str(first), 'page_number':1})
                    two = renderer.render({'path':str(first), 'page_number':2})
                    self.assertEqual(len(opened), 1, 'Each page reopened the same book')
                    renderer.render({'path':str(second), 'page_number':1})
                    self.assertIsNone(opened[0].raw)
                finally:
                    renderer.close()
                self.assertIsNone(opened[-1].raw)
            with real(str(first)) as doc:
                page = doc[0]
                bitmap = page.render(scale=3)
                try:
                    original = bitmap.to_pil().convert('RGB')
                    decoded = Image.open(io.BytesIO(one['png'])).convert('RGB')
                    self.assertEqual(decoded.size, (1200,900))
                    self.assertEqual(decoded.tobytes(), original.tobytes())
                    self.assertNotEqual(one['png'],two['png'])
                    original.close(); decoded.close()
                finally:
                    bitmap.close(); page.close()

    @unittest.skipUnless(sys.platform == 'win32', 'Windows OCR integration')
    def test_memory_transport_matches_file_transport_and_rejects_oversized_input(self):
        self.assertTrue(hasattr(pdf_ocr.WindowsOcr, 'recognize_png'), 'Memory transport is not implemented')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = Image.new('RGB',(1200,300),'white')
            from PIL import ImageFont
            font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf',48)
            ImageDraw.Draw(image).text((40,70),'Evidence page 123',font=font,fill='black')
            path = root/'sample.png';image.save(path)
            engine = pdf_ocr.WindowsOcr('ko')
            self.addCleanup(engine.close)
            legacy = engine(path)
            memory = engine.recognize_png(path.read_bytes())
            self.assertIn('123',legacy['text'])
            self.assertEqual(memory,legacy)
            with self.assertRaises(ValueError):engine.recognize_png(b'x'*(32*1024*1024+1))
            self.assertEqual(engine.recognize_png(path.read_bytes()),legacy)

    @unittest.skipUnless(sys.platform == 'win32', 'Windows OCR integration')
    def test_dead_engine_is_fatal_not_an_empty_page(self):
        self.assertTrue(hasattr(pdf_ocr,'OcrEngineError'), 'Fatal engine error is not distinguished')
        engine = pdf_ocr.WindowsOcr('ko')
        self.addCleanup(engine.close)
        engine.process.terminate();engine.process.wait(timeout=5)
        with self.assertRaises(pdf_ocr.OcrEngineError):
            engine.recognize_png(b'png')


class CoordinatorTests(unittest.TestCase):
    def fixture(self, temp):
        root=Path(temp)/'books';root.mkdir()
        source=book_fixture(root,pages=3)
        index=Path(temp)/'index.sqlite'
        scan(root,index);work(index)
        return source,index

    def test_two_recognizers_overlap_keep_evidence_mapping_and_resume_limit(self):
        with tempfile.TemporaryDirectory() as temp:
            source,index=self.fixture(temp)
            gate=threading.Barrier(2);guard=threading.Lock();calls=[]
            class Engine:
                def recognize_png(self,png):
                    with guard:
                        position=len(calls);calls.append(hashlib.sha256(png).hexdigest())
                    if position<2:gate.wait(timeout=5)
                    if position==0:time.sleep(.03)
                    with Image.open(io.BytesIO(png)) as decoded:
                        label='page-'+str(decoded.getpixel((45,855))[0])
                    return {'text':label,'engine':'fixture','language':'ko'}
            original=hashlib.sha256(source.read_bytes()).hexdigest()
            with closing(connect(index)) as db:
                db.execute('UPDATE documents SET text_pages=999');db.commit()
            with patch('pdf_ocr.tempfile.TemporaryDirectory',side_effect=AssertionError('Memory route wrote a temp PNG')):
                result=pdf_ocr.ocr_work(index,[Engine(),Engine()],limit=2,min_free_bytes=0)
            self.assertEqual(result['text'],2)
            self.assertEqual(len(calls),2)
            with closing(connect(index)) as db:
                records=db.execute('SELECT p.page_number,p.text,o.image_hash FROM pages p JOIN page_ocr o ON o.document_id=p.document_id AND o.page_number=p.page_number').fetchall()
                self.assertEqual(len(records),2)
                self.assertEqual({row['page_number']:row['text'] for row in records},{1:'page-0',2:'page-255'})
                self.assertEqual({row['image_hash'] for row in records},set(calls))
                self.assertEqual(db.execute('SELECT text_pages FROM documents').fetchone()[0],2)
                self.assertEqual(db.execute("SELECT count(*) FROM pages WHERE method='needs_ocr'").fetchone()[0],1)
            self.assertEqual(pdf_ocr.ocr_work(index,Engine(),min_free_bytes=0)['processed'],1)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),original)

    def test_fatal_engine_leaves_pages_pending_and_durable_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            _,index=self.fixture(temp)
            class Engine:
                def __call__(self,path):return self.recognize_png(Path(path).read_bytes())
                def recognize_png(self,png):raise pdf_ocr.OcrEngineError('engine gone')
            with self.assertRaises(pdf_ocr.OcrEngineError):
                pdf_ocr.ocr_work(index,Engine(),min_free_bytes=0)
            with closing(connect(index)) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM pages WHERE method='needs_ocr'").fetchone()[0],3)
                self.assertEqual(db.execute('SELECT count(*) FROM page_ocr').fetchone()[0],0)
            self.assertEqual(json.loads(index.with_suffix('.ocr-status.json').read_text())['status'],'failed')

    def test_nonreading_engine_times_out_preserves_pages_and_releases_disk_lock(self):
        child=subprocess.Popen(
            [sys.executable,'-u','-c','import time; print(\'{"ready":true}\', flush=True); time.sleep(120)'],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            text=True,encoding='utf-8',creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        # Keep a broken implementation bounded without satisfying the deadline assertion.
        watchdog_fired=threading.Event()
        def rescue():
            watchdog_fired.set()
            if child.poll() is None:child.kill()
        watchdog=threading.Timer(3,rescue)
        engine=None
        try:
            with patch('pdf_ocr.subprocess.Popen',return_value=child):
                engine=pdf_ocr.WindowsOcr()
            class LargeRequest:
                def recognize_png(self,png):return engine.recognize_png(b'x'*(2*1024*1024))
            with tempfile.TemporaryDirectory() as temp:
                _,index=self.fixture(temp)
                watchdog.start()
                with patch('pdf_ocr.REQUEST_TIMEOUT_SECONDS',.15,create=True):
                    with self.assertRaisesRegex(pdf_ocr.OcrEngineError,'시간 초과'):
                        with pdf_job_state.processing_lock(index,'ocr'):
                            pdf_ocr.ocr_work(index,LargeRequest(),min_free_bytes=0)
                self.assertFalse(watchdog_fired.is_set(),'Blocked transmission escaped the request deadline')
                self.assertIsNotNone(child.poll(),'Timed-out child must be terminated')
                with pdf_job_state.processing_lock(index,'hash'):pass
                with closing(connect(index)) as db:
                    self.assertEqual(db.execute("SELECT count(*) FROM pages WHERE method='needs_ocr'").fetchone()[0],3)
                    self.assertEqual(db.execute('SELECT count(*) FROM page_ocr').fetchone()[0],0)
                self.assertEqual(json.loads(index.with_suffix('.ocr-status.json').read_text())['status'],'failed')
        finally:
            watchdog.cancel()
            if child.poll() is None:child.kill();child.wait(timeout=5)
            if engine:
                with suppress(OSError):engine.close()

    def test_scope_change_during_failed_recognition_does_not_write_error_audit(self):
        with tempfile.TemporaryDirectory() as temp:
            _,index=self.fixture(temp)
            class Engine:
                def __call__(self,path):return self.recognize_png(Path(path).read_bytes())
                def recognize_png(self,png):
                    with closing(connect(index)) as db:
                        db.execute("UPDATE documents SET processing_scope='metadata_only',scope_override=1");db.commit()
                    raise ValueError('recognition failed after exclusion')
            pdf_ocr.ocr_work(index,Engine(),limit=1,min_free_bytes=0)
            with closing(connect(index)) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM page_ocr').fetchone()[0],0)
                self.assertEqual(db.execute("SELECT count(*) FROM pages WHERE method='needs_ocr'").fetchone()[0],3)

    def test_stop_request_drains_bounded_work_and_is_pid_scoped(self):
        self.assertTrue(hasattr(pdf_job_state,'request_stop'), 'Graceful stop request not implemented')
        with tempfile.TemporaryDirectory() as temp:
            _,index=self.fixture(temp)
            stopped=threading.Event()
            class Engine:
                def recognize_png(self,png):stopped.set();return {'text':'saved','engine':'fixture','language':'ko'}
            result=pdf_ocr.ocr_work(index,[Engine(),Engine()],min_free_bytes=0,should_stop=stopped.is_set)
            self.assertIn(result['processed'],(1,2))
            state=json.loads(index.with_suffix('.ocr-status.json').read_text())
            self.assertEqual((state['status'],state['reason']),('paused','requested_stop'))
            pdf_job_state.write_state(index,'ocr','running',{})
            pid=pdf_job_state.request_stop(index,'ocr')
            self.assertTrue(pdf_job_state.stop_requested(index,'ocr',pid))
            self.assertFalse(pdf_job_state.stop_requested(index,'ocr',pid+1))

    def test_hash_and_ocr_cannot_hold_processing_disk_at_the_same_time(self):
        self.assertTrue(hasattr(pdf_job_state,'processing_lock'), 'Disk scheduling lock not implemented')
        with tempfile.TemporaryDirectory() as temp:
            index=Path(temp)/'index.sqlite'
            with pdf_job_state.processing_lock(index,'ocr'):
                with self.assertRaises(OSError):
                    with pdf_job_state.processing_lock(index,'hash'):pass
            with pdf_job_state.processing_lock(index,'hash'):pass


if __name__ == '__main__':unittest.main()
