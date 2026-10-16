import sqlite3, tempfile, unittest
from pathlib import Path
from contextlib import closing, ExitStack
from pdf_maintenance import copy_index, hash_documents, audit
from pdf_library import connect

class MaintenanceTests(unittest.TestCase):
    def test_copy_includes_wal_and_preserves_source_and_search(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            source=Path(temp)/'source.sqlite'; target=Path(temp)/'external'/'copy.sqlite'
            db=stack.enter_context(closing(connect(source)))
            db.execute('DROP INDEX IF EXISTS documents_progress')
            db.execute("INSERT INTO pages(document_id,page_number,text,method) VALUES('d',1,'exact source evidence','text')");db.commit()
            self.assertTrue(Path(str(source)+'-wal').exists())
            result=copy_index(source,target,min_free_bytes=0)
            self.assertEqual(result['integrity'],'ok')
            self.assertEqual(result['counts']['pages'],1)
            copied=stack.enter_context(closing(sqlite3.connect(target)))
            self.assertEqual(copied.execute('SELECT text FROM pages').fetchone()[0],'exact source evidence')
            self.assertEqual(copied.execute("SELECT count(*) FROM pages_fts WHERE pages_fts MATCH 'evidence'").fetchone()[0],1)
            self.assertTrue(copied.execute("SELECT name FROM sqlite_master WHERE name='pages_document_method'").fetchone())
            self.assertTrue(copied.execute("SELECT name FROM sqlite_master WHERE name='documents_progress'").fetchone())
            self.assertEqual(db.execute('SELECT text FROM pages').fetchone()[0],'exact source evidence')

    def test_copy_never_overwrites_existing_target_or_same_file(self):
        with tempfile.TemporaryDirectory() as temp:
            source=Path(temp)/'source.sqlite';target=Path(temp)/'copy.sqlite'
            connect(source).close();target.write_bytes(b'keep me')
            with self.assertRaises(FileExistsError):copy_index(source,target,min_free_bytes=0)
            self.assertEqual(target.read_bytes(),b'keep me')
            with self.assertRaises(ValueError):copy_index(source,source,min_free_bytes=0)

    def test_hashes_only_unchanged_files_in_root_and_resumes_without_touching_originals(self):
        from pdf_library import scan
        from unittest.mock import patch
        import hashlib
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'books';root.mkdir();index=Path(temp)/'index.sqlite'
            (root/'one.pdf').write_bytes(b'%PDF identical');(root/'two.pdf').write_bytes(b'%PDF identical');(root/'three.pdf').write_bytes(b'%PDF different')
            scan(root,index);original={p.name:p.read_bytes() for p in root.iterdir()}
            first=hash_documents(index,root,limit=1,delay=0)
            self.assertEqual(first['hashed'],1)
            self.assertEqual(hash_documents(index,root,delay=0)['hashed'],2)
            self.assertEqual(hash_documents(index,root,delay=0)['hashed'],0)
            report=audit(index,root)
            self.assertEqual(report['hashes']['verified'],3)
            self.assertEqual(len(report['duplicates']),1)
            self.assertEqual(len(report['duplicates'][0]['documents']),2)
            self.assertEqual({p.name:p.read_bytes() for p in root.iterdir()},original)
            # A changed member must not remain a verified duplicate or hash count.
            (root/'one.pdf').write_bytes(b'changed after hashing')
            self.assertEqual(audit(index,root)['hashes']['verified'],2)
            self.assertEqual(audit(index,root)['duplicates'],[])
            # A forged path in an index never permits reads outside configured root.
            outside=Path(temp)/'outside.pdf';outside.write_bytes(b'private')
            db=connect(index);db.execute("UPDATE documents SET path=?,sha256=NULL WHERE relative_path='three.pdf'",(str(outside),));db.commit();db.close()
            result=hash_documents(index,root,delay=0)
            self.assertEqual(result['blocked'],1)
            db=connect(index);self.assertIsNone(db.execute("SELECT sha256 FROM documents WHERE relative_path='three.pdf'").fetchone()[0]);db.close()

    def test_never_saves_a_hash_when_file_changes_during_read(self):
        from pdf_library import scan
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'books';root.mkdir();path=root/'book.pdf';path.write_bytes(b'%PDF source');index=Path(temp)/'index.sqlite';scan(root,index)
            def changed(*args,**kwargs):path.write_bytes(b'changed source');return 'f'*64
            with patch('pdf_maintenance.file_hash',changed):
                result=hash_documents(index,root,delay=0)
            self.assertEqual(result['changed'],1)
            db=connect(index);self.assertIsNone(db.execute('SELECT sha256 FROM documents').fetchone()[0]);db.close()

    def test_audit_identifies_unhashed_changed_missing_and_escaped_files(self):
        from pdf_library import scan
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'books';root.mkdir();index=Path(temp)/'index.sqlite'
            for name in ('changed','missing','escaped','pending'):(root/(name+'.pdf')).write_bytes(b'%PDF source')
            scan(root,index)
            (root/'changed.pdf').write_bytes(b'%PDF new content')
            (root/'missing.pdf').unlink()
            outside=Path(temp)/'outside.pdf';outside.write_bytes(b'secret')
            db=connect(index);db.execute("UPDATE documents SET path=? WHERE relative_path='escaped.pdf'",(str(outside),));db.commit();db.close()
            report=audit(index,root)
            problems={r['relativePath']:r['reason'] for r in report['fileIssues']}
            self.assertEqual(problems,{'changed.pdf':'changed','missing.pdf':'missing','escaped.pdf':'outside_root'})
            self.assertEqual(report['hashes']['pending'],1)
            self.assertEqual(report['duplicates'],[])

if __name__=='__main__':unittest.main()
