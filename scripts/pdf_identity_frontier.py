"""Supplement only requested identification pages into a separate evidence cache."""
import sys,json,io,hashlib
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
import pypdfium2 as pdfium
from pdf_ocr_languages import AdaptiveWindowsOcr
def supplement(request):
    path=Path(request['path']);before=path.stat();pages=sorted(set(request['pages']));count=request['pageCount']
    if any(p<1 or p>count or (p>12 and p<=count-8) for p in pages):raise ValueError('Outside identification frontier')
    cache=Path(request['cache']);cache.mkdir(parents=True,exist_ok=True)
    result=[];engine=None
    try:
      with pdfium.PdfDocument(path) as pdf:
        if len(pdf)!=count:raise ValueError('Page count changed')
        for n in pages:
          key=hashlib.sha256(json.dumps([str(path),before.st_size,before.st_mtime_ns,n]).encode()).hexdigest();target=cache/(key+'.json')
          if target.exists():result.append({**json.loads(target.read_text(encoding='utf8')),'cacheHit':True});continue
          page=pdf[n-1]
          try:
            textpage=page.get_textpage()
            try:text=textpage.get_text_range()
            finally:textpage.close()
            method='text';ocr=False
            if len(text.strip())<20:
              if engine is None:engine=AdaptiveWindowsOcr()
              bitmap=page.render(scale=min(300/72,(24000000/max(1,page.get_width()*page.get_height()))**.5))
              try:
                image=bitmap.to_pil().convert('RGB');stream=io.BytesIO();image.save(stream,format='PNG');image.close()
              finally:bitmap.close()
              text=engine.recognize_png(stream.getvalue()).get('text','');method='ocr_unverified' if text.strip() else 'ocr_empty';ocr=True
            after=path.stat()
            if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('Source changed')
            value={'pageNumber':n,'text':text,'method':method,'supplemented':True,'ocr':ocr};target.write_text(json.dumps(value,ensure_ascii=False),encoding='utf8');result.append(value)
          finally:page.close()
    finally:
      if engine:engine.close()
    return result
if __name__=='__main__':
    try:
      request=json.load(sys.stdin);cache=Path(request['cache']);cache.mkdir(parents=True,exist_ok=True);marker=cache/'.ocr-active.json'
      if marker.exists():raise RuntimeError('Previous OCR probe requires review')
      marker.write_text(json.dumps({'state':'running'}),encoding='utf8')
      pages=supplement(request);marker.unlink();print(json.dumps({'pages':pages},ensure_ascii=True))
    except Exception as e:print(json.dumps({'error':type(e).__name__}));sys.exit(1)
