import io, json, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image, ImageDraw
import pdf_job_state
from pdf_ocr import WindowsOcr, ocr_work, OcrEngineError
from pdf_ocr_store import source_status
from test_pdf_ocr_pipeline import book_fixture
from pdf_library import scan, work, connect


class RecoveryTests(unittest.TestCase):
    def test_recycle_resource_failure_is_fatal_not_a_bad_page(self):
        engine=WindowsOcr('ko',recycle_after=1)
        try:
            engine.pages=1
            with tempfile.TemporaryDirectory() as temp:
                root=Path(temp)/'books';root.mkdir();index=Path(temp)/'index.sqlite'
                book_fixture(root,pages=1);scan(root,index);work(index)
                with patch.object(engine,'_start',side_effect=OSError(1450,'resource unavailable')):
                    with self.assertRaises(OcrEngineError):ocr_work(index,engine,min_free_bytes=0)
                db=connect(index)
                try:self.assertEqual(db.execute("SELECT method FROM pages").fetchone()[0],'needs_ocr')
                finally:db.close()
                self.assertEqual(json.loads(index.with_suffix('.ocr-status.json').read_text())['status'],'failed')
        finally:engine.close()

    def test_resource_exhaustion_does_not_mark_source_changed(self):
        error=OSError('resource unavailable');error.winerror=1450
        with patch.object(Path,'resolve',side_effect=error):
            with self.assertRaises(OSError):source_status({'path':'source.pdf','root':'.','signature':'unchanged'})

    def test_status_does_not_resolve_index_again_after_lock_acquisition(self):
        with tempfile.TemporaryDirectory() as temp:
            index=Path(temp)/'index.sqlite'
            with pdf_job_state.processing_lock(index,'ocr'):
                with patch.object(Path,'resolve',side_effect=OSError(1450,'resource unavailable')):
                    pdf_job_state.write_state(index,'ocr','running',{'processed':1})
                    self.assertFalse(pdf_job_state.stop_requested(index,'ocr'))
            self.assertEqual(json.loads(index.with_suffix('.ocr-status.json').read_text())['counts']['processed'],1)

    def test_failed_status_write_preserves_original_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'books';root.mkdir();index=Path(temp)/'index.sqlite'
            book_fixture(root);scan(root,index);work(index)
            def fail(path):raise KeyboardInterrupt('original interruption')
            real=pdf_job_state.write_state
            def state(*args,**kwargs):
                if args[2]=='failed':raise OSError('status unavailable')
                return real(*args,**kwargs)
            with patch('pdf_ocr.write_state',side_effect=state):
                with self.assertRaisesRegex(KeyboardInterrupt,'original interruption'):
                    ocr_work(index,fail,min_free_bytes=0)

    def test_engine_recycles_after_bounded_pages_without_losing_result(self):
        image=Image.new('RGB',(800,250),'white');ImageDraw.Draw(image).text((30,60),'OCR evidence 123',fill='black')
        out=io.BytesIO();image.save(out,format='PNG');image.close()
        engine=WindowsOcr('ko',recycle_after=2)
        try:
            first=engine.process
            a=engine.recognize_png(out.getvalue());b=engine.recognize_png(out.getvalue())
            self.assertEqual(first.pid,engine.process.pid)
            c=engine.recognize_png(out.getvalue())
            self.assertNotEqual(first.pid,engine.process.pid)
            self.assertIsNotNone(first.poll())
            self.assertEqual(a,b);self.assertEqual(b,c)
        finally:engine.close()

if __name__=='__main__':unittest.main()
