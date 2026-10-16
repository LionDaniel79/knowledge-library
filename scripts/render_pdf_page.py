"""Render one bounded PDF page to stdout without changing the original."""
import sys
import pypdfium2 as pdfium

def render(path,number):
    with pdfium.PdfDocument(path) as document:
        if number<1 or number>len(document): raise ValueError('page out of range')
        page=document[number-1]
        try:
            width,height=page.get_size()
            bitmap=page.render(scale=min(1400/max(width,1),2200/max(height,1),2))
            try:
                image=bitmap.to_pil()
                try: image.save(sys.stdout.buffer,format='PNG')
                finally: image.close()
            finally: bitmap.close()
        finally: page.close()
if __name__=='__main__': render(sys.argv[1],int(sys.argv[2]))
