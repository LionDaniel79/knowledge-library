import unittest, tempfile
from pathlib import Path
from reportlab.pdfgen import canvas
from pdf_library import scan, index_document, connect, work, apply_scope


class PdfScopeTests(unittest.TestCase):
    def test_papers_and_periodicals_keep_only_basic_metadata_but_expositions_and_commentaries_are_indexed(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / 'books'; root.mkdir()
            index = Path(d) / 'index.sqlite'
            names = ['소설/일반도서.pdf', '신학지남 1918-2011/성경 연구.pdf',
                     '로마서 강해.pdf', '박사학위논문/상담 연구.pdf',
                     '1. 논문관련책, 아티클/상담 이론.pdf', '성경주석/요한복음.pdf',
                     '간행물/목회와신학 2026년 10월.pdf']
            for name in names:
                file = root / name; file.parent.mkdir(parents=True, exist_ok=True)
                c = canvas.Canvas(str(file)); c.setAuthor('Sample author')
                c.drawString(40, 700, 'PRIVATE FULLTEXT MUST NOT BE INDEXED FOR EXCLUSIONS'); c.save()
            scan(root, index)
            # A direct call must obey scope, not just the worker queue.
            db = connect(index); ids = [r['id'] for r in db.execute('SELECT id FROM documents')]; db.close()
            for id in ids: index_document(index, id)
            work(index)
            db = connect(index)
            self.assertEqual(db.execute('SELECT count(*) FROM documents').fetchone()[0], 7)
            self.assertEqual(db.execute('SELECT count(*) FROM pages').fetchone()[0], 3)
            excluded = db.execute("SELECT * FROM documents WHERE processing_scope='metadata_only'").fetchall()
            self.assertEqual(len(excluded), 4)
            self.assertTrue(all(r['author'] == 'Sample author' and r['page_count'] == 1 for r in excluded))
            self.assertTrue(all(r['toc'] == '[]' and r['indexed_pages'] == 0 for r in excluded))
            self.assertEqual(sum(r['material_kind'] == 'review' for r in excluded), 1)
            db.close()

    def test_reclassification_preserves_original_and_archived_text_but_worker_skips_it(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / 'books'; root.mkdir(); file = root / '간행물.pdf'
            c = canvas.Canvas(str(file)); c.drawString(40, 700, 'Previously extracted text'); c.save()
            original = file.read_bytes(); index = Path(d) / 'index.sqlite'
            scan(root, index); db = connect(index)
            row = db.execute('SELECT id FROM documents').fetchone()
            db.execute("INSERT INTO pages(document_id,page_number,text,method) VALUES(?,1,'Archived excerpt','text')", (row['id'],))
            db.execute("UPDATE documents SET status='indexing',indexed_pages=1"); db.commit(); db.close()
            work(index)
            db = connect(index)
            self.assertEqual(db.execute('SELECT indexed_pages FROM documents').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT text FROM pages').fetchone()[0], 'Archived excerpt')
            db.close(); self.assertEqual(file.read_bytes(), original)

    def test_scope_correction_restarts_previously_metadata_only_commentary(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / 'books'; root.mkdir(); file = root / '로마서 강해.pdf'
            c = canvas.Canvas(str(file)); c.drawString(40, 700, 'Romans exposition is an included book'); c.save()
            index = Path(d) / 'index.sqlite'; scan(root, index)
            db = connect(index)
            db.execute("UPDATE documents SET processing_scope='metadata_only',material_kind='exposition',status='metadata_only',scope_version='old'"); db.commit(); db.close()
            apply_scope(index); work(index)
            db = connect(index)
            row = db.execute('SELECT processing_scope,status FROM documents').fetchone()
            text = db.execute('SELECT text FROM pages').fetchone()[0]; db.close()
            self.assertEqual(tuple(row), ('full','ready'))
            self.assertIn('Romans exposition',text)


if __name__ == '__main__': unittest.main()
