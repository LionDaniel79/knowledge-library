"""Read-only verification against a completed registry and its original index."""
import argparse
import json
import uuid
from pathlib import Path

from api_v2 import prepare, items_digest
from reader import source
from manifest import _preview


def audit(index, root, directory):
    root = Path(root).absolute()
    rows = _preview(index,root,directory,server_items=True)
    with source(Path(directory)/'desktop-registry-v2.sqlite') as db, source(index) as src:
        run = db.execute('select * from scan_runs order by rowid desc limit 1').fetchone()
        old = {r[0] for r in src.execute('select id from documents')}
        mapped = {r[0] for r in db.execute("""select w.legacy_id from web_registration w
            join location l using(path) where l.run=? and l.state='verified'""",(run['id'],))}
        review = db.execute("select count(*) from location where run=? and state!='verified'",(run['id'],)).fetchone()[0]
    totals = {g:sum(r['copiesByRoot'][g] for r in rows) for g in ('christian','general')}
    result = dict(scanComplete=True,rootsAvailable=True,allPhysicalFiles=run['files'],
                  physicalByRoot=totals,physicalFiles=sum(totals.values()),uniqueDocuments=len(rows),
                  extraCopies=sum(totals.values())-len(rows),missingOldDocuments=len(old-mapped),
                  legacyDocuments=len(old),unresolvedFileMatches=review,serverManifestId=None,
                  acceptedItems=0,versionConflicts=None,serverApplied=False)
    try:
        prepare(rows,str(uuid.uuid4()))
        result.update(itemsDigest=items_digest(rows),localContractValid=True)
    except ValueError as exc:
        result.update(itemsDigest=None,localContractValid=False,contractError=str(exc))
    return result


if __name__=='__main__':
    p=argparse.ArgumentParser()
    for key in ('index','root','directory'):p.add_argument(key)
    print(json.dumps(audit(**vars(p.parse_args())),indent=2))
