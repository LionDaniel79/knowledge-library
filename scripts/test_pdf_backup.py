import sqlite3,tempfile,unittest,hashlib
from pathlib import Path
from backup_pdf_index import backup_index,asset_inventory,copy_assets

class BackupTests(unittest.TestCase):
    def test_imported_hash_named_images_are_copied_and_verified(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);assets=root/'assets';assets.mkdir();content=b'image-content';name=hashlib.sha256(content).hexdigest()
            (assets/name).write_bytes(content);(assets/'config.private.json').write_text('not an image')
            rows=copy_assets(asset_inventory(assets),root/'copy')
            self.assertEqual(len(rows),1);self.assertEqual((root/'copy'/name).read_bytes(),content)
            self.assertFalse((root/'copy/config.private.json').exists())
    def test_snapshot_stays_consistent_during_concurrent_ocr_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);index=root/'source.sqlite';out=root/'backup'
            writer=sqlite3.connect(index);writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('CREATE TABLE documents(relative_path text,bytes integer,signature text,sha256 text)')
            writer.execute("INSERT INTO documents VALUES('book.pdf',10,'original','hash')");writer.commit()
            added=[False]
            def progress(*args):
                if not added[0]:
                    writer.execute("INSERT INTO documents VALUES('new.pdf',20,'new','newhash')");writer.commit();added[0]=True
            report=backup_index(index,out,min_free=0,progress=progress)
            self.assertTrue(report['complete']);self.assertEqual(report['sourceFiles'],1)
            copy=sqlite3.connect(out/'pdf-library.sqlite');self.assertEqual(copy.execute('SELECT count(*) FROM documents').fetchone()[0],1);copy.close()
            self.assertEqual(writer.execute('SELECT count(*) FROM documents').fetchone()[0],2)
            with self.assertRaises(FileExistsError):backup_index(index,out,min_free=0)
            with self.assertRaises(RuntimeError):backup_index(index,root/'not-created',min_free=10**30)
            self.assertFalse((root/'not-created').exists());writer.close()

if __name__=='__main__':unittest.main()
