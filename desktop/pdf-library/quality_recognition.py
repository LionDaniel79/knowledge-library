"""Read-only native quality OCR with a bounded private layout-evidence cache.

Only the requested private cache is writable. This module never opens a library
index or imports the legacy re-OCR store. Text recognition remains the existing
body/footnote profile and installed Windows OCR languages.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile

_SCRIPT_DIRECTORY = str(Path(__file__).resolve().parents[2] / 'scripts')
if _SCRIPT_DIRECTORY not in sys.path:
    sys.path.insert(0, _SCRIPT_DIRECTORY)

import pypdfium2 as pdfium
from pdf_ocr import OcrEngineError
from pdf_ocr_languages import AdaptiveWindowsOcr
from pdf_ocr_quality import PROFILE, deskew, header_probe_pages, probe, recognize_body, repeated_margins

MAX_CACHE_FILES = 256
MAX_CACHE_BYTES = 65536
MAX_MARGINS = 256
_CACHE_NAME = re.compile(r'^qlayout-[0-9a-f]{64}-(?:global|block-[0-9]+)\.json$')


class QualityRenderer:
    """The existing 300 dpi/24 megapixel renderer, without legacy DB imports."""
    def __init__(self):
        self.pdf = None
        self.path = None

    def render(self, row, page_number=None):
        path = row['path']
        if path != self.path:
            self.close()
            self.pdf = pdfium.PdfDocument(path)
            self.path = path
        page = self.pdf[(page_number or row['page_number']) - 1]
        try:
            width, height = page.get_size()
            scale = min(300 / 72, math.sqrt(24_000_000 / max(1, width * height)))
            bitmap = page.render(scale=scale)
            try:
                return bitmap.to_pil().convert('RGB')
            finally:
                bitmap.close()
        finally:
            page.close()

    def close(self):
        if self.pdf is not None:
            self.pdf.close()
        self.pdf = self.path = None


def _signature(path):
    stamp = Path(path).stat()
    return [stamp.st_size, stamp.st_mtime_ns, stamp.st_dev, stamp.st_ino]


def _safe_path(path, directory=False):
    """Reject symlinks, Windows junctions and hard-linked cache files."""
    for part in (path, *path.parents):
        try:
            stamp = part.lstat()
        except FileNotFoundError:
            continue
        if part.is_symlink() or getattr(stamp, 'st_file_attributes', 0) & 1024:
            raise ValueError('OCR 여백 캐시는 연결 경로를 사용할 수 없습니다.')
    if path.exists():
        if directory and not path.is_dir():
            raise ValueError('OCR 여백 캐시 폴더를 확인하세요.')
        if not directory and (not path.is_file() or path.stat().st_nlink != 1):
            raise ValueError('OCR 여백 캐시는 전용 파일이어야 합니다.')


def _valid_margins(value):
    if not isinstance(value, list) or len(value) > MAX_MARGINS:
        return None
    margins = set()
    for item in value:
        if (not isinstance(item, list) or len(item) != 6 or item[0] not in ('top', 'bottom')
                or not isinstance(item[1], str) or not 1 <= len(item[1]) <= 90
                or any(type(n) not in (int, float) or not math.isfinite(n) or abs(n) > 10 for n in item[2:])
                or min(item[4:]) <= 0):
            return None
        margins.add(tuple(item))
    return margins


class _MarginCache:
    def __init__(self, directory, key, signature, count):
        self.directory = Path(directory).absolute()
        _safe_path(self.directory, directory=True)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        _safe_path(self.directory, directory=True)
        self.identity = hashlib.sha256((PROFILE + '\0' + key).encode('utf-8')).hexdigest()
        self.signature = signature
        self.count = count

    def path(self, group):
        _safe_path(self.directory, directory=True)
        path = self.directory / f'qlayout-{self.identity}-{group}.json'
        _safe_path(path)
        return path

    def read(self, group):
        path = self.path(group)
        try:
            if path.stat().st_size > MAX_CACHE_BYTES:
                return None
            with path.open('rb') as stream:
                payload = json.loads(stream.read(MAX_CACHE_BYTES + 1))
            if (not isinstance(payload, dict) or payload.get('profile') != PROFILE
                    or payload.get('signature') != self.signature or payload.get('pages') != self.count):
                return None
            return _valid_margins(payload.get('margins'))
        except (OSError, ValueError, UnicodeError):
            return None

    def write(self, group, margins, source):
        if _signature(source) != self.signature:
            raise ValueError('OCR 처리 중 원본이 변경되었습니다.')
        # A pathological book must not produce an unbounded metadata record.
        if len(margins) > MAX_MARGINS:
            return
        payload = json.dumps({'profile': PROFILE, 'signature': self.signature,
                              'pages': self.count, 'margins': sorted(margins)}, ensure_ascii=False).encode('utf-8')
        if len(payload) > MAX_CACHE_BYTES:
            return
        path = self.path(group)
        fd, name = tempfile.mkstemp(prefix='.qlayout-', suffix='.tmp', dir=self.directory)
        temporary = Path(name)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            self.path(group)  # Recheck links before the atomic replacement.
            if _signature(source) != self.signature:
                raise ValueError('OCR 처리 중 원본이 변경되었습니다.')
            os.replace(temporary, path)
        finally:
            if temporary.exists():
                temporary.unlink()
        # Only prune this helper's private, single-link cache files.
        files = []
        for entry in self.directory.iterdir():
            if _CACHE_NAME.fullmatch(entry.name):
                _safe_path(entry)
                files.append(entry)
        for entry in sorted(files, key=lambda p: p.stat().st_mtime_ns)[:max(0, len(files) - MAX_CACHE_FILES)]:
            _safe_path(entry)
            entry.unlink()


def _inspect_headers(row, positions, renderer, recognize):
    pages = []
    for position in positions:
        image = renderer.render(row, position)
        try:
            prepared, _ = deskew(image)
        finally:
            image.close()
        try:
            lines, meta = probe(prepared, recognize)
            angle = float(meta.get('textAngle') or 0)
            if math.isfinite(angle) and abs(angle) <= 1:
                pages.append([{**line, 'box': [n * 1000 / prepared.height for n in line['box']]} for line in lines])
        finally:
            prepared.close()
    return repeated_margins(pages, 1000)


def candidate(path, page, cache_directory=None, content_key=None):
    """Return ``(text, method)`` without changing PDFs or any library database.

    The native worker passes its private ``state/ocr-layout`` directory and
    stable content UUID. Without either argument, evidence is one-off and never
    persisted. Each cache miss probes at most six book and six section pages.
    """
    signature = _signature(path)
    with pdfium.PdfDocument(path) as pdf:
        count = len(pdf)
        if type(page) is not int or not 1 <= page <= count:
            raise ValueError('Invalid PDF page')
        pdf_page = pdf[page - 1]
        try:
            textpage = pdf_page.get_textpage()
            try:
                text = textpage.get_text_bounded().strip()
            finally:
                textpage.close()
        finally:
            pdf_page.close()
    if _signature(path) != signature:
        raise ValueError('OCR 처리 중 원본이 변경되었습니다.')
    if text:
        return text, 'PDFium'

    cache = None
    if cache_directory is not None and content_key is not None:
        if not isinstance(content_key, str) or not 0 < len(content_key) <= 1024:
            raise ValueError('OCR 문서 식별자를 확인하세요.')
        if Path(cache_directory).absolute() == Path(path).absolute().parent:
            raise ValueError('OCR 여백 캐시는 원본 폴더 밖에 지정하세요.')
        cache = _MarginCache(cache_directory, content_key, signature, count)
    row = {'path': path, 'page_number': page}
    renderer = QualityRenderer()
    engine = None
    pending = {}
    try:
        engine = AdaptiveWindowsOcr()
        recognize = engine.recognize_png
        global_positions = header_probe_pages(count)
        local_positions = header_probe_pages(count, page)
        def margins_for(group, positions):
            margins = cache.read(group) if cache else None
            if margins is None:
                margins = _inspect_headers(row, positions, renderer, recognize)
                pending[group] = margins
            return margins
        global_margins = margins_for('global', global_positions)
        local_margins = global_margins if local_positions == global_positions else margins_for(f'block-{(page - 1) // 32}', local_positions)
        image = renderer.render(row)
        try:
            result = recognize_body(image, recognize, global_margins | local_margins)
        finally:
            image.close()
        if _signature(path) != signature:
            raise ValueError('OCR 처리 중 원본이 변경되었습니다.')
        if cache:
            for group, margins in pending.items():
                cache.write(group, margins, path)
        return result['text'], f"Windows.Media.Ocr {result.get('language', '')} {PROFILE}".strip()
    finally:
        active_error = sys.exc_info()[0] is not None
        cleanup_error = None
        for resource in (engine, renderer):
            if resource is not None:
                try:
                    resource.close()
                except BaseException as error:
                    if not active_error and cleanup_error is None:
                        cleanup_error = error
        if cleanup_error is not None:
            raise cleanup_error

