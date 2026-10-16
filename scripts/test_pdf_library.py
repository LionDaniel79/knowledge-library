import tempfile, unittest, sqlite3, os
from pathlib import Path
from reportlab.pdfgen import canvas
from pdf_library import scan, index_document, connect

class PdfLibraryTests(unittest.TestCase):
    def test_page_citations_resume_and_changed_file_invalidates_old_text(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'books'; root.mkdir(); pdf=root/'book.pdf'; index=Path(d)/'index.sqlite'
            c=canvas.Canvas(str(pdf)); c.drawString(50,700,'First page evidence'); c.showPage(); c.drawString(50,700,'Second page counsel'); c.save()
            self.assertEqual(scan(root,index)['files'],1)
            db=connect(index); doc=dict(db.execute('select * from documents').fetchone()); db.close()
            index_document(index,doc['id'],page_budget=1)
            db=connect(index); self.assertEqual(db.execute('select indexed_pages from documents').fetchone()[0],1); db.close()
            index_document(index,doc['id'],page_budget=10)
            db=connect(index); rows=db.execute('select page_number,text from pages order by page_number').fetchall(); self.assertEqual(len(rows),2); self.assertIn('Second page counsel',rows[1]['text']); db.close()
            self.assertEqual(scan(root,index)['files'],1)
            c=canvas.Canvas(str(pdf)); c.drawString(50,700,'Changed evidence'); c.save()
            scan(root,index); db=connect(index); self.assertEqual(db.execute('select count(*) from pages').fetchone()[0],0); self.assertEqual(db.execute('select indexed_pages from documents').fetchone()[0],0); db.close()

    def test_broken_pdf_does_not_abort_inventory_or_fabricate_pages(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'books'; root.mkdir(); (root/'broken.pdf').write_bytes(b'not a PDF')
            index=Path(d)/'index.sqlite'; scan(root,index); db=connect(index); doc=dict(db.execute('select * from documents').fetchone()); db.close()
            index_document(index,doc['id'])
            db=connect(index); self.assertEqual(db.execute('select status from documents').fetchone()[0],'error'); self.assertEqual(db.execute('select count(*) from pages').fetchone()[0],0); db.close()

if __name__=='__main__': unittest.main()
