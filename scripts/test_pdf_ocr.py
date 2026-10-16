import unittest, tempfile, hashlib, json
from pathlib import Path
from contextlib import closing
from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas
from pdf_library import scan, work, connect
from pdf_ocr import ocr_work
from pdf_job_state import worker_lock


class OcrTests(unittest.TestCase):
    def fixture(self, root, name):
        file=root/name
        image=Image.new('RGB',(800,400),'white'); ImageDraw.Draw(image).text((50,100),'Scanned source evidence',fill='black')
        png=root/'page.png'; image.save(png)
        c=canvas.Canvas(str(file)); c.drawImage(str(png),50,400,width=500,height=250); c.showPage()
        c.drawString(40,700,'Existing native text'); c.save()
        return file

    def test_resumes_without_overwriting_native_text_or_processing_excluded_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'books'; root.mkdir(); index=Path(temp)/'index.sqlite'
            book=self.fixture(root,'book.pdf'); paper=self.fixture(root,'학위논문.pdf')
            original=hashlib.sha256(book.read_bytes()).hexdigest()
            scan(root,index);work(index)
            calls=[]
            def recognize(path):
                calls.append(path);self.assertTrue(Path(path).exists());return {'text':'Scanned source evidence','engine':'fixture','language':'en'}
            first=ocr_work(index,recognize,limit=1,min_free_bytes=0)
            self.assertEqual(first['processed'],1)
            state=json.loads(index.with_suffix('.ocr-status.json').read_text(encoding='utf-8'))
            self.assertEqual(state['status'],'paused')
            self.assertEqual(state['reason'],'batch_limit')
            self.assertEqual(ocr_work(index,recognize,limit=3,min_free_bytes=0)['processed'],0)
            self.assertEqual(json.loads(index.with_suffix('.ocr-status.json').read_text())['status'],'completed')
            with closing(connect(index)) as db:
                rows=db.execute('SELECT page_number,text,method FROM pages ORDER BY page_number').fetchall()
                self.assertEqual(len(rows),2)
                self.assertEqual(rows[0]['method'],'ocr_unverified')
                self.assertEqual(rows[1]['text'],'Existing native text')
                self.assertEqual(rows[1]['method'],'text')
                self.assertEqual(db.execute("SELECT status FROM documents WHERE processing_scope='full'").fetchone()[0],'ocr_review')
                self.assertEqual(db.execute("SELECT count(*) FROM pages_fts WHERE pages_fts MATCH 'Scanned'").fetchone()[0],1)
            self.assertEqual(len(calls),1)
            self.assertEqual(hashlib.sha256(book.read_bytes()).hexdigest(),original)
            self.assertFalse(Path(calls[0]).exists())

    def test_empty_failed_low_disk_and_changed_files_do_not_become_verified_text(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'books';root.mkdir(); index=Path(temp)/'index.sqlite'
            book=self.fixture(root,'book.pdf');scan(root,index);work(index)
            calls=[]
            def empty(path):calls.append(path);return {'text':'','engine':'fixture','language':'ko'}
            with self.assertRaisesRegex(RuntimeError,'공간'):
                ocr_work(index,empty,limit=1,min_free_bytes=10**20)
            state=json.loads(index.with_suffix('.ocr-status.json').read_text(encoding='utf-8'))
            self.assertEqual((state['status'],state['reason']),('paused','low_disk'))
            self.assertEqual(state['counts']['processed'],0)
            self.assertEqual(calls,[])
            ocr_work(index,empty,limit=1,min_free_bytes=0)
            self.assertEqual(ocr_work(index,empty,limit=1,min_free_bytes=0)['processed'],0)
            with closing(connect(index)) as db:
                self.assertEqual(db.execute('SELECT method FROM pages WHERE page_number=1').fetchone()[0],'ocr_empty')
            def changed(path):
                with book.open('ab') as f:f.write(b'\nchanged fixture')
                return {'text':'Must not be saved','engine':'fixture','language':'ko'}
            ocr_work(index,changed,limit=1,min_free_bytes=0,retry_failed=True)
            with closing(connect(index)) as db:
                self.assertNotIn('Must not',db.execute('SELECT text FROM pages WHERE page_number=1').fetchone()[0])
                self.assertEqual(db.execute('SELECT status FROM documents').fetchone()[0],'changed')

    def test_worker_lock_rejects_duplicate_but_releases_after_exit(self):
        with tempfile.TemporaryDirectory() as temp:
            index=Path(temp)/'index.sqlite'
            with worker_lock(index,'ocr'):
                with self.assertRaises(OSError):
                    with worker_lock(index,'ocr'):pass
                with worker_lock(index,'hash'):pass
            with worker_lock(index,'ocr'):pass

    def test_interrupted_work_keeps_durable_failed_state(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'books';root.mkdir();index=Path(temp)/'index.sqlite'
            self.fixture(root,'book.pdf');scan(root,index);work(index)
            def interrupted(path):raise KeyboardInterrupt()
            with self.assertRaises(KeyboardInterrupt):ocr_work(index,interrupted,min_free_bytes=0)
            state=json.loads(index.with_suffix('.ocr-status.json').read_text())
            self.assertEqual((state['status'],state['reason']),('failed','interrupted'))


if __name__=='__main__':unittest.main()
