import ssl
import time
import unittest
import uuid
from unittest.mock import Mock, patch

import api_v2 as api


def uid(n):
    return str(uuid.UUID(int=n,version=4))


def rows(n):
    return [dict(legacyDocumentId=uid(i+1),bookId=uid(i+501),expectedBookVersion=3,
                 copiesByRoot={'christian':1,'general':int(i==0)}) for i in range(n)]


class Contract(unittest.TestCase):
    def transport(self, statuses, **kwargs):
        conn = Mock()
        responses = [Mock(status=s) for s in statuses]
        for r in responses:
            r.read.return_value = b'{"ok":true}'
        conn.getresponse.side_effect = responses
        with patch.dict(api.os.environ,{'KL_STAGE5_TEST_ORIGIN':'https://test.invalid'}), patch.object(api.http.client,'HTTPSConnection',return_value=conn), patch.object(api.time,'sleep'):
            try:
                return api.transport('https://test.invalid','klw_'+'a'*43)('POST',api.BASE,{})
            finally:
                self.assertEqual(conn.request.call_count,len(statuses))

    def test_transient_retry(self):
        self.assertEqual(self.transport([503,200]),{'ok':True})

    def test_denials_no_redirect_or_retry(self):
        for code in [301,401,403,409]:
            with self.subTest(code=code),self.assertRaisesRegex(ValueError,str(code)):
                self.transport([code])

    def test_disallow_unapproved_or_production_origin(self):
        # Manifest staging changes DB state; HTTPS alone is not sufficient
        # proof that a destination is an isolated staging environment.
        with patch.dict(api.os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, 'allowlist'):
                api.transport('https://test.invalid', 'klw_'+'a'*43)
        with patch.dict(api.os.environ, {'KL_STAGE5_TEST_ORIGIN':'https://test.invalid'}):
            with self.assertRaisesRegex(ValueError, 'allowlist'):
                api.transport('https://production.example', 'klw_'+'a'*43)

    def test_protected_qa_adds_separate_header(self):
        conn = Mock()
        response = Mock(status=200)
        response.read.return_value = b'{"ok":true}'
        conn.getresponse.return_value = response
        token = 'klw_' + 'a' * 43
        bypass = 'B' * 32
        with patch.dict(api.os.environ, {'KL_STAGE5_TEST_ORIGIN':'https://test.invalid'}), \
             patch.object(api.http.client, 'HTTPSConnection', return_value=conn):
            result = api.transport('https://test.invalid', token, bypass)('POST', api.BASE, {})
        self.assertEqual(result, {'ok': True})
        sent = conn.request.call_args.args[3]
        self.assertEqual(sent.get('Authorization'), 'Bearer ' + token)
        self.assertEqual(sent.get('x-vercel-protection-bypass'), bypass)
        self.assertEqual(conn.request.call_count, 1)

    def test_bypass_rejected_before_network_and_never_sent_by_default(self):
        token = 'klw_' + 'a' * 43
        with patch.dict(api.os.environ, {'KL_STAGE5_TEST_ORIGIN':'https://test.invalid'}):
            for invalid in ('', 'short', 'x'*31, 'x'*33, 'x' * 31 + '\\n', 'a' * 31 + '-'):
                with self.subTest(invalid_length=len(invalid)), self.assertRaisesRegex(ValueError, 'protected-deployment'):
                    api.transport('https://test.invalid', token, invalid)
            conn = Mock()
            response = Mock(status=200)
            response.read.return_value = b'{"ok":true}'
            conn.getresponse.return_value = response
            with patch.object(api.http.client, 'HTTPSConnection', return_value=conn):
                api.transport('https://test.invalid', token)('POST', api.BASE, {})
            headers = conn.request.call_args.args[3]
            self.assertNotIn('x-vercel-protection-bypass', headers)

    def test_tls_failure(self):
        conn = Mock()
        conn.request.side_effect = ssl.SSLCertVerificationError()
        with patch.dict(api.os.environ,{'KL_STAGE5_TEST_ORIGIN':'https://test.invalid'}), patch.object(api.http.client,'HTTPSConnection',return_value=conn):
            with self.assertRaisesRegex(ValueError,'TLS validation'):
                api.transport('https://test.invalid','klw_'+'a'*43)('POST',api.BASE,{})
        self.assertEqual(conn.request.call_count,1)

    def test_digest_order_and_fields(self):
        items = rows(2)
        self.assertEqual(api.items_digest(items[::-1]),api.items_digest(items))
        self.assertEqual(api.prepare(items,uid(999))['physicalByRoot'],{'christian':2,'general':1})
        for bad in [dict(bookId=None),dict(expectedBookVersion=True),dict(extra='private')]:
            with self.assertRaises(ValueError):api.prepare([items[0]|bad],uid(999))

    def test_stale_and_wrong_owner_export(self):
        items = rows(1)
        for stamp, data in [(0,items),(time.time(),[])]:
            with self.assertRaises(ValueError):
                api.check_snapshot(dict(origin='test',verifiedAtUnix=stamp,items=data),'test',items)

    def test_batch_replay_and_conflicts(self):
        items = rows(201)
        op,mid = uid(800),uid(900)
        for sealed, conflict in [(False,0),(True,0),(False,1)]:
            responses = [dict(manifestId=mid,operationId=op,status='sealed' if sealed else 'collecting')]
            if not sealed:responses.extend([dict(accepted=200),dict(accepted=1)])
            responses.extend([dict(manifestId=mid,status='sealed',itemsDigest=api.items_digest(items)),
                              dict(manifestId=mid,status='preview',selectedDocuments=201,missing=0,versionConflicts=conflict)])
            send = Mock(side_effect=responses)
            if conflict:
                with self.assertRaisesRegex(ValueError,'versionConflicts'):api.submit(items,op,send)
            else:self.assertFalse(api.submit(items,op,send)['serverApplied'])
            sizes = [len(c.args[2]['items']) for c in send.call_args_list if c.args[0]=='PUT']
            self.assertEqual(sizes,[] if sealed else [200,1])

    def test_interruption(self):
        send = Mock(side_effect=[dict(manifestId=uid(100),operationId=uid(101),status='collecting'),KeyboardInterrupt])
        with self.assertRaises(KeyboardInterrupt):api.submit(rows(1),uid(101),send)
        self.assertEqual(send.call_count,2)
