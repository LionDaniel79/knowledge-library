import unittest
import tempfile
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from pdf_library import connect,signature
from pdf_reocr_store import ReocrStore


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.index=self.root/'index.sqlite';self.pdf=self.root/'book.pdf';self.pdf.write_bytes(b'%PDF original')
        db=connect(self.index);sig=signature(self.pdf.stat())
        for ident,scope,kind in [('book','full','book'),('paper','metadata_only','paper')]:
            db.execute("INSERT INTO documents(id,root,path,relative_path,title,bytes,mtime_ns,signature,page_count,indexed_pages,status,seen,updated_at,processing_scope,material_kind,scope_version) VALUES(?,?,?,?,?,?,?,?,3,3,'ocr_review','','',?,?, 'v')",(ident,str(self.root),str(self.pdf) if ident=='book' else str(self.root/'paper.pdf'),ident+'.pdf',ident,13,str(self.pdf.stat().st_mtime_ns),sig,scope,kind))
            for n,method in [(1,'ocr_unverified'),(2,'text'),(3,'needs_ocr')]:db.execute('INSERT INTO pages(document_id,page_number,text,method) VALUES(?,?,?,?)',(ident,n,'old OCR' if n==1 else 'native text' if n==2 else '',method))
        db.commit();db.close();self.store=ReocrStore(self.index)

    def tearDown(self):self.store.close();self.temp.cleanup()

    def test_snapshot_protects_native_and_excluded_and_candidate_does_not_change_search(self):
        job=self.store.create('owner','all');self.assertEqual(self.store.summary('owner',job)['total'],2)
        row=self.store.next_page('owner',job);self.store.save_candidate('owner',job,row,{'text':'new body','review':[],'profile':'v','lines':[]})
        db=connect(self.index);self.assertEqual(db.execute("SELECT text FROM pages WHERE document_id='book' AND page_number=1").fetchone()[0],'old OCR');db.close()
        self.assertEqual(self.store.summary('owner',job)['counts']['ready'],1)
        self.assertRaises(ValueError,self.store.summary,'other',job)

    def test_apply_restore_and_concurrent_text_change(self):
        job=self.store.create('owner','all');row=self.store.next_page('owner',job)
        self.store.save_candidate('owner',job,row,{'text':'new body','review':[],'profile':'v','lines':[]})
        self.assertEqual(self.store.apply('owner',job),1)
        self.assertEqual(self.store.restore('owner',job),1)
        db=connect(self.index);self.assertEqual(db.execute("SELECT text FROM pages WHERE document_id='book' AND page_number=1").fetchone()[0],'old OCR');db.close()
        self.store.finish('owner',job,'complete');another=self.store.create('owner','all');row=self.store.next_page('owner',another)
        self.store.save_candidate('owner',another,row,{'text':'candidate','review':[],'profile':'v','lines':[]})
        db=connect(self.index);db.execute("UPDATE pages SET text='edited afterwards' WHERE id=?",(row['page_id'],));db.commit();db.close()
        self.assertEqual(self.store.apply('owner',another),0)
        self.assertEqual(self.store.summary('owner',another)['counts']['stale'],1)

    def test_resume_returns_only_unfinished_pages_and_source_change_is_rejected(self):
        job=self.store.create('owner','all');row=self.store.next_page('owner',job)
        self.store.save_candidate('owner',job,row,{'text':'candidate','review':['needs check'],'profile':'v','lines':[]})
        self.store.finish('owner',job,'paused');self.store.start('owner',job)
        self.assertEqual(self.store.next_page('owner',job)['page_number'],3)
        self.pdf.write_bytes(b'changed')
        self.assertRaises(ValueError,self.store.apply,'owner',job)
        self.store.finish('owner',job,'paused')
        self.assertEqual(self.store.apply('owner',job,include_review=True),0)

    def test_confirmed_front_matter_is_removed_from_body_but_preserved_for_metadata_and_restore(self):
        job=self.store.create('owner','all');row=self.store.next_page('owner',job)
        self.store.save_candidate('owner',job,row,{'text':'ISBN 9780306406157','review':['판권'],'profile':'v','lines':[]})
        self.assertEqual(self.store.exclude('owner',job,row['page_id']),1)
        self.assertEqual(self.store.db.execute("SELECT text FROM pages WHERE id=?",(row['page_id'],)).fetchone()[0],'')
        self.assertEqual(self.store.db.execute("SELECT text FROM pages_metadata WHERE document_id='book' AND page_number=1").fetchone()[0],'ISBN 9780306406157')
        self.assertEqual(self.store.restore('owner',job),1)
        self.assertEqual(self.store.db.execute("SELECT text FROM pages WHERE id=?",(row['page_id'],)).fetchone()[0],'old OCR')


if __name__=='__main__':unittest.main()
