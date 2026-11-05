"""Only temporary synthetic PDFs/SQLite; never opens an operational library."""
import hashlib
import json
import shutil
import sqlite3
import sys
import tempfile
import unittest
import uuid
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import management as m


class ManagementTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.root = self.home / 'library'
        self.state = self.home / 'state'
        for name in ('기독도서', '일반도서', '논문', '간행물'):
            (self.root / name).mkdir(parents=True)
        self.path = self.pdf('기독도서/sample.pdf', 2)

    def pdf(self, relative, pages=1):
        from PIL import Image
        target = self.root / relative
        images = [Image.new('RGB', (160, 200), 'white') for _ in range(pages)]
        images[0].save(target, format='PDF', save_all=True, append_images=images[1:])
        for image in images:
            image.close()
        return target

    def scan(self, **kwargs):
        return m.scan(self.root, self.state, **kwargs)

    def test_default_ocr_uses_quality_profile_and_content_scoped_private_cache(self):
        self.scan()
        with patch('quality_recognition.candidate', return_value=('본문과 각주', 'body-footnotes-300dpi-v5')) as recognize:
            result = m.ocr_step(self.state)
        self.assertEqual(result['state'], 'done')
        recognize.assert_called_once()
        args, options = recognize.call_args
        self.assertEqual(args[0], str(self.path))
        self.assertEqual(options['cache_directory'], self.state / 'ocr-layout')
        with closing(m.database(self.state)) as db:
            resource = db.execute('select id from resources').fetchone()[0]
        self.assertEqual(options['content_key'], resource)

    def legacy_fixture(self, entries):
        index = self.home / 'logical-legacy.sqlite'
        with closing(sqlite3.connect(index)) as db:
            db.executescript('create table documents(id text,title text,path text,root text,bytes int,mtime_ns text,sha256 text,material_kind text,status text,page_count int); create table pages(id integer primary key,document_id text,page_number int,text text,method text); create virtual table pages_fts using fts5(text,content="pages",content_rowid="id",tokenize="trigram");')
            for document, title, path in entries:
                stamp = path.stat()
                db.execute('insert into documents values(?,?,?,?,?,?,?,?,?,?)', (document, title, str(path), str(self.root), stamp.st_size, str(stamp.st_mtime_ns), hashlib.sha256(path.read_bytes()).hexdigest(), 'book', 'ready', 2))
            db.commit()
        return index

    def text_pdf(self, relative, texts, metadata=None):
        # Minimal synthetic PDF with real embedded text and PDF Info fields.
        def literal(value):
            return '(' + value.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)') + ')'
        objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
                   ('<< /Type /Pages /Count %d /Kids [%s] >>' % (len(texts), ' '.join(f'{5+2*i} 0 R' for i in range(len(texts))))).encode(),
                   b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
                   ('<< ' + ' '.join('/' + k + ' ' + literal(v) for k, v in (metadata or {}).items()) + ' >>').encode()]
        for i, text in enumerate(texts):
            content = ('BT /F1 10 Tf 10 150 Td ' + literal(text) + ' Tj ET').encode()
            objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 160 200] /Resources << /Font << /F1 3 0 R >> >> /Contents {6+2*i} 0 R >>'.encode())
            objects.append(b'<< /Length ' + str(len(content)).encode() + b' >>\nstream\n' + content + b'\nendstream')
        data, offsets = b'%PDF-1.4\n', [0]
        for i, obj in enumerate(objects, 1):
            offsets.append(len(data))
            data += f'{i} 0 obj\n'.encode() + obj + b'\nendobj\n'
        xref = len(data)
        data += f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
        data += b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
        data += f'trailer\n<< /Size {len(offsets)} /Root 1 0 R /Info 4 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
        path = self.root / relative
        path.write_bytes(data)
        return path

    def test_first_user_scan_incremental_and_content_move(self):
        first = self.scan()
        self.assertEqual((first['files'], first['hashed']), (1, 1))
        resource = m.status(self.state)['documents'][0]['id']
        self.assertEqual(self.scan()['hashed'], 0)
        copy = self.root / '일반도서/copy.pdf'
        shutil.copyfile(self.path, copy)
        self.path.rename(self.root / '논문/moved.pdf')
        self.scan()
        status = m.status(self.state)
        self.assertEqual(status['resources'], 1)
        self.assertEqual(status['documents'][0]['id'], resource)
        self.assertEqual(status['availableCopies'], 2)
        payload = m.prepare_web(self.state)['requests'][0]
        self.assertEqual(payload['items'][0]['locations'], [{'rootKey': 'general', 'relativePath': 'copy.pdf'}])

    def test_scope_search_ocr_pause_resume_retry(self):
        paper = self.pdf('논문/paper.pdf', 1)
        # Distinguish otherwise identical generated PDFs.
        paper.write_bytes(paper.read_bytes() + b'\n% distinct paper\n')
        self.scan()
        m.pause(self.state)
        self.assertEqual(m.ocr_step(self.state, recognize=lambda *_: ('찾을 본문', 'fixture'))['state'], 'paused')
        m.pause(self.state, False)
        fail = lambda *_: (_ for _ in ()).throw(RuntimeError('fixture failure'))
        self.assertEqual(m.ocr_step(self.state, recognize=fail)['state'], 'error')
        m.retry(self.state)
        for _ in range(4):
            m.ocr_step(self.state, recognize=lambda *_: ('찾을 본문 하나님 사랑', 'fixture'))
        self.assertEqual(m.status(self.state)['queue']['done'], 3)
        result = m.search(self.state, '하나님 사랑', kind='paper')
        self.assertEqual(len(result['hits']), 1)
        self.assertEqual(result['hits'][0]['kind'], 'paper')
        self.assertTrue(result['hits'][0]['available'])
        self.assertTrue(m.render(self.state, result['hits'][0]['id'], 1)['image'])

    def test_fatal_ocr_engine_failure_pauses_once_and_preserves_completed_pages(self):
        with patch.object(sys, 'path', [str(Path(__file__).resolve().parents[2] / 'scripts'), *sys.path]):
            from pdf_ocr import OcrEngineError
        self.scan()
        m.ocr_step(self.state, recognize=lambda *_: ('보존할 완료 본문', 'fixture'))
        resource_error = OSError('sensitive resource failure')
        resource_error.winerror = 1455
        failures = (OcrEngineError(str(self.root) + ' secret-token'), BrokenPipeError('secret-token'),
                    MemoryError('secret-token'), resource_error)
        for failure in failures:
            with self.subTest(error=type(failure).__name__):
                m.pause(self.state, False)
                before = m.status(self.state)
                with closing(m.database(self.state)) as db:
                    attempts = db.execute('select sum(attempts) from queue').fetchone()[0]
                calls = []
                def fail(*_):
                    calls.append(True)
                    raise failure
                stopped = m.ocr_step(self.state, recognize=fail)
                self.assertEqual(stopped['state'], 'paused')
                status = m.status(self.state)
                self.assertTrue(status['paused'])
                self.assertTrue(status['engineError'])
                self.assertNotIn('secret-token', json.dumps(status))
                self.assertNotIn(str(self.root), json.dumps(status))
                self.assertEqual(status['queue']['error'], 0)
                self.assertEqual(status['queue']['pending'], 1)
                self.assertEqual(status['queue']['done'], before['queue']['done'])
                self.assertEqual(m.ocr_step(self.state, recognize=fail)['state'], 'paused')
                self.assertEqual(len(calls), 1)
                with closing(m.database(self.state)) as db:
                    self.assertEqual(db.execute('select sum(attempts) from queue').fetchone()[0], attempts + 1)
                m.retry(self.state)
                self.assertTrue(m.status(self.state)['paused'])
                self.assertTrue(m.status(self.state)['engineError'])
                self.assertEqual(len(m.search(self.state, '완료 본문')['hits']), 1)
        m.pause(self.state, False)
        self.assertEqual(m.status(self.state)['engineError'], '')
        self.assertEqual(m.ocr_step(self.state, recognize=lambda *_: ('다시 인식한 본문', 'fixture'))['state'], 'done')
        self.assertEqual(m.status(self.state)['queue']['done'], 2)

    def test_offline_ocr_checks_each_resource_once_instead_of_each_page(self):
        self.scan()
        self.root.rename(self.home / 'disconnected')
        with patch.object(m, '_location', wraps=m._location) as locate:
            self.assertEqual(m.ocr_step(self.state, recognize=lambda *_: self.fail('offline OCR'))['state'], 'offline')
        self.assertEqual(locate.call_count, 1)

    def test_offline_ocr_scheduling_observes_cancellation(self):
        self.scan()
        self.root.rename(self.home / 'disconnected')
        checks = iter((False, True))
        with self.assertRaises(InterruptedError):
            m.ocr_step(self.state, recognize=lambda *_: self.fail('offline OCR'), stop=lambda: next(checks, True))

    def test_offline_root_does_not_mark_missing_or_upload_stale_paths(self):
        self.scan()
        self.root.rename(self.home / 'disconnected')
        with self.assertRaises((ValueError, OSError)):
            self.scan()
        self.assertEqual(m.status(self.state)['availableCopies'], 0)
        self.assertEqual(m.prepare_web(self.state)['requests'], [])
        with closing(m.database(self.state)) as db:
            self.assertEqual(db.execute('select state from locations').fetchone()[0], 'verified')

    def test_partial_scan_never_queues_web_registration(self):
        with self.assertRaises(InterruptedError):
            self.scan(stop=lambda: True)
        self.assertEqual(m.prepare_web(self.state)['requests'], [])
        self.scan()
        self.assertEqual(len(m.prepare_web(self.state)['requests']), 1)

    def test_completed_scan_heartbeat_preserves_real_counts_and_completion(self):
        scanned = self.scan()
        value = m.status(self.state)
        self.assertTrue(value.get('scanPending', False))
        heartbeat = value['lastCompletedScan']
        self.assertEqual(heartbeat['scanId'], scanned['run'])
        self.assertEqual(heartbeat['completedAt'], value['scan']['finished_at'])
        self.assertEqual(heartbeat['roots'], [{'rootKey': 'christian', 'available': True, 'checkedCount': 1}, {'rootKey': 'general', 'available': True, 'checkedCount': 0}])
        self.assertNotIn(str(self.root), json.dumps(heartbeat))
        self.pdf('일반도서/addition.pdf', 1)
        with self.assertRaises(InterruptedError):
            self.scan(progress=lambda *_: (_ for _ in ()).throw(InterruptedError('fixture interruption')))
        self.assertEqual(m.status(self.state)['lastCompletedScan'], heartbeat)

    def test_completed_scan_heartbeat_reports_absent_selected_folder_without_count(self):
        (self.root / '일반도서').rmdir()
        self.scan()
        roots = m.status(self.state).get('lastCompletedScan', {}).get('roots', [])
        self.assertIn({'rootKey': 'general', 'available': False}, roots)

    def test_scan_heartbeat_retry_is_immutable_and_can_ack_historical_scan_offline(self):
        self.scan()
        original = m.status(self.state).get('lastCompletedScan')
        self.assertIsNotNone(original)
        self.root.rename(self.home / 'disconnected')
        calls = []
        def send(payload):
            self.fail('Disconnected book locations must not be transmitted')
        def scan(payload):
            self.assertEqual(payload, original)
            calls.append(payload)
            if len(calls) == 1:
                raise OSError(str(self.root) + ' secret-token')
            return {'scanId': payload['scanId'], 'lastCompletedVerificationAt': payload['completedAt'], 'receivedAt': m.now(), 'roots': payload['roots'], 'applied': False}
        send.scan = scan
        result = m.sync_web(self.state, send=send)
        self.assertEqual(result['state'], 'offline')
        self.assertTrue(m.status(self.state)['scanPending'])
        self.assertNotIn('secret-token', json.dumps(result))
        m.sync_web(self.state, send=send)
        self.assertEqual(len(calls), 2)
        self.assertFalse(m.status(self.state)['scanPending'])
        self.assertEqual(m.status(self.state)['lastCompletedScan'], original)

        m.sync_web(self.state, send=send)
        self.assertEqual(len(calls), 2)

    def test_scan_heartbeat_ack_cannot_change_identity_completion_or_counts(self):
        self.scan()
        original = m.status(self.state).get('lastCompletedScan')
        self.assertIsNotNone(original)
        self.root.rename(self.home / 'disconnected')
        def send(payload):
            self.fail('Disconnected book locations must not be transmitted')
        good = {'scanId': original['scanId'], 'lastCompletedVerificationAt': original['completedAt'], 'receivedAt': m.now(), 'roots': original['roots'], 'applied': True}
        for field, changed in (('scanId', str(uuid.uuid4())), ('lastCompletedVerificationAt', '2000-01-01T00:00:00Z'), ('receivedAt', 'not a timestamp'), ('roots', []), ('applied', 'True')):
            bad = dict(good, **{field: changed})
            send.scan = lambda _, response=bad: response
            m.sync_web(self.state, send=send)
            self.assertTrue(m.status(self.state)['scanPending'])

    def test_page_commit_resumes_after_cancellation_and_reopen(self):
        self.scan()
        m.ocr_step(self.state, recognize=lambda *_: ('첫 쪽 본문', 'fixture'))
        with self.assertRaises(InterruptedError):
            m.ocr_step(self.state, recognize=lambda *_: ('discarded', 'fixture'), stop=lambda: True)
        self.assertEqual(m.status(self.state)['queue']['done'], 1)
        self.assertEqual(m.ocr_step(self.state, recognize=lambda *_: ('둘째 쪽 본문', 'fixture'))['state'], 'done')
        self.assertEqual(len(m.search(self.state, '본문')['hits']), 2)

    def test_outbox_retry_is_exact_and_ack_validated_atomically(self):
        self.scan()
        payload = m.prepare_web(self.state)['requests'][0]
        self.assertEqual(m.prepare_web(self.state)['requests'][0], payload)
        item = payload['items'][0]
        raw = json.dumps(payload)
        for forbidden in (str(self.root), 'sha256', 'filehash', 'text', hashlib.sha256(self.path.read_bytes()).hexdigest()):
            self.assertNotIn(forbidden, raw)
        result = {'requestId': payload['requestId'], 'items': [{'resourceId': item['resourceId'], 'bookId': str(uuid.uuid4()), 'documentId': str(uuid.uuid4()), 'bookVersion': 1, 'state': 'registered'}]}
        wrong = json.loads(json.dumps(result))
        wrong['items'][0]['resourceId'] = str(uuid.uuid4())
        with self.assertRaises(ValueError):
            m.apply_web_result(self.state, payload['requestId'], wrong)
        self.assertEqual(len(m.pending_web(self.state)['requests']), 1)
        m.apply_web_result(self.state, payload['requestId'], result)
        self.assertEqual(m.pending_web(self.state)['requests'], [])
        self.assertEqual(m.prepare_web(self.state)['requests'], [])
        # Move triggers a delta carrying confirmed server IDs/version.
        self.path.rename(self.root / '일반도서/renamed.pdf')
        self.scan()
        delta = m.prepare_web(self.state)['requests'][0]['items'][0]
        self.assertEqual(delta['bookId'], result['items'][0]['bookId'])
        self.assertEqual(delta['expectedBookVersion'], 1)

    def test_original_and_legacy_are_readonly_and_legacy_ocr_reused(self):
        index = self.home / 'legacy.sqlite'
        doc = str(uuid.uuid4())
        st = self.path.stat()
        with closing(sqlite3.connect(index)) as db:
            db.executescript('create table documents(id text,title text,path text,root text,bytes int,mtime_ns text,sha256 text,material_kind text,status text,page_count int); create table pages(id integer primary key,document_id text,page_number int,text text,method text); create virtual table pages_fts using fts5(text,content="pages",content_rowid="id",tokenize="trigram");')
            db.execute('insert into documents values(?,?,?,?,?,?,?,?,?,?)', (doc, '이전 제목', str(self.path), str(self.root), st.st_size, str(st.st_mtime_ns), hashlib.sha256(self.path.read_bytes()).hexdigest(), 'book', 'ready', 2))
            db.execute('insert into pages(document_id,page_number,text,method) values(?,1,?,?)', (doc, '기존 OCR 하나님 사랑 ISBN 9780306406157', 'windows_ocr'))
            db.execute('insert into pages(document_id,page_number,text,method) values(?,2,?,?)', (doc, '', 'needs_ocr'))
            db.execute('insert into pages_fts(pages_fts) values("rebuild")')
            db.commit()
        before = (hashlib.sha256(index.read_bytes()).hexdigest(), index.stat().st_mtime_ns, self.path.read_bytes(), self.path.stat().st_mtime_ns)
        self.scan(index=index)
        self.assertEqual(m.status(self.state)['queue']['pending'], 1)
        self.assertEqual(m.status(self.state)['documents'][0]['isbn'], '9780306406157')
        self.path.rename(self.root / '논문/relocated.pdf')
        self.scan(index=index)
        hits = m.search(self.state, '하나님 사랑', index=index)['hits']
        self.assertEqual(hits[0]['id'], doc)
        self.assertTrue(hits[0]['available'])
        m.ocr_step(self.state, index=index, recognize=lambda *_: ('새 OCR 하나님 사랑', 'fixture'))
        self.assertEqual(len(m.search(self.state, '하나님 사랑', index=index)['hits']), 2)
        self.assertTrue(m.render(self.state, doc, 1, index=index)['image'])
        moved = self.root / '논문/relocated.pdf'
        self.assertEqual(before, (hashlib.sha256(index.read_bytes()).hexdigest(), index.stat().st_mtime_ns, moved.read_bytes(), moved.stat().st_mtime_ns))
        self.assertFalse(Path(str(index) + '-wal').exists())

    def test_untrusted_state_db_and_path_escape_rejected(self):
        self.state.mkdir()
        (self.state / m.DB_NAME).write_bytes(b'not a database')
        with self.assertRaises(ValueError):
            m.status(self.state)
        for invalid in ('../escape.pdf', '/absolute.pdf', 'C:/drive.pdf', 'a\\..\\escape.pdf', 'a\n.pdf', '//host/share.pdf', 'CON.pdf', 'a /b.pdf', 'percent%20.pdf', 'a?.pdf'):
            with self.assertRaises(ValueError):
                m.relative_path(invalid)

    def test_no_http_or_cross_origin_transport(self):
        for origin in ('http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?query=1'):
            with self.assertRaises(ValueError):
                m.transport(origin, 'klw_' + 'a' * 43)

    def test_abandoned_page_recovers_and_changed_original_not_searched_as_available(self):
        self.scan()
        resource = m.status(self.state)['documents'][0]['resourceId']
        with closing(m.database(self.state)) as db:
            db.execute("update queue set state='running' where resource_id=? and page_number=1", (resource,))
            db.commit()
        self.assertEqual(m.ocr_step(self.state, recognize=lambda *_: ('복구한 본문', 'fixture'))['state'], 'done')
        self.path.write_bytes(self.path.read_bytes() + b'\n% original changed\n')
        self.assertFalse(m.search(self.state, '복구한 본문')['hits'][0]['available'])
        self.scan()
        self.assertEqual(m.status(self.state)['resources'], 2)

    def test_offline_web_retry_reuses_body_and_never_logs_sensitive_error(self):
        self.scan()
        original = m.prepare_web(self.state)['requests'][0]
        def fail(payload):
            self.assertEqual(payload, original)
            raise OSError(str(self.root) + ' secret-token')
        with self.assertRaises(ValueError) as context:
            m.sync_web(self.state, send=fail)
        self.assertNotIn('secret-token', str(context.exception))
        self.assertEqual(m.pending_web(self.state)['requests'][0], original)
        with closing(m.database(self.state)) as db:
            self.assertNotIn(str(self.root), db.execute('select error from outbox').fetchone()[0])

    def test_queued_locations_superseded_after_move_before_upload(self):
        self.scan()
        old = m.prepare_web(self.state)['requests'][0]
        self.path.rename(self.root / '일반도서/new.pdf')
        self.scan()
        new = m.prepare_web(self.state)['requests'][0]
        self.assertNotEqual(old['requestId'], new['requestId'])
        self.assertEqual(new['items'][0]['locations'], [{'rootKey': 'general', 'relativePath': 'new.pdf'}])

    def test_status_reports_queue_errors_and_completed_pages(self):
        self.scan()
        m.ocr_step(self.state, recognize=lambda *_: ('processed', 'fixture'))
        m.ocr_step(self.state, recognize=lambda *_: (_ for _ in ()).throw(OSError('private path')))
        status = m.status(self.state)
        self.assertEqual(status['totalPages'], 2)
        self.assertEqual(status['completedPages'], 1)
        self.assertEqual(len(status['documents'][0]['errors']), 1)

    def test_management_directory_cannot_be_inside_original_library(self):
        with self.assertRaises(ValueError):
            m.scan(self.root, self.root / 'state')
        self.assertFalse((self.root / 'state').exists())

    def test_legacy_same_bytes_keep_independent_ids(self):
        index = self.home / 'legacy.sqlite'
        ids = [str(uuid.uuid4()), str(uuid.uuid4())]
        st = self.path.stat()
        with closing(sqlite3.connect(index)) as db:
            db.executescript('create table documents(id text,title text,path text,root text,bytes int,mtime_ns text,sha256 text,material_kind text,status text,page_count int); create table pages(id integer primary key,document_id text,page_number int,text text,method text); create virtual table pages_fts using fts5(text,content="pages",content_rowid="id",tokenize="trigram");')
            for doc in ids:
                db.execute('insert into documents values(?,?,?,?,?,?,?,?,?,?)', (doc, 'independent book', str(self.path), str(self.root), st.st_size, str(st.st_mtime_ns), hashlib.sha256(self.path.read_bytes()).hexdigest(), 'book', 'ready', 2))
                db.execute('insert into pages(document_id,page_number,text,method) values(?,1,?,?)', (doc, '별도 도서 본문', 'fixture'))
            db.execute('insert into pages_fts(pages_fts) values("rebuild")')
            db.commit()
        self.scan(index=index)
        self.assertEqual({hit['id'] for hit in m.search(self.state, '도서 본문')['hits']}, set(ids))
        self.assertEqual(m.prepare_web(self.state)['requests'], [])
        self.assertEqual(m.status(self.state)['webHeld'], 2)
        self.assertEqual(m.status(self.state)['webUnresolvedCopies'], 1)
        self.assertTrue(m.status(self.state)['documents'][0]['webIssue'])
        m.ocr_step(self.state, recognize=lambda *_: ('새로 인식한 본문', 'fixture'))
        self.assertEqual({hit['id'] for hit in m.search(self.state, '인식한 본문')['hits']}, set(ids))

    def test_same_bytes_legacy_books_register_independently_and_share_ocr(self):
        second = self.root / '일반도서/second.pdf'
        shutil.copy2(self.path, second)
        ids = [str(uuid.uuid4()), str(uuid.uuid4())]
        index = self.legacy_fixture([(ids[0], 'Independent A', self.path), (ids[1], 'Independent B', second)])
        self.scan(index=index)
        payload = m.prepare_web(self.state)['requests'][0]
        by_doc = {item['legacyDocumentId']: item for item in payload['items']}
        self.assertEqual(set(by_doc), set(ids))
        content = m.status(self.state)['documents'][0]['resourceId']
        self.assertEqual({item['resourceId'] for item in payload['items']}, {str(uuid.uuid5(uuid.UUID(content), 'legacy:' + doc)) for doc in ids})
        self.assertEqual(by_doc[ids[0]]['locations'], [{'rootKey': 'christian', 'relativePath': 'sample.pdf'}])
        self.assertEqual(by_doc[ids[1]]['locations'], [{'rootKey': 'general', 'relativePath': 'second.pdf'}])
        self.assertEqual({item['metadata']['title'] for item in payload['items']}, {'Independent A', 'Independent B'})
        books = {document: str(uuid.uuid4()) for document in ids}
        def versions(documents):
            return {'items': [{'legacyDocumentId': doc, 'bookId': books[doc], 'expectedBookVersion': 8} for doc in documents]}
        def send(batch):
            response = {'requestId': batch['requestId'], 'items': [{'resourceId': item['resourceId'], 'bookId': books[item['legacyDocumentId']], 'documentId': item['legacyDocumentId'], 'bookVersion': 9, 'state': 'registered'} for item in reversed(batch['items'])]}
            wrong = json.loads(json.dumps(response))
            wrong['items'][0]['documentId'] = wrong['items'][1]['documentId']
            with self.assertRaises(ValueError):
                m.apply_web_result(self.state, batch['requestId'], wrong)
            with closing(m.database(self.state)) as db:
                self.assertEqual({row[0] for row in db.execute('select book_version from registrations')}, {8})
            return response
        send.versions = versions
        self.assertEqual(m.sync_web(self.state, send=send)['applied'], 2)
        with closing(m.database(self.state)) as db:
            self.assertEqual({row[0] for row in db.execute('select book_id from registrations')}, set(books.values()))
            self.assertEqual(db.execute('select count(*) from resources').fetchone()[0], 1)
        m.ocr_step(self.state, recognize=lambda *_: ('공유한 OCR 본문', 'fixture'))
        self.assertEqual({hit['id'] for hit in m.search(self.state, '공유한 본문')['hits']}, set(ids))
        with closing(m.database(self.state)) as db:
            self.assertEqual(db.execute('select count(*) from pages').fetchone()[0], 1)

    def test_one_legacy_book_multiple_copies_keep_one_registration(self):
        document = str(uuid.uuid4())
        index = self.legacy_fixture([(document, 'One book', self.path)])
        shutil.copy2(self.path, self.root / '일반도서/copy.pdf')
        self.scan(index=index)
        items = m.prepare_web(self.state)['requests'][0]['items']
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['legacyDocumentId'], document)
        self.assertEqual(len(items[0]['locations']), 2)

    def test_same_bytes_relocations_use_unique_hints_then_verified_inode(self):
        second = self.root / '일반도서/second.pdf'
        shutil.copy2(self.path, second)
        ids = [str(uuid.uuid4()), str(uuid.uuid4())]
        index = self.legacy_fixture([(ids[0], 'A', self.path), (ids[1], 'B', second)])
        (self.root / '기독도서/sub').mkdir()
        moved = self.root / '기독도서/sub/sample.pdf'
        self.path.rename(moved)
        self.scan(index=index)
        initial = {item['legacyDocumentId']: item for item in m.prepare_web(self.state)['requests'][0]['items']}
        self.assertEqual(initial[ids[0]]['locations'][0]['relativePath'], 'sub/sample.pdf')
        moved.rename(self.root / '일반도서/renamed.pdf')
        self.scan(index=index)
        current = {item['legacyDocumentId']: item for request in m.prepare_web(self.state)['requests'] for item in request['items']}
        self.assertEqual(current[ids[0]]['resourceId'], initial[ids[0]]['resourceId'])
        self.assertEqual(current[ids[0]]['locations'], [{'rootKey': 'general', 'relativePath': 'renamed.pdf'}])
        self.assertEqual(current[ids[1]]['locations'], initial[ids[1]]['locations'])

    def test_same_bytes_filename_swap_keeps_verified_book_identity(self):
        second = self.root / '일반도서/second.pdf'
        shutil.copy2(self.path, second)
        ids = [str(uuid.uuid4()), str(uuid.uuid4())]
        index = self.legacy_fixture([(ids[0], 'A', self.path), (ids[1], 'B', second)])
        self.scan(index=index)
        temporary = self.root / 'swapping.pdf'
        self.path.rename(temporary)
        second.rename(self.path)
        temporary.rename(second)
        self.scan(index=index)
        items = {item['legacyDocumentId']: item for request in m.prepare_web(self.state)['requests'] for item in request['items']}
        self.assertEqual(items[ids[0]]['locations'], [{'rootKey': 'general', 'relativePath': 'second.pdf'}])
        self.assertEqual(items[ids[1]]['locations'], [{'rootKey': 'christian', 'relativePath': 'sample.pdf'}])

    def test_new_exact_legacy_alias_overrides_prior_sole_hash_inference(self):
        second = self.root / '일반도서/second.pdf'
        shutil.copy2(self.path, second)
        first_id, second_id = str(uuid.uuid4()), str(uuid.uuid4())
        index = self.legacy_fixture([(first_id, 'A', self.path)])
        self.scan(index=index)
        self.scan(index=index)  # Ordinary scans must not promote inferred proof.
        with closing(sqlite3.connect(index)) as db:
            old = list(db.execute('select * from documents').fetchone())
            old[0:3] = [second_id, 'B', str(second)]
            db.execute('insert into documents values(?,?,?,?,?,?,?,?,?,?)', old)
            db.commit()
        self.scan(index=index)
        items = {item['legacyDocumentId']: item for batch in m.prepare_web(self.state)['requests'] for item in batch['items']}
        self.assertEqual(set(items), {first_id, second_id})
        self.assertEqual(items[first_id]['locations'], [{'rootKey': 'christian', 'relativePath': 'sample.pdf'}])
        self.assertEqual(items[second_id]['locations'], [{'rootKey': 'general', 'relativePath': 'second.pdf'}])

    def test_established_no_legacy_book_is_not_rebound_when_alias_appears(self):
        self.scan()
        pending = m.prepare_web(self.state)['requests'][0]
        content = pending['items'][0]['resourceId']
        book, server_doc, legacy_doc = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
        m.apply_web_result(self.state, pending['requestId'], {'requestId': pending['requestId'], 'items': [{'resourceId': content, 'bookId': book, 'documentId': server_doc, 'bookVersion': 1, 'state': 'registered'}]})
        index = self.legacy_fixture([(legacy_doc, 'Previously separate legacy book', self.path)])
        self.scan(index=index)
        self.assertEqual(m.prepare_web(self.state)['requests'], [])
        self.path.rename(self.root / '일반도서/moved.pdf')
        self.scan(index=index)
        items = m.prepare_web(self.state)['requests'][0]['items']
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['resourceId'], content)
        self.assertEqual(items[0]['bookId'], book)
        self.assertNotIn('legacyDocumentId', items[0])
        with closing(m.database(self.state)) as db:
            row = db.execute('select legacy_document_id,server_document_id from registrations where id=?', (content,)).fetchone()
            self.assertEqual(tuple(row), (None, server_doc))

    def test_attempted_no_legacy_request_keeps_identity_when_alias_appears(self):
        self.scan()
        pending = m.prepare_web(self.state)['requests'][0]
        def fail(payload):
            raise OSError('fixture lost response')
        with self.assertRaises(ValueError):
            m.sync_web(self.state, send=fail)
        legacy_doc = str(uuid.uuid4())
        index = self.legacy_fixture([(legacy_doc, 'Previously separate legacy book', self.path)])
        self.scan(index=index)
        self.assertEqual(m.prepare_web(self.state)['requests'], [pending])

    def test_schema2_attempted_no_legacy_request_is_not_migrated_to_new_alias(self):
        self.scan()
        pending = m.prepare_web(self.state)['requests'][0]
        content = pending['items'][0]['resourceId']
        with closing(m.database(self.state)) as db:
            db.execute('update outbox set attempts=1')
            db.execute('insert into aliases values(?,?)', (str(uuid.uuid4()), content))
            db.execute('drop trigger resources_web_au')
            db.execute('drop table registrations')
            db.execute('alter table locations drop column legacy_document_id')
            db.execute('pragma user_version=2')
            db.commit()
        self.assertEqual(m.prepare_web(self.state)['requests'], [pending])
        with closing(m.database(self.state)) as db:
            self.assertIsNone(db.execute('select legacy_document_id from registrations where id=?', (content,)).fetchone()[0])

    def test_same_content_books_keep_exclusion_and_version_budgets_independent(self):
        second = self.root / '일반도서/second.pdf'
        shutil.copy2(self.path, second)
        ids = [str(uuid.uuid4()), str(uuid.uuid4())]
        books = [str(uuid.uuid4()), str(uuid.uuid4())]
        index = self.legacy_fixture([(ids[0], 'A', self.path), (ids[1], 'B', second)])
        self.scan(index=index)
        first = m.prepare_web(self.state)['requests'][0]
        logical = {item['legacyDocumentId']: item['resourceId'] for item in first['items']}
        m.apply_web_result(self.state, first['requestId'], {'requestId': first['requestId'], 'items': [
            {'resourceId': logical[ids[0]], 'bookId': books[0], 'documentId': ids[0], 'bookVersion': 1, 'state': 'excluded'},
            {'resourceId': logical[ids[1]], 'bookId': books[1], 'documentId': ids[1], 'bookVersion': 4, 'state': 'registered'}]})
        second.rename(self.root / '기독도서/moved-B.pdf')
        self.scan(index=index)
        delta = m.prepare_web(self.state)['requests'][0]
        self.assertEqual([item['resourceId'] for item in delta['items']], [logical[ids[1]]])
        self.assertEqual(delta['items'][0]['bookId'], books[1])
        self.assertEqual(delta['items'][0]['expectedBookVersion'], 4)
        m.apply_web_result(self.state, delta['requestId'], {'requestId': delta['requestId'], 'items': [
            {'resourceId': logical[ids[1]], 'bookId': books[1], 'documentId': ids[1], 'bookVersion': 5, 'state': 'conflict'}]})
        with closing(m.database(self.state)) as db:
            states = dict(db.execute('select legacy_document_id,web_state from registrations'))
            self.assertEqual(states, {ids[0]: 'excluded', ids[1]: 'version_conflict'})
            self.assertEqual(m._setting(db, 'web_cas_retry:' + logical[ids[0]], '0'), '0')
            self.assertEqual(m._setting(db, 'web_cas_retry:' + logical[ids[1]], '0'), '1')

    def test_schema2_pending_request_replays_original_identity_and_body(self):
        self.scan()
        m.ocr_step(self.state, recognize=lambda *_: ('이전 관리 본문', 'fixture'))
        pending = m.prepare_web(self.state)['requests'][0]
        def fail(payload):
            raise OSError('fixture offline')
        with self.assertRaises(ValueError):
            m.sync_web(self.state, send=fail)
        with closing(m.database(self.state)) as db:
            db.execute('drop trigger if exists resources_web_au')
            db.execute('drop table if exists registrations')
            columns = {row[1] for row in db.execute('pragma table_info(locations)')}
            if 'legacy_document_id' in columns:
                db.execute('alter table locations drop column legacy_document_id')
            db.execute('pragma user_version=2')
            db.commit()
        self.assertEqual(m.pending_web(self.state)['requests'], [pending])
        self.assertEqual(len(m.search(self.state, '이전 본문')['hits']), 1)
        def send(payload):
            self.assertEqual(payload, pending)
            return {'requestId': payload['requestId'], 'items': [{'resourceId': payload['items'][0]['resourceId'], 'bookId': str(uuid.uuid4()), 'documentId': str(uuid.uuid4()), 'bookVersion': 1, 'state': 'registered'}]}
        self.assertEqual(m.sync_web(self.state, send=send)['pending'], 0)
        with closing(m.database(self.state)) as db:
            self.assertEqual(db.execute('pragma user_version').fetchone()[0], 3)

    def test_schema2_legacy_pending_request_keeps_content_uuid_and_owned_binding(self):
        document, book = str(uuid.uuid4()), str(uuid.uuid4())
        index = self.legacy_fixture([(document, 'Previous book', self.path)])
        self.scan(index=index)
        pending = m.prepare_web(self.state)['requests'][0]
        content = m.status(self.state)['documents'][0]['resourceId']
        previous_logical = pending['items'][0]['resourceId']
        pending['items'][0].update(resourceId=content, bookId=book, expectedBookVersion=3)
        with closing(m.database(self.state)) as db:
            db.execute('drop trigger resources_web_au')
            db.execute('drop table registrations')
            db.execute('alter table locations drop column legacy_document_id')
            db.execute('update resources set book_id=?,server_document_id=?,book_version=3,web_state=? where id=?', (book, document, 'registered', content))
            db.execute('update outbox set payload=?,attempts=1 where request_id=?', (m._canonical(pending), pending['requestId']))
            db.execute('update outbox_items set resource_id=? where resource_id=?', (content, previous_logical))
            db.execute('pragma user_version=2')
            db.commit()
        self.assertEqual(m.pending_web(self.state)['requests'], [pending])
        def send(payload):
            self.assertEqual(payload, pending)
            return {'requestId': payload['requestId'], 'items': [{'resourceId': content, 'bookId': book, 'documentId': document, 'bookVersion': 4, 'state': 'registered'}]}
        send.versions = lambda _: self.fail('Attempted schema2 body must replay before CAS refresh')
        self.assertEqual(m.sync_web(self.state, send=send)['pending'], 0)
        with closing(m.database(self.state)) as db:
            row = db.execute('select id,resource_id,legacy_document_id,book_id,book_version from registrations').fetchone()
            self.assertEqual(tuple(row), (content, content, document, book, 4))

    def test_excluded_registration_never_automatically_reimports(self):
        self.scan()
        payload = m.prepare_web(self.state)['requests'][0]
        result = {'requestId': payload['requestId'], 'items': [{'resourceId': payload['items'][0]['resourceId'], 'bookId': str(uuid.uuid4()), 'documentId': str(uuid.uuid4()), 'bookVersion': 1, 'state': 'excluded'}]}
        m.apply_web_result(self.state, payload['requestId'], result)
        self.path.rename(self.root / '일반도서/excluded.pdf')
        self.scan()
        self.assertEqual(m.prepare_web(self.state)['requests'], [])

    def test_null_conflict_ack_is_quarantined_without_invented_identity(self):
        self.scan()
        payload = m.prepare_web(self.state)['requests'][0]
        result = {'requestId': payload['requestId'], 'items': [{'resourceId': payload['items'][0]['resourceId'], 'bookId': None, 'documentId': None, 'bookVersion': None, 'state': 'conflict'}]}
        m.apply_web_result(self.state, payload['requestId'], result)
        self.assertEqual(m.status(self.state)['documents'][0]['webState'], 'conflict')
        self.assertEqual(m.prepare_web(self.state)['requests'], [])

    def test_sync_fetches_owner_scoped_versions_before_legacy_upsert(self):
        self.scan()
        resource = m.status(self.state)['documents'][0]['resourceId']
        legacy_id, book = str(uuid.uuid4()), str(uuid.uuid4())
        with closing(m.database(self.state)) as db:
            db.execute('insert into aliases values(?,?)', (legacy_id, resource))
            db.commit()
        calls = []
        def versions(ids):
            calls.append('versions')
            self.assertEqual(ids, [legacy_id])
            return {'items': [{'legacyDocumentId': legacy_id, 'bookId': book, 'expectedBookVersion': 8}]}
        def send(payload):
            calls.append('upsert')
            self.assertEqual(payload['items'][0]['expectedBookVersion'], 8)
            self.assertEqual(payload['items'][0]['bookId'], book)
            return {'requestId': payload['requestId'], 'items': [{'resourceId': resource, 'bookId': book, 'documentId': legacy_id, 'bookVersion': 9, 'state': 'registered'}]}
        send.versions = versions
        self.assertEqual(m.sync_web(self.state, send=send)['applied'], 1)
        self.assertEqual(calls, ['versions', 'upsert'])

    def registered_location_delta(self):
        self.scan()
        first = m.prepare_web(self.state)['requests'][0]
        resource, book, document = first['items'][0]['resourceId'], str(uuid.uuid4()), str(uuid.uuid4())
        m.apply_web_result(self.state, first['requestId'], {'requestId': first['requestId'], 'items': [{'resourceId': resource, 'bookId': book, 'documentId': document, 'bookVersion': 1, 'state': 'registered'}]})
        self.path.rename(self.root / '일반도서/moved.pdf')
        self.scan()
        return resource, book, document, m.prepare_web(self.state)['requests'][0]

    def test_existing_location_delta_refreshes_owned_version_before_new_request(self):
        resource, book, document, stale = self.registered_location_delta()
        calls = []
        def versions(ids):
            self.assertEqual(ids, [document])
            calls.append('versions')
            return {'items': [{'legacyDocumentId': document, 'bookId': book, 'expectedBookVersion': 8}], 'unresolvedDocumentIds': []}
        def send(payload):
            calls.append('send')
            self.assertNotEqual(payload['requestId'], stale['requestId'])
            self.assertEqual(payload['items'][0]['expectedBookVersion'], 8)
            self.assertEqual(payload['items'][0]['locations'], stale['items'][0]['locations'])
            self.assertEqual(payload['items'][0]['metadata'], stale['items'][0]['metadata'])
            return {'requestId': payload['requestId'], 'items': [{'resourceId': resource, 'bookId': book, 'documentId': document, 'bookVersion': 9, 'state': 'registered'}]}
        send.versions = versions
        self.assertEqual(m.sync_web(self.state, send=send)['pending'], 0)
        self.assertEqual(calls, ['versions', 'send'])
        self.assertEqual(m.status(self.state)['documents'][0]['webState'], 'registered')

    def test_same_identity_version_conflict_recovers_after_owned_lookup(self):
        resource, book, document, stale = self.registered_location_delta()
        conflict = {'requestId': stale['requestId'], 'items': [{'resourceId': resource, 'bookId': book, 'documentId': document, 'bookVersion': 2, 'state': 'conflict'}]}
        m.apply_web_result(self.state, stale['requestId'], conflict)
        self.assertEqual(m.status(self.state)['webPending'], 1)
        self.assertEqual(m.prepare_web(self.state)['requests'], [])
        def versions(ids):
            self.assertEqual(ids, [document])
            return {'items': [{'legacyDocumentId': document, 'bookId': book, 'expectedBookVersion': 2}]}
        def send(payload):
            self.assertNotEqual(payload['requestId'], stale['requestId'])
            self.assertEqual(payload['items'][0]['expectedBookVersion'], 2)
            return {'requestId': payload['requestId'], 'items': [{'resourceId': resource, 'bookId': book, 'documentId': document, 'bookVersion': 3, 'state': 'registered'}]}
        send.versions = versions
        self.assertEqual(m.sync_web(self.state, send=send)['applied'], 1)
        self.assertEqual(m.status(self.state)['webPending'], 0)
        self.assertEqual(m.status(self.state)['documents'][0]['webState'], 'registered')

        # Successful recovery ends the old retry budget. A later, distinct move
        # may have its own single confirmed CAS recovery.
        (self.root / '일반도서/moved.pdf').rename(self.root / '기독도서/moved-again.pdf')
        self.scan()
        later = m.prepare_web(self.state)['requests'][0]
        m.apply_web_result(self.state, later['requestId'], {'requestId': later['requestId'], 'items': [{'resourceId': resource, 'bookId': book, 'documentId': document, 'bookVersion': 4, 'state': 'conflict'}]})
        self.assertEqual(m.status(self.state)['webPending'], 1)

    def test_conflict_with_changed_document_is_held_without_overwriting_owned_mapping(self):
        resource, book, document, stale = self.registered_location_delta()
        m.apply_web_result(self.state, stale['requestId'], {'requestId': stale['requestId'], 'items': [{'resourceId': resource, 'bookId': book, 'documentId': str(uuid.uuid4()), 'bookVersion': 2, 'state': 'conflict'}]})
        self.assertEqual(m.status(self.state)['webPending'], 0)
        self.assertEqual(m.prepare_web(self.state)['requests'], [])
        with closing(m.database(self.state)) as db:
            row = db.execute('select book_id,server_document_id,book_version,web_state from resources where id=?', (resource,)).fetchone()
            self.assertEqual(tuple(row), (book, document, 1, 'conflict'))

    def test_repeated_version_conflict_is_held_after_one_owned_retry(self):
        resource, book, document, stale = self.registered_location_delta()
        m.apply_web_result(self.state, stale['requestId'], {'requestId': stale['requestId'], 'items': [{'resourceId': resource, 'bookId': book, 'documentId': document, 'bookVersion': 2, 'state': 'conflict'}]})
        calls = []
        def send(payload):
            calls.append(payload['requestId'])
            return {'requestId': payload['requestId'], 'items': [{'resourceId': resource, 'bookId': book, 'documentId': document, 'bookVersion': 3, 'state': 'conflict'}]}
        send.versions = lambda ids: {'items': [{'legacyDocumentId': document, 'bookId': book, 'expectedBookVersion': 2}]}
        m.sync_web(self.state, send=send)
        m.sync_web(self.state, send=send)
        self.assertEqual(len(calls), 1)
        self.assertEqual(m.status(self.state)['webPending'], 0)
        self.assertEqual(m.status(self.state)['documents'][0]['webState'], 'conflict')

    def test_existing_mapping_missing_or_changed_owner_identity_is_never_rebound(self):
        resource, book, document, stale = self.registered_location_delta()
        def send(payload):
            self.fail('Unresolved or changed identity must not be uploaded')
        for response in ({'items': [], 'unresolvedDocumentIds': [document]},
                         {'items': [{'legacyDocumentId': document, 'bookId': str(uuid.uuid4()), 'expectedBookVersion': 2}]}):
            # Re-examine the same previously owned mapping, never replace its IDs.
            with closing(m.database(self.state)) as db:
                db.execute("update resources set web_state='registered' where id=?", (resource,))
                db.commit()
            send.versions = lambda ids, value=response: value
            self.assertEqual(m.sync_web(self.state, send=send)['pending'], 0)
            with closing(m.database(self.state)) as db:
                row = db.execute('select book_id,server_document_id,web_state from resources where id=?', (resource,)).fetchone()
                self.assertEqual(tuple(row), (book, document, 'conflict'))

    def test_attempted_existing_request_replays_exact_body_before_version_refresh(self):
        resource, book, document, pending = self.registered_location_delta()
        def fail(payload):
            self.assertEqual(payload, pending)
            raise OSError('fixture lost response')
        with self.assertRaises(ValueError):
            m.sync_web(self.state, send=fail)
        def send(payload):
            self.assertEqual(payload, pending)
            return {'requestId': payload['requestId'], 'items': [{'resourceId': resource, 'bookId': book, 'documentId': document, 'bookVersion': 2, 'state': 'registered'}]}
        send.versions = lambda _: self.fail('Attempted immutable request must replay before refreshing its CAS version')
        self.assertEqual(m.sync_web(self.state, send=send)['pending'], 0)

    def test_unresolved_legacy_mapping_is_quarantined_without_blocking_new_pdf(self):
        new_path = self.pdf('일반도서/new.pdf', 1)
        self.scan()
        with closing(m.database(self.state)) as db:
            stale_resource = db.execute('select resource_id from locations where path=?', (str(self.path),)).fetchone()[0]
            fresh_resource = db.execute('select resource_id from locations where path=?', (str(new_path),)).fetchone()[0]
            stale_id = str(uuid.uuid4())
            db.execute('insert into aliases values(?,?)', (stale_id, stale_resource))
            db.commit()
        m.prepare_web(self.state)
        book, document = str(uuid.uuid4()), str(uuid.uuid4())
        def versions(ids):
            self.assertEqual(ids, [stale_id])
            return {'items': [], 'unresolvedDocumentIds': [stale_id]}
        def send(payload):
            self.assertEqual([item['resourceId'] for item in payload['items']], [fresh_resource])
            return {'requestId': payload['requestId'], 'items': [{'resourceId': fresh_resource, 'bookId': book, 'documentId': document, 'bookVersion': 1, 'state': 'registered'}]}
        send.versions = versions
        self.assertEqual(m.sync_web(self.state, send=send)['applied'], 1)
        with closing(m.database(self.state)) as db:
            held = db.execute('select * from resources where id=?', (stale_resource,)).fetchone()
            self.assertEqual(held['web_state'], 'conflict')
            self.assertIsNone(held['book_id'])
            self.assertEqual(db.execute('select resource_id from aliases where document_id=?', (stale_id,)).fetchone()[0], stale_resource)
        self.assertEqual(m.pending_web(self.state)['requests'], [])

    def test_partial_versions_reject_unaccounted_or_overlapping_ids_atomically(self):
        self.scan()
        resource = m.status(self.state)['documents'][0]['resourceId']
        legacy_id, book = str(uuid.uuid4()), str(uuid.uuid4())
        with closing(m.database(self.state)) as db:
            db.execute('insert into aliases values(?,?)', (legacy_id, resource))
            db.commit()
        found = {'legacyDocumentId': legacy_id, 'bookId': book, 'expectedBookVersion': 8}
        for result in ({'items': [], 'unresolvedDocumentIds': []},
                       {'items': [found], 'unresolvedDocumentIds': [legacy_id]},
                       {'items': [], 'unresolvedDocumentIds': [legacy_id, legacy_id]},
                       {'items': [], 'unresolvedDocumentIds': [str(uuid.uuid4())]}):
            with self.subTest(result=result), self.assertRaises(ValueError):
                m.refresh_versions(self.state, lambda _: result)
            with closing(m.database(self.state)) as db:
                row = db.execute('select book_id,web_state from resources where id=?', (resource,)).fetchone()
                self.assertEqual(tuple(row), (None, None))

    def test_offline_snapshot_blocks_previously_queued_web_sends(self):
        self.scan()
        m.prepare_web(self.state)
        self.root.rename(self.home / 'offline')
        def forbidden(payload):
            self.fail('Disconnected locations must not be transmitted')
        result = m.sync_web(self.state, send=forbidden)
        self.assertEqual(result['state'], 'offline')
        self.assertEqual(len(m.pending_web(self.state)['requests']), 1)

    def test_safe_transport_posts_only_fixed_endpoint_and_rejects_redirects(self):
        class Response:
            status = 302
            def read(self, *_):
                return b'{}'
        class Connection:
            def __init__(self, *args, **kwargs):
                pass
            def request(inner, method, path, body, headers):
                self.assertEqual((method, path), ('POST', '/api/desktop/library'))
                self.assertEqual(headers['Authorization'], 'Bearer klw_' + 'a' * 43)
            def getresponse(self):
                return Response()
            def close(self):
                pass
        with patch.object(m.http.client, 'HTTPSConnection', Connection):
            with self.assertRaises(ValueError):
                m.transport('https://example.com', 'klw_' + 'a' * 43)({'items': []})

    def test_transport_uses_opt_in_partial_versions_and_fixed_scan_endpoint(self):
        calls = []
        class Response:
            status = 200
            def read(self, *_):
                return b'{}'
        class Connection:
            def __init__(self, *args, **kwargs):
                pass
            def request(self, method, path, body, headers):
                calls.append((method, path, json.loads(body)))
            def getresponse(self):
                return Response()
            def close(self):
                pass
        self.scan()
        heartbeat = m.status(self.state)['lastCompletedScan']
        legacy_id = str(uuid.uuid4())
        with patch.object(m.http.client, 'HTTPSConnection', Connection):
            send = m.transport('https://fixture.example.invalid', 'klw_' + 'a' * 43)
            send.versions([legacy_id])
            send.scan(heartbeat)
        self.assertEqual(calls, [('POST', '/api/desktop/catalog/versions', {'documentIds': [legacy_id], 'allowPartial': True}),
                                 ('POST', '/api/desktop/library/scans', heartbeat)])

    def test_registration_batches_fit_server_byte_limit_and_utf16_bounds(self):
        self.scan()
        items = [dict(resourceId=str(uuid.uuid4()), metadata={'title': '😀' * 150}, locations=[{'rootKey': 'christian', 'relativePath': ('한' * 980) + str(n) + '.pdf'} for n in range(32)]) for _ in range(15)]
        with patch.object(m, '_web_items', return_value=items):
            requests = m.prepare_web(self.state)['requests']
        self.assertGreater(len(requests), 1)
        self.assertEqual(sum(len(r['items']) for r in requests), 15)
        self.assertTrue(all(len(json.dumps(r, ensure_ascii=False).encode()) <= 1024 * 1024 for r in requests))
        self.assertLessEqual(len(m._title('😀' * 300).encode('utf-16-le')), 600)
        self.assertNotIn('Users', m._title('C:\\Users\\private\\book.pdf'))

    def test_review_material_remains_locally_searchable(self):
        self.scan()
        with closing(m.database(self.state)) as db:
            db.execute("update resources set kind='review'")
            db.commit()
        m.ocr_step(self.state, recognize=lambda *_: ('분류 보류 본문', 'fixture'))
        self.assertEqual(len(m.search(self.state, '보류 본문', kind='review')['hits']), 1)

    def test_status_limit_preserves_global_counts_and_current_title(self):
        paper = self.pdf('논문/other.pdf', 1)
        paper.write_bytes(paper.read_bytes() + b'\n% another\n')
        self.scan()
        status = m.status(self.state, limit=1)
        self.assertEqual((len(status['documents']), status['resources'], status['totalPages']), (1, 2, 3))
        self.assertTrue(status['documentsTruncated'])
        with closing(m.database(self.state)) as db:
            db.execute("update queue set state='running' where page_number=1")
            db.commit()
        self.assertTrue(m.status(self.state, limit=1)['current']['title'])

    def test_embedded_metadata_and_first_two_pages_seed_valid_isbn(self):
        self.path.unlink()
        self.text_pdf('기독도서/bibliography.pdf', ['ISBN 0-306-40615-2', 'front page', 'ISBN 9780131103627'], {'Title': 'Embedded title', 'Author': 'Fixture Author', 'Publisher': 'Fixture Publisher'})
        self.scan()
        metadata = m.prepare_web(self.state)['requests'][0]['items'][0]['metadata']
        self.assertEqual(metadata, {'title': 'Embedded title', 'author': 'Fixture Author', 'publisher': 'Fixture Publisher', 'isbn': '9780306406157', 'totalPages': 3})
        self.assertEqual(m.status(self.state)['documents'][0]['isbn'], '9780306406157')

    def test_front_ocr_isbn_creates_safe_metadata_delta_without_overwrite(self):
        self.scan()
        first = m.prepare_web(self.state)['requests'][0]
        resource = first['items'][0]['resourceId']
        m.apply_web_result(self.state, first['requestId'], {'requestId': first['requestId'], 'items': [{'resourceId': resource, 'bookId': str(uuid.uuid4()), 'documentId': str(uuid.uuid4()), 'bookVersion': 4, 'state': 'registered'}]})
        changed = m.ocr_step(self.state, recognize=lambda *_: ('ISBN 978-0-306-40615-7', 'fixture'))
        self.assertTrue(changed.get('webMetadataChanged', False))
        delta = m.prepare_web(self.state)['requests'][0]['items'][0]
        self.assertEqual(delta['metadata']['isbn'], '9780306406157')
        self.assertEqual(delta['expectedBookVersion'], 4)
        unchanged = m.ocr_step(self.state, recognize=lambda *_: ('ISBN 9780131103627', 'fixture'))
        self.assertFalse(unchanged.get('webMetadataChanged', False))
        self.assertEqual(m.status(self.state)['documents'][0]['isbn'], '9780306406157')

    def test_isbn_checksum_ambiguity_and_reference_context_are_rejected(self):
        self.assertEqual(m.isbn13('0-306-40615-2'), '9780306406157')
        self.assertEqual(m.isbn13('9780306406158'), '')
        self.assertEqual(m.discover_isbn('ISBN 9780306406157 and ISBN 9780131103627'), '')
        self.assertEqual(m.discover_isbn('References: ISBN 9780306406157'), '')
        self.assertEqual(m.discover_isbn('ISBN ９７８０３０６４０６１５７'), '9780306406157')

    def test_ocr_isbn_discovery_stops_after_front_twenty_pages(self):
        self.path.unlink()
        self.pdf('기독도서/large.pdf', 21)
        self.scan()
        with closing(m.database(self.state)) as db:
            db.execute("update queue set state='done' where page_number<=20")
            db.commit()
        self.assertEqual(m.ocr_step(self.state, recognize=lambda *_: ('ISBN 9780306406157', 'fixture'))['page'], 21)
        self.assertFalse(m.status(self.state)['documents'][0]['isbn'])

    def test_existing_management_schema_upgrades_without_losing_page_queue(self):
        self.scan()
        document = m.status(self.state)['documents'][0]['id']
        m.ocr_step(self.state, recognize=lambda *_: ('보존할 기존 본문', 'fixture'))
        with closing(m.database(self.state)) as db:
            for column in ('author', 'publisher', 'isbn', 'metadata_checked'):
                db.execute('alter table resources drop column ' + column)
            db.execute('pragma user_version=1')
            db.commit()
        self.assertEqual(m.status(self.state)['queue']['done'], 1)
        self.assertEqual(m.search(self.state, '기존 본문')['hits'][0]['id'], document)
        self.scan()
        with closing(m.database(self.state)) as db:
            self.assertEqual(db.execute('pragma user_version').fetchone()[0], 3)
            self.assertEqual(db.execute('select metadata_checked from resources').fetchone()[0], 1)


if __name__ == '__main__':
    unittest.main()
