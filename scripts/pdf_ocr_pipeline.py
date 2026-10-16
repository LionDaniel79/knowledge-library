"""Main-thread PDF rendering; only OCR byte requests may run concurrently."""
import io
from pathlib import Path
import pypdfium2 as pdfium


class CachedRenderer:
    def __init__(self):
        self.document = None
        self.path = None

    def render(self, row):
        path = Path(row['path'])
        if self.path != path:
            self.close()
            self.document = pdfium.PdfDocument(str(path))
            self.path = path
        page = self.document[row['page_number'] - 1]
        try:
            scale = min(3, 2500 / max(page.get_size()))
            bitmap = page.render(scale=scale)
            try:
                image = bitmap.to_pil().convert('RGB')
                try:
                    stream = io.BytesIO()
                    # Lossless encoding: identical pixels, less compression CPU.
                    image.save(stream, format='PNG', compress_level=1)
                    return {'png':stream.getvalue(), 'width':image.width, 'height':image.height}
                finally:
                    image.close()
            finally:
                bitmap.close()
        finally:
            page.close()

    def close(self):
        if self.document is not None:
            self.document.close()
        self.document = self.path = None
