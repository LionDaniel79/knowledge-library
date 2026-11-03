"""Drive the normal WPF search/render/cancel paths using invented documents."""
import hashlib
import sqlite3
import subprocess
import sys
from pathlib import Path
from contextlib import closing
from PIL import Image,ImageDraw
from test_desktop import LibraryCase

def main(executable,output):
    case=LibraryCase()
    case.setUp()
    try:
        with closing(sqlite3.connect(case.index)) as db:
            for i,p in enumerate(sorted(case.root.rglob('*.pdf'))):
                with Image.new('RGB',(480,680),'white') as image:
                    ImageDraw.Draw(image).text((40,60),'Knowledge Library - sample page',fill='black')
                    image.save(p)
                db.execute('update documents set path=?,root=?,bytes=?,mtime_ns=?,sha256=? where id=?',(str(p),str(case.root),p.stat().st_size,str(p.stat().st_mtime_ns),hashlib.sha256(p.read_bytes()).hexdigest(),case.ids[i]))
            db.commit()
        subprocess.run([executable,sys.executable,str(Path(__file__).with_name('worker.py').resolve()),str(case.index),str(case.root),str(case.data),output],check=True,timeout=55)
    finally:
        case.doCleanups()

if __name__=='__main__':main(*sys.argv[1:])
