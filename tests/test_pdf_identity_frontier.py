import sys,unittest,tempfile,hashlib
from pathlib import Path
from unittest.mock import patch,MagicMock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import pdf_identity_frontier as probe
class Frontier(unittest.TestCase):
 def test_short_pdf_deduplicates_reuses_cache_and_preserves_original(self):
  with tempfile.TemporaryDirectory() as tmp:
   path=Path(tmp)/'sample.pdf';pdf=probe.pdfium.PdfDocument.new();page=pdf.new_page(300,400);page.close();pdf.save(path);pdf.close();before=path.read_bytes()
   with patch.object(probe,'AdaptiveWindowsOcr') as factory:
    factory.return_value.recognize_png.return_value={'text':'ISBN 9780306406157'}
    req={'path':str(path),'pages':[1,1],'pageCount':1,'cache':str(Path(tmp)/'cache')}
    self.assertEqual(len(probe.supplement(req)),1);probe.supplement(req);self.assertEqual(factory.return_value.recognize_png.call_count,1)
   self.assertEqual(before,path.read_bytes())
 def test_rejects_body_page(self):
  with tempfile.TemporaryDirectory() as tmp:
   path=Path(tmp)/'sample.pdf';path.write_bytes(b'not opened')
   with self.assertRaises(ValueError):probe.supplement({'path':str(path),'pages':[13],'pageCount':50,'cache':tmp})
if __name__=='__main__':unittest.main()
