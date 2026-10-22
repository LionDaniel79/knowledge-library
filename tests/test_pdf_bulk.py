import json
import os
import tempfile
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import pdf_bulk


class BulkTests(unittest.TestCase):
    def test_new_index_reads_identification_and_searchable_text_without_changing_source(self):
        try:
            import pypdfium2
        except ImportError:
            self.skipTest('Install scripts/requirements-pdf.txt for PDF extraction tests')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'books'
            root.mkdir()
            # Real minimal PDF with an ISBN text object (no network/AI/user files).
            objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
                       b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 700] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
                       b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
            text = b'BT /F1 16 Tf 30 600 Td (ISBN 9780306406157) Tj ET'
            objects.append(b'<< /Length '+str(len(text)).encode()+b' >>\nstream\n'+text+b'\nendstream')
            pdf = b'%PDF-1.4\n'; offsets = [0]
            for n, obj in enumerate(objects, 1):
                offsets.append(len(pdf)); pdf += str(n).encode()+b' 0 obj\n'+obj+b'\nendobj\n'
            start = len(pdf)
            pdf += b'xref\n0 6\n0000000000 65535 f \n'+b''.join(f'{o:010d} 00000 n \n'.encode() for o in offsets[1:])
            pdf += b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+str(start).encode()+b'\n%%EOF\n'
            (root / 'book.pdf').write_bytes(pdf)
            doc = next(pdf_bulk.inventory(root)); index = str(Path(tmp) / 'index.sqlite')
            digest = pdf_bulk.file_hash(root, doc)
            pdf_bulk.prepare(root, index, doc, digest)
            info = pdf_bulk.identity(root, index, doc)
            self.assertIn('9780306406157', info['pages'][0]['text'])
            self.assertEqual(pdf_bulk.handle('index', root, index, {'document': doc})['status'], 'ready')
            self.assertEqual((root / 'book.pdf').read_bytes(), pdf)

    def test_inventory_is_read_only_and_classifies_before_reading_pdf(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'books'
            root.mkdir()
            (root / '책.PDF').write_bytes(b'%PDF fixture')
            (root / '논문').mkdir()
            (root / '논문' / '학위논문.pdf').write_bytes(b'not a pdf')
            docs = list(pdf_bulk.inventory(root))
            self.assertEqual(len(docs), 2)
            self.assertEqual(next(d for d in docs if d['title'] == '책')['material_kind'], 'book')
            self.assertNotEqual(next(d for d in docs if d['title'] == '학위논문')['processing_scope'], 'full')
            self.assertEqual((root / '책.PDF').read_bytes(), b'%PDF fixture')
            self.assertEqual(docs, list(pdf_bulk.inventory(root)))

    def test_hash_is_content_based_and_refuses_stale_stat_or_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'books'
            root.mkdir()
            (root / 'a.pdf').write_bytes(b'original')
            (root / 'b.pdf').write_bytes(b'original')
            a, b = list(pdf_bulk.inventory(root))
            self.assertEqual(pdf_bulk.file_hash(root, a), pdf_bulk.file_hash(root, b))
            (root / 'a.pdf').write_bytes(b'changed!')
            # Equal-size writes can share a timestamp on a fast Windows run.
            # Verify the stale-stat guard without assuming clock resolution.
            changed = (root / 'a.pdf').stat()
            os.utime(root / 'a.pdf', ns=(changed.st_atime_ns, int(a['mtime_ns']) + 1_000_000_000))
            with self.assertRaises(ValueError):
                pdf_bulk.file_hash(root, a)
            outside = Path(tmp) / 'outside.pdf'
            outside.write_bytes(b'original')
            with self.assertRaises(ValueError):
                pdf_bulk.file_hash(root, {**b, 'path': str(outside)})


if __name__ == '__main__':
    unittest.main()
