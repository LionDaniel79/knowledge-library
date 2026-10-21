import unittest
import tempfile
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from PIL import Image
from pdf_library import connect,signature
from pdf_reocr_store import ReocrStore
from pdf_reocr import run_batch,run_application
from pdf_ocr import OcrEngineError
from pdf_job_state import processing_lock

class Renderer:
    def render(self,row,page_number=None):return Image.new('RGB',(700,1000),'white')
    def close(self):pass

class BatchTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.index=self.root/'index.sqlite';pdf=self.root/'book.pdf';pdf.write_bytes(b'%PDF fixture')
        db=connect(self.index);s=pdf.stat();db.execute("INSERT INTO documents(id,root,path,relative_path,title,bytes,mtime_ns,signature,page_count,indexed_pages,status,seen,updated_at,processing_scope,material_kind,scope_version) VALUES('book',?,?,?,'Book',?,?,?,3,3,'ocr_review','','','full','book','v')",(str(self.root),str(pdf),'book.pdf',s.st_size,str(s.st_mtime_ns),signature(s)))
        for n,method,text in [(1,'ocr_unverified','old OCR'),(2,'text','native'),(3,'needs_ocr','')]:db.execute('INSERT INTO pages(document_id,page_number,text,method) VALUES(\'book\',?,?,?)',(n,text,method))
        db.commit();db.close();self.store=ReocrStore(self.index);self.job=self.store.create('owner','all',defer=True)
    def tearDown(self):self.store.close();self.temp.cleanup()
    def test_worker_keeps_old_search_results_until_explicit_batch_apply_and_can_restore(self):
        recognize=lambda png:{'text':'new body','lines':[{'text':'new body','box':[50,200,300,25]}],'textAngle':0}
        run_batch(self.index,'owner',self.job,recognize,Renderer(),0)
        status=self.store.summary('owner',self.job);self.assertEqual(status['job']['state'],'complete');self.assertEqual(status['counts']['ready'],2)
        self.assertEqual(self.store.db.execute('SELECT text FROM pages WHERE page_number=1').fetchone()[0],'old OCR')
        run_application(self.index,'owner',self.job,'applying')
        self.assertEqual(self.store.db.execute('SELECT text FROM pages WHERE page_number=1').fetchone()[0],'new body')
        self.assertEqual(self.store.db.execute('SELECT text FROM pages WHERE page_number=2').fetchone()[0],'native')
        run_application(self.index,'owner',self.job,'restoring')
        self.assertEqual(self.store.db.execute('SELECT text FROM pages WHERE page_number=1').fetchone()[0],'old OCR')
    def test_engine_transport_failure_stops_without_marking_all_pages_bad(self):
        def broken(png):raise OcrEngineError('engine failed')
        self.assertRaises(OcrEngineError,run_batch,self.index,'owner',self.job,broken,Renderer(),0)
        status=self.store.summary('owner',self.job);self.assertEqual(status['job']['state'],'failed');self.assertEqual(status['counts']['pending'],2);self.assertNotIn('error',status['counts'])
    def test_duplicate_worker_cannot_take_the_disk_lock_or_clobber_running_status(self):
        self.store.start('owner',self.job)
        with processing_lock(self.index,'ocr'):
            self.assertRaises(OSError,run_batch,self.index,'owner',self.job,lambda _: {},Renderer(),0)
        self.assertEqual(self.store.required('owner',self.job)['state'],'running')

if __name__=='__main__':unittest.main()
