"""Windows manifest v2. Only staging and preview endpoints are implemented."""
import hashlib
import http.client
import json
import os
import re
import ssl
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from manifest import _preview


BASE = '/api/desktop/catalog/manifests'
ROOTS = ('christian', 'general')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def valid_uuid(value):
    return isinstance(value, str) and re.fullmatch(
        r'(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)', value, re.I) is not None


def items_digest(items):
    canonical = sorted(([r['legacyDocumentId'].lower(), r['bookId'].lower(),
                         r['expectedBookVersion'], *(r['copiesByRoot'][g] for g in ROOTS)]
                        for r in items), key=lambda r: r[0])
    return hashlib.sha256(json.dumps(canonical, separators=(',', ':')).encode()).hexdigest()


def inventory(index, root, directory):
    return _preview(index, Path(root).absolute(), directory, server_items=True)


def prepare(rows, operation):
    require(valid_uuid(operation), 'Invalid operation UUID')
    seen = set()
    totals = dict.fromkeys(ROOTS, 0)
    for r in rows:
        require(set(r) == {'legacyDocumentId','bookId','expectedBookVersion','copiesByRoot'},
                'Unexpected item fields')
        require(all(valid_uuid(r[k]) and r[k] == r[k].lower() for k in ('legacyDocumentId','bookId')),
                'Unverified identity')
        require(r['legacyDocumentId'] not in seen, 'Duplicate document')
        seen.add(r['legacyDocumentId'])
        version = r['expectedBookVersion']
        require(type(version) is int and 1 <= version <= 2147483647, 'Unknown book version')
        copies = r['copiesByRoot']
        require(set(copies) == set(ROOTS), 'Unknown root')
        for g in ROOTS:
            n = copies[g]
            require(type(n) is int and 0 <= n <= 100, 'Invalid copy count')
            totals[g] += n
        require(sum(copies.values()) > 0, 'Document has no copies')
    require(0 < len(rows) <= 100000 and max(totals.values()) <= 100000, 'Manifest size invalid')
    return dict(operationId=operation, scanComplete=True, rootsAvailable=True,
                physicalByRoot=totals, expectedDocuments=len(rows))


def check_snapshot(snapshot, origin, rows):
    require(snapshot['origin'] == origin and 0 <= time.time()-snapshot['verifiedAtUnix'] <= 3600,
            'Fresh test-owner version export required')
    entries = snapshot['items']
    expected = {r['legacyDocumentId']: (r['bookId'], r['expectedBookVersion']) for r in entries
                if type(r['expectedBookVersion']) is int}
    require(len(expected) == len(entries) and all(expected.get(r['legacyDocumentId']) ==
            (r['bookId'],r['expectedBookVersion']) for r in rows), 'Version or identity mismatch')


def transport(origin, token, protection_bypass=None):
    require(re.fullmatch(r'https://[A-Za-z0-9.-]+(?::[0-9]+)?', origin), 'HTTPS test origin required')
    # A preview still writes manifests to a database. Require an explicit,
    # exact-match allowlist to prevent accidental use of a production origin.
    allowed = os.environ.get('KL_STAGE5_TEST_ORIGIN', '')
    require(allowed and origin == allowed, 'Explicit isolated test origin allowlist required')
    target = urlsplit(origin)
    require(re.fullmatch(r'klw_[A-Za-z0-9_-]{43}', token) is not None, 'Invalid device credential')
    if protection_bypass is not None:
        # A separate Vercel automation bypass is required for SSO-protected QA.
        # Never log it, put it on a command line or send it to another origin.
        require(isinstance(protection_bypass, str) and
                re.fullmatch(r'[A-Za-z0-9]{32}', protection_bypass) is not None,
                'Invalid protected-deployment credential')
    context = ssl.create_default_context()
    def send(method, path, payload):
        for attempt in range(3):
            conn = http.client.HTTPSConnection(target.hostname, target.port, timeout=25, context=context)
            try:
                headers = {'Authorization': 'Bearer '+token,
                           'Content-Type': 'application/json'}
                if protection_bypass is not None:
                    headers['x-vercel-protection-bypass'] = protection_bypass
                conn.request(method, path, json.dumps(payload).encode(), headers)
                response = conn.getresponse()
                if response.status in (408,429,502,503,504) and attempt < 2:
                    pass
                elif response.status != 200 and response.status != 201:
                    raise ValueError(f'Manifest API HTTP {response.status}')
                else:
                    raw = response.read(65537)
                    require(len(raw) <= 65536, 'Response too large')
                    result = json.loads(raw)
                    require(isinstance(result,dict), 'Invalid response')
                    return result
            except ssl.SSLError:
                raise ValueError('TLS validation failed') from None
            except (OSError,http.client.HTTPException):
                if attempt == 2:
                    raise ValueError('Connection interrupted; reuse same operation') from None
            finally:
                conn.close()
            time.sleep(2**attempt)
    return send


def submit(rows, operation, send):
    head = prepare(rows, operation)
    digest = items_digest(rows)
    start = send('POST', BASE, head)
    mid = start.get('manifestId')
    require(valid_uuid(mid) and start.get('operationId') == operation and
            start.get('status') in ('collecting','sealed'), 'Unexpected start response')
    path = BASE+'/'+mid
    if start['status'] == 'collecting':
        for offset in range(0,len(rows),200):
            batch = rows[offset:offset+200]
            ack = send('PUT',path+'/items',{'items':batch})
            require(type(ack.get('accepted')) is int and ack['accepted'] == len(batch), 'Incomplete batch')
    seal = send('POST',path+'/seal',{'itemsDigest':digest})
    require(seal.get('manifestId') == mid and seal.get('status') == 'sealed' and
            seal.get('itemsDigest') == digest,'Seal mismatch')
    result = send('POST',path+'/preview',{})
    require(result.get('manifestId') == mid and result.get('status') == 'preview' and
            type(result.get('selectedDocuments')) is int and result['selectedDocuments'] == len(rows),
            'Preview count mismatch')
    for key in ('missing','versionConflicts'):
        require(type(result.get(key)) is int and result[key] == 0, 'Preview blocked: '+key)
    return dict(serverManifestId=mid, itemsDigest=digest, acceptedItems=len(rows),
                versionConflicts=0, serverApplied=False)


if __name__ == '__main__':
    import argparse
    import sys
    parser = argparse.ArgumentParser()
    for key in ('index','root','directory','test-origin','version-export','operation'):
        parser.add_argument('--'+key, required=True)
    parser.add_argument('--vercel-protected', action='store_true',
                        help='Read a separate 32-character Vercel QA bypass from stdin')
    args = parser.parse_args()
    try:
        rows = inventory(args.index,args.root,args.directory)
        check_snapshot(json.loads(Path(args.version_export).read_bytes()),args.test_origin,rows)
        token = sys.stdin.readline().strip()
        bypass = sys.stdin.readline().strip() if args.vercel_protected else None
        print(json.dumps(submit(rows,args.operation,transport(args.test_origin,token,bypass))))
    except (OSError, KeyError, TypeError, ValueError, RuntimeError) as error:
        print(str(error) if type(error) is ValueError else 'Local verification failed',file=sys.stderr)
        sys.exit(1)
