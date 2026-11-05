"""Drive the normal WPF search/render/cancel paths using invented documents."""
import hashlib
import sqlite3
import subprocess
import sys
from pathlib import Path
from contextlib import closing
from PIL import Image,ImageDraw
from test_desktop import LibraryCase

def text_pdf(path):
    """A real one-page PDF with native text, independent of installed OCR fonts."""
    stream=b'BT /F1 24 Tf 40 620 Td (Knowledge Library sample page) Tj ET'
    objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
             b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 680] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
             b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
             b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'\nendstream']
    data=b'%PDF-1.4\n';offsets=[0]
    for i,obj in enumerate(objects,1):
        offsets.append(len(data));data+=str(i).encode()+b' 0 obj\n'+obj+b'\nendobj\n'
    start=len(data);data+=b'xref\n0 6\n0000000000 65535 f \n'
    for offset in offsets[1:]:data+=f'{offset:010} 00000 n \n'.encode()
    data+=b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+str(start).encode()+b'\n%%EOF\n'
    path.write_bytes(data)

def main(executable,output,mode=''):
    case=LibraryCase()
    case.setUp()
    try:
        with closing(sqlite3.connect(case.index)) as db:
            for i,p in enumerate(sorted(case.root.rglob('*.pdf'))):
                if mode=='--standalone':text_pdf(p)
                else:
                    with Image.new('RGB',(480,680),'white') as image:
                        ImageDraw.Draw(image).text((40,60),'Knowledge Library - sample page',fill='black')
                        image.save(p)
                db.execute('update documents set path=?,root=?,bytes=?,mtime_ns=?,sha256=? where id=?',(str(p),str(case.root),p.stat().st_size,str(p.stat().st_mtime_ns),hashlib.sha256(p.read_bytes()).hexdigest(),case.ids[i]))
            db.commit()
        subprocess.run([executable,sys.executable,str(Path(__file__).with_name('worker.py').resolve()),'-' if mode=='--standalone' else str(case.index),str(case.root),str(case.data),output],check=True,timeout=70)
    finally:
        case.doCleanups()

if __name__=='__main__':main(*sys.argv[1:])
