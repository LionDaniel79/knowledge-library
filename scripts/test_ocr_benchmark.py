import importlib.util
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from pdf_library import connect, scan, work
from test_pdf_ocr_pipeline import book_fixture


class BenchmarkTests(unittest.TestCase):
    def test_fixture_is_separate_keeps_exact_page_identity_and_never_overwrites(self):
        self.assertIsNotNone(importlib.util.find_spec('benchmark_pdf_ocr'), 'Isolated benchmark is not implemented')
        from benchmark_pdf_ocr import create_fixture, fingerprints
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'books';root.mkdir();book_fixture(root)
            source=Path(temp)/'source.sqlite';scan(root,source);work(source)
            with closing(connect(source)) as db:
                doc=dict(db.execute('SELECT * FROM documents').fetchone())
                before=db.execute('SELECT count(*) FROM pages').fetchone()[0]
            target=Path(temp)/'sample.sqlite'
            create_fixture(target,[{'document':doc,'pages':[2,3]}])
            with closing(connect(target)) as db:
                self.assertEqual([r[0] for r in db.execute('SELECT page_number FROM pages ORDER BY page_number')],[2,3])
                db.execute("UPDATE pages SET text='sample only'");db.commit()
            with closing(connect(source)) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM pages').fetchone()[0],before)
                self.assertEqual(db.execute("SELECT count(*) FROM pages WHERE text='sample only'").fetchone()[0],0)
            with self.assertRaises(FileExistsError):create_fixture(target,[{'document':doc,'pages':[1]}])
            self.assertEqual(set(fingerprints(target)),{doc['id']+':2',doc['id']+':3'})


if __name__=='__main__':unittest.main()
