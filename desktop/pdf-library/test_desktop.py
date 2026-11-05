"""Synthetic catalog. No external services or operational paths."""
import hashlib
from contextlib import closing
import sqlite3
import tempfile
import unittest
import uuid
from pathlib import Path
from registry import scan,registry,walk,exclusive
from reader import search,render,source
from manifest import preview,MockCatalog


class LibraryCase(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home=Path(tmp.name)
        self.root=self.home/'books'
        self.data=self.home/'side'
        self.index=self.home/'fixture.sqlite'
        for group in ('기독도서','일반도서','기타도서','기독도서2'):
            (self.root/group/'sub').mkdir(parents=True)
        db=sqlite3.connect(self.index)
        db.executescript("""
        create table documents(id text primary key,title text,path text,root text,bytes int,mtime_ns text,sha256 text,material_kind text,status text,page_count int);
        create table pages(id integer primary key,document_id text,page_number int,text text,method text,unique(document_id,page_number));
        create virtual table pages_fts using fts5(text,content='pages',content_rowid='id',tokenize='trigram');
        create table reocr_pages(document_id text,state text);
        """)
        self.ids=[]
        for i,(group,kind) in enumerate([('기독도서','book'),('일반도서','book'),('기타도서','paper'),('기독도서2','periodical')]):
            p=self.root/group/'sub'/f'{i}.pdf'
            p.write_bytes(b'Same selected' if i<2 else str(i).encode())
            old=p if i!=2 else self.root/'old.pdf'
            doc=str(uuid.uuid4());self.ids.append(doc)
            db.execute('insert into documents values(?,?,?,?,?,?,?,?,?,?)',(doc,'시험 자료',str(old),str(self.root),p.stat().st_size,str(p.stat().st_mtime_ns),hashlib.sha256(p.read_bytes()).hexdigest(),kind,'ready',2))
            for n,t in enumerate(['영적인 사람 본문','사람 안에 영적인 뜻'],1):
                db.execute('insert into pages(document_id,page_number,text,method) values(?,?,?,?)',(doc,n,t,'text'))
        db.execute("insert into pages_fts(pages_fts) values('rebuild')")
        db.execute('insert into reocr_pages values(?,?)',(self.ids[0],'review'))
        db.commit();db.close()

    def runscan(self,**kwargs):
        return scan(self.index,self.root,self.data,**kwargs)

    def test_search(self):
        before=self.index.stat().st_mtime_ns
        for kind in ['paper','periodical']:
            self.assertEqual(len(search(self.index,'영적인 사람',kind)['hits']),2)
            self.assertEqual(search(self.index,'"영적인 사람"',kind)['hits'][0]['page'],1)
        self.assertEqual(len(search(self.index,'본문',document=self.ids[0])['hits']),1)
        with self.assertRaises(sqlite3.OperationalError):search(self.index,'사람',seconds=-1)
        self.assertEqual(before,self.index.stat().st_mtime_ns)

    def test_registry_and_mock_retry(self):
        self.runscan()
        one=preview(self.index,self.root,self.data)
        self.assertEqual((one['unique'],one['physical']),(2,2))
        two=preview(self.index,self.root,self.data)
        self.assertEqual(one,two)
        with closing(registry(self.data)) as db:
            payload=db.execute('select payload from outbox').fetchone()[0]
            for forbidden in [str(self.root),'기타도서',self.ids[2],self.ids[3],'영적인',hashlib.sha256(b'Same selected').hexdigest()]:
                self.assertNotIn(forbidden,payload)
            self.assertEqual(db.execute('select count(*) from outbox').fetchone()[0],1)
            self.assertEqual(db.execute('select count(*) from legacy_document_binding').fetchone()[0],4)

    def test_incomplete_scan_and_resume(self):
        with self.assertRaises(InterruptedError):self.runscan(stop=lambda:True)
        with self.assertRaises(ValueError):preview(self.index,self.root,self.data)
        self.runscan()
        (self.root/'기독도서').rename(self.root/'offline')
        with self.assertRaises(ValueError):preview(self.index,self.root,self.data)

    def test_content_change_and_lock(self):
        self.runscan()
        with exclusive(self.data,'inventory'):
            with self.assertRaises(ValueError):self.runscan()
        (self.root/'일반도서'/'sub'/'1.pdf').write_bytes(b'replacement bytes')
        with self.assertRaises(ValueError):preview(self.index,self.root,self.data)
        self.runscan()
        with self.assertRaises(ValueError):preview(self.index,self.root,self.data)

    def test_ambiguous_alias(self):
        (self.root/'기독도서'/'duplicate.pdf').write_bytes(b'Same selected')
        self.runscan()
        with self.assertRaises(ValueError):preview(self.index,self.root,self.data)

    def test_copy_ocr_and_page_render(self):
        from PIL import Image,ImageDraw,ImageFont
        from sandbox import process_one
        p=self.root/'일반도서'/'sub'/'1.pdf'
        with Image.new('RGB',(900,350),'white') as image:
            ImageDraw.Draw(image).text((30,60),'Library sample page',font=ImageFont.truetype('arial.ttf',45),fill='black')
            image.save(p)
        with closing(sqlite3.connect(self.index)) as db:
            db.execute('update documents set bytes=?,mtime_ns=?,sha256=?,page_count=1 where id=?',(p.stat().st_size,str(p.stat().st_mtime_ns),hashlib.sha256(p.read_bytes()).hexdigest(),self.ids[1]))
            db.execute("update pages set method='needs_ocr',text='' where document_id=? and page_number=1",(self.ids[1],))
            db.commit()
        digest=hashlib.sha256(self.index.read_bytes()).digest()
        self.assertEqual(render(self.index,self.ids[1],1)['total'],1)
        def failed(*_):raise OSError('sample failure')
        self.assertEqual(process_one(self.index,self.data,self.ids[1],failed)['counts'],{'error':1})
        self.assertEqual(process_one(self.index,self.data,self.ids[1])['counts'],{'review':1})
        self.assertEqual(process_one(self.index,self.data,self.ids[1])['page'],None)
        self.assertEqual(digest,hashlib.sha256(self.index.read_bytes()).digest())

    def test_read_failure_invalidates_manifest(self):
        from unittest.mock import patch
        with patch('registry.fingerprint',side_effect=OSError('sample read failure')):
            with self.assertRaises(OSError):self.runscan()
        with self.assertRaises(ValueError):preview(self.index,self.root,self.data)

    def test_similar_prefix_not_selected(self):
        self.runscan()
        with closing(registry(self.data)) as db:
            self.assertIsNone(db.execute('select registration_root from web_registration where legacy_id=?',(self.ids[3],)).fetchone()[0])

    def test_interrupt_during_hash_then_resume(self):
        def halt():
            import inspect
            return inspect.currentframe().f_back.f_code.co_name=='fingerprint'
        with self.assertRaises(InterruptedError):self.runscan(stop=halt)
        self.assertEqual(self.runscan()['files'],4)
        self.assertEqual(preview(self.index,self.root,self.data)['physical'],2)

    def test_junction_blocks_full_scan(self):
        from _winapi import CreateJunction
        outside=self.home/'outside'
        outside.mkdir()
        link=self.root/'기독도서'/'link'
        CreateJunction(str(outside),str(link))
        try:
            with self.assertRaises(ValueError):self.runscan()
            with self.assertRaises(ValueError):preview(self.index,self.root,self.data)
        finally:link.rmdir()

    def test_mock_batch_conflict(self):
        self.runscan()
        preview(self.index,self.root,self.data)
        import json
        with closing(registry(self.data)) as db:
            payload=json.loads(db.execute('select payload from outbox').fetchone()[0])
        m=MockCatalog('local-test')
        m.start(payload['header']);m.put('batch',payload['items'])
        with self.assertRaises(ValueError):m.put('batch',payload['items'][:1])
        m.seal()
        with self.assertRaises(ValueError):m.apply_selection(False)
        m.apply_selection(True)
        self.assertFalse(m.cleanup_preview()['applyEnabled'])

if __name__=='__main__':unittest.main()
