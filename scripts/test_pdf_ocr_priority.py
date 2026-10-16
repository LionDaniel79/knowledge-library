import sqlite3
import unittest
from pdf_ocr_store import pending_pages


class IdentityPriorityTests(unittest.TestCase):
    def database(self):
        db = sqlite3.connect(':memory:')
        db.row_factory = sqlite3.Row
        db.executescript('''
          CREATE TABLE documents(id TEXT PRIMARY KEY,path TEXT,root TEXT,signature TEXT,processing_scope TEXT,status TEXT,indexed_pages INTEGER,page_count INTEGER,text_pages INTEGER);
          CREATE TABLE pages(id INTEGER PRIMARY KEY,document_id TEXT,page_number INTEGER,method TEXT,text TEXT);
          CREATE INDEX pages_document ON pages(document_id,page_number);
        ''')
        self.addCleanup(db.close)
        return db

    def book(self, db, name, count, scope='full'):
        db.execute('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?)', (name,name+'.pdf','root','sig',scope,'needs_ocr',count,count,0))
        db.executemany('INSERT INTO pages(document_id,page_number,method,text) VALUES(?,?,?,?)', [(name,n,'needs_ocr','') for n in range(1,count+1)])
        db.commit()

    def test_all_books_front_and_back_finish_before_any_middle_page(self):
        db=self.database()
        self.book(db,'a',30);self.book(db,'b',30);self.book(db,'excluded',30,'metadata_only')
        selected=[(r['id'],r['page_number']) for r in pending_pages(db,priority='identity-first')]
        edges=list(range(1,13))+list(range(23,31))
        self.assertEqual(selected[:40], [('a',n) for n in edges]+[('b',n) for n in edges])
        self.assertEqual(selected[40:], [('a',n) for n in range(13,23)]+[('b',n) for n in range(13,23)])
        self.assertEqual(len(selected),len(set(selected)))

    def test_resume_skips_saved_text_and_short_book_has_no_duplicates(self):
        db=self.database();self.book(db,'a',30);self.book(db,'b',8)
        db.execute("UPDATE pages SET method='ocr_unverified',text='saved' WHERE document_id='a' AND page_number<=12")
        db.execute("UPDATE pages SET method='text',text='native' WHERE document_id='a' AND page_number=30")
        db.execute("UPDATE pages SET method='ocr_empty' WHERE document_id='b' AND page_number=8")
        db.commit()
        rows=[(r['id'],r['page_number']) for r in pending_pages(db,priority='identity-first')]
        self.assertEqual(rows[:14],[('a',n) for n in range(23,30)]+[('b',n) for n in range(1,8)])
        self.assertEqual(len(rows),24)
        self.assertNotIn(('a',30),rows)
        retry=[(r['id'],r['page_number']) for r in pending_pages(db,True,priority='identity-first')]
        self.assertEqual(retry.count(('b',8)),1)

    def test_legacy_book_order_remains_available(self):
        db=self.database();self.book(db,'a',30);self.book(db,'b',8)
        rows=[(r['id'],r['page_number']) for r in pending_pages(db)]
        self.assertEqual(rows[:30],[('a',n) for n in range(1,31)])

    def test_edge_selection_does_not_scan_a_large_books_body(self):
        db=self.database();self.book(db,'a',30000);self.book(db,'b',1)
        db.execute("UPDATE pages SET method='text',text='already saved' WHERE document_id='a' AND (page_number<=12 OR page_number>29992)")
        db.commit();steps=[0]
        def count_steps():
            steps[0]+=100
            return 0
        db.set_progress_handler(count_steps,100)
        selected=next(pending_pages(db,priority='identity-first'))
        db.set_progress_handler(None,0)
        self.assertEqual((selected['id'],selected['page_number']),('b',1))
        self.assertLess(steps[0],10000,'Front/back selection must use bounded page ranges, not scan the body.')

    def test_stop_is_honored_while_skipping_books_with_completed_edges(self):
        db=self.database();self.book(db,'a',30);self.book(db,'b',30)
        db.execute("UPDATE pages SET method='text' WHERE document_id='a'")
        db.commit();checks=[0]
        def stop():
            checks[0]+=1
            return checks[0]>=3
        self.assertEqual(list(pending_pages(db,priority='identity-first',should_stop=stop)),[])


if __name__ == '__main__': unittest.main()
