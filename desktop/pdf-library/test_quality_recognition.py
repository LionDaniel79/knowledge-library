"""Synthetic quality helper tests; no operational library, engines, or network."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image

try:
    import quality_recognition as quality
except ModuleNotFoundError:
    quality = None


class Pdf:
    text = ''
    count = 96
    def __init__(self, path): pass
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def __len__(self): return self.count
    def __getitem__(self, index): return self
    def get_textpage(self): return self
    def get_text_bounded(self): return self.text
    def close(self): pass


class Renderer:
    pages = []
    closed = 0
    def render(self, row, page_number=None):
        self.pages.append(page_number or row['page_number'])
        return Image.new('RGB', (1000, 1000), 'white')
    def close(self): type(self).closed += 1


class Engine:
    calls = 0
    closed = 0
    error = None
    def recognize_png(self, png):
        type(self).calls += 1
        if self.error: raise self.error
        lines = [
            {'text': 'Repeated running title', 'box': [50, 30, 400, 20]},
            {'text': '본문 신간 안내 구매 문의', 'box': [50, 200, 500, 30]},
            {'text': '각주 1. 원문 인용', 'box': [50, 930, 400, 20]},
            {'text': '7', 'box': [480, 990, 15, 10]},
        ]
        return {'text': '\n'.join(l['text'] for l in lines), 'lines': lines, 'language': 'ko'}
    def close(self): type(self).closed += 1


ORIGINAL_RENDERER = quality.QualityRenderer if quality else None

class QualityRecognitionTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(quality, 'Native OCR quality helper must be implemented')
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.source = self.home / 'book.pdf'
        self.source.write_bytes(b'synthetic source, not a real PDF')
        self.cache = self.home / 'state' / 'ocr-layout'
        Pdf.text = ''; Pdf.count = 96
        Renderer.pages = []; Renderer.closed = 0
        Engine.calls = 0; Engine.closed = 0; Engine.error = None
        for name, value in [('QualityRenderer', Renderer), ('AdaptiveWindowsOcr', Engine)]:
            p = patch.object(quality, name, value); p.start(); self.addCleanup(p.stop)
        p = patch.object(quality.pdfium, 'PdfDocument', Pdf); p.start(); self.addCleanup(p.stop)
        # Probe orchestration uses a deterministic prepared image; existing
        # test_ocr_quality covers the real deskew and recognition algorithms.
        p = patch.object(quality, 'deskew', side_effect=lambda image: (image.copy(), 0)); p.start(); self.addCleanup(p.stop)

    def recognize(self, page=2, **kwargs):
        return quality.candidate(self.source, page, cache_directory=self.cache, content_key='content-uuid', **kwargs)

    def test_embedded_text_uses_pdfium_without_engine_or_cache(self):
        Pdf.text = '  Native text\nFootnote 1  '
        self.assertEqual(self.recognize(), ('Native text\nFootnote 1', 'PDFium'))
        self.assertEqual(Engine.calls, 0)
        self.assertFalse(self.cache.exists())

    def test_existing_quality_keeps_body_and_footnotes_and_filters_repeated_margins(self):
        text, method = self.recognize()
        self.assertEqual(text, '본문 신간 안내 구매 문의\n각주 1. 원문 인용')
        self.assertIn(quality.PROFILE, method)
        self.assertEqual(Engine.closed, 1)
        self.assertEqual(Renderer.closed, 1)

    def test_durable_global_and_block_probes_are_reused_across_candidates(self):
        self.recognize()
        first = len(Renderer.pages)
        self.recognize(3)
        self.assertEqual(len(Renderer.pages), first + 1)
        self.recognize(35)
        self.assertEqual(len(Renderer.pages), first + 1 + 7)
        self.assertEqual(len(list(self.cache.glob('*.json'))), 3)

    def test_oneoff_without_cache_is_bounded_and_does_not_write(self):
        quality.candidate(self.source, 2)
        self.assertLessEqual(len(Renderer.pages), 13)
        self.assertFalse(self.cache.exists())

    def test_fatal_engine_error_propagates_and_all_resources_close(self):
        Engine.error = quality.OcrEngineError('fatal engine failure')
        with self.assertRaises(quality.OcrEngineError): self.recognize()
        self.assertEqual(Engine.closed, 1)
        self.assertEqual(Renderer.closed, 1)

    def test_source_change_during_recognition_cannot_write_cache(self):
        original = Engine.recognize_png
        def changing(engine, png):
            result = original(engine, png)
            self.source.write_bytes(b'changed source length')
            return result
        with patch.object(Engine, 'recognize_png', changing):
            with self.assertRaises(ValueError): self.recognize()
        self.assertEqual(list(self.cache.glob('*.json')), [])

    def test_stale_source_signature_does_not_reuse_margin_cache(self):
        self.recognize(); Renderer.pages = []
        self.source.write_bytes(b'a newer source with different size')
        self.recognize()
        self.assertGreater(len(Renderer.pages), 1)

    def test_other_content_key_does_not_reuse_cache(self):
        self.recognize(); Renderer.pages = []
        quality.candidate(self.source, 2, self.cache, 'other-content')
        self.assertGreater(len(Renderer.pages), 1)

    def test_corrupt_or_oversized_cache_is_ignored_conservatively(self):
        self.recognize()
        for path in self.cache.glob('*.json'): path.write_text('[' * (quality.MAX_CACHE_BYTES + 1))
        Renderer.pages = []
        self.recognize()
        self.assertGreater(len(Renderer.pages), 1)

    def test_linked_cache_file_is_never_overwritten(self):
        self.recognize()
        path = next(self.cache.glob('*.json'))
        external = self.home / 'outside.json'
        path.rename(external)
        path.hardlink_to(external)
        before = external.read_bytes()
        with self.assertRaises(ValueError): self.recognize()
        self.assertEqual(external.read_bytes(), before)

    def test_cache_directory_links_are_rejected_before_rendering(self):
        outside = self.home / 'outside'; outside.mkdir()
        try: self.cache.parent.mkdir(); self.cache.symlink_to(outside, target_is_directory=True)
        except OSError: self.skipTest('directory symlink privilege unavailable')
        with self.assertRaises(ValueError): self.recognize()
        self.assertFalse(list(outside.iterdir()))

    def test_invalid_page_does_not_start_engine(self):
        for page in (0, 97, -1, 1.5, True):
            with self.subTest(page=page):
                with self.assertRaises(ValueError): self.recognize(page)
        self.assertEqual(Engine.calls, 0)




class AdditionalQualitySafetyTests(unittest.TestCase):
    setUp = QualityRecognitionTests.setUp
    recognize = QualityRecognitionTests.recognize
    def test_fatal_engine_error_is_not_masked_by_cleanup_error(self):
        Engine.error = quality.OcrEngineError('primary fatal failure')
        def bad_close(engine): raise RuntimeError('cleanup failure')
        with patch.object(Engine, 'close', bad_close):
            with self.assertRaises(quality.OcrEngineError): self.recognize()
        self.assertEqual(Renderer.closed, 1)

    def test_cache_count_stays_bounded_without_touching_other_files(self):
        self.cache.mkdir(parents=True)
        other = self.cache / 'unrelated.json'; other.write_text('keep')
        margins = {('top', 'runningtitle', 0.05, 0.03, 0.4, 0.02)}
        with patch.object(quality, 'MAX_CACHE_FILES', 2), patch.object(quality, '_inspect_headers', return_value=margins):
            self.recognize(2); self.recognize(35)
        self.assertEqual(len(list(self.cache.glob('qlayout-*.json'))), 2)
        self.assertEqual(other.read_text(), 'keep')

    def test_renderer_uses_300dpi_capped_at_24_megapixels_and_closes(self):
        # Reach the real renderer despite the fixture's engine/render injection.
        renderer_type = ORIGINAL_RENDERER
        class Bitmap:
            closed = False
            def to_pil(self): return Image.new('RGB', (2, 2), 'white')
            def close(self): self.closed = True
        class Page:
            closed = False
            def __init__(self, size): self.size = size; self.bitmap = Bitmap()
            def get_size(self): return self.size
            def render(self, scale): self.scale = scale; return self.bitmap
            def close(self): self.closed = True
        class Document:
            closed = False
            def __init__(self, page): self.page = page
            def __getitem__(self, index): return self.page
            def close(self): self.closed = True
        for size in ((595, 842), (4000, 5000)):
            page = Page(size); document = Document(page)
            with patch.object(quality.pdfium, 'PdfDocument', return_value=document):
                renderer = renderer_type()
                image = renderer.render({'path': self.source, 'page_number': 1})
                image.close(); renderer.close()
            self.assertLessEqual(size[0] * size[1] * page.scale ** 2, 24_000_001)
            self.assertLessEqual(page.scale, 300 / 72)
            if size == (595, 842): self.assertEqual(page.scale, 300 / 72)
            self.assertTrue(page.closed and page.bitmap.closed and document.closed)


if __name__ == '__main__': unittest.main()

