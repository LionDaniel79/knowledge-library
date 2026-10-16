"""Compare OCR modes using identical source pages and isolated small indexes."""
import argparse
import hashlib
import importlib.util
import json
import statistics
import time
from pathlib import Path
from pdf_library import connect
from pdf_maintenance import readonly
from pdf_ocr import WindowsOcr, ocr_work
from pdf_ocr_store import source_status


def sample_pages(source, books=5, pages=12):
    db=readonly(source)
    try:
        candidates=db.execute("SELECT id FROM documents WHERE processing_scope='full' AND status IN ('needs_ocr','partial_ocr','ocr_review') AND indexed_pages>=page_count AND page_count>=? ORDER BY id", (pages,)).fetchall()
        samples=[]
        for candidate in candidates:
            numbers=[row[0] for row in db.execute("SELECT page_number FROM pages WHERE document_id=? AND method='needs_ocr' ORDER BY page_number LIMIT ?",(candidate['id'],pages))]
            if len(numbers)!=pages:continue
            document=dict(db.execute('SELECT * FROM documents WHERE id=?',(candidate['id'],)).fetchone())
            if source_status(document):continue
            samples.append({'document':document,'pages':numbers})
            if len(samples)==books:break
        if len(samples)!=books:raise ValueError('비교할 미처리 페이지가 부족합니다.')
        return samples
    finally:db.close()


def create_fixture(target,samples):
    target=Path(target)
    for sample in samples:
        doc=sample['document']
        if doc['processing_scope']!='full' or any(not isinstance(n,int) or not 1<=n<=doc['page_count'] for n in sample['pages']):
            raise ValueError('잘못된 벤치마크 범위입니다.')
    target.parent.mkdir(parents=True,exist_ok=True)
    target.touch(exist_ok=False)
    db=connect(target)
    try:
        columns=[row['name'] for row in db.execute('PRAGMA table_info(documents)')]
        for sample in samples:
            doc={**sample['document'],'text_pages':0,'status':'needs_ocr','scope_override':1,'metadata':'{}','toc':'[]'}
            keys=[key for key in columns if key in doc]
            db.execute('INSERT INTO documents('+','.join(keys)+') VALUES('+','.join('?' for _ in keys)+')',[doc[key] for key in keys])
            for page in sample['pages']:
                db.execute("INSERT INTO pages(document_id,page_number,text,method) VALUES(?,?,'','needs_ocr')",(doc['id'],page))
        db.commit()
    finally:db.close()


def fingerprints(index):
    db=readonly(index)
    try:
        return {str(row['document_id'])+':'+str(row['page_number']):{'textHash':hashlib.sha256(row['text'].encode()).hexdigest(),'method':row['method']} for row in db.execute('SELECT document_id,page_number,text,method FROM pages')}
    finally:db.close()


def run_benchmark(source,output,baseline=None,books=5,pages=12,repeats=2):
    if books<1 or pages<1 or repeats<1:raise ValueError('표본 크기는 양수여야 합니다.')
    output=Path(output)
    output.mkdir(parents=True,exist_ok=False)
    samples=sample_pages(source,books,pages)
    (output/'samples.json').write_text(json.dumps(samples,ensure_ascii=False,indent=2),encoding='utf-8')
    legacy=None
    if baseline:
        spec=importlib.util.spec_from_file_location('ocr_baseline',baseline)
        legacy=importlib.util.module_from_spec(spec);spec.loader.exec_module(legacy)
    modes=(['legacy'] if legacy else [])+['memory-1','memory-2']
    reference=None;runs=[]
    for repeat in range(repeats):
        for mode in (modes if repeat%2==0 else list(reversed(modes))):
            index=output/f'{mode}-{repeat+1}.sqlite'
            create_fixture(index,samples)
            engines=[]
            try:
                for _ in range(2 if mode=='memory-2' else 1):engines.append(WindowsOcr('ko'))
                start=time.perf_counter()
                counts=legacy.ocr_work(index,engines[0],min_free_bytes=0) if mode=='legacy' else ocr_work(index,engines,min_free_bytes=0)
                elapsed=time.perf_counter()-start
            finally:
                for engine in engines:engine.close()
            actual=fingerprints(index)
            if reference is None:reference=actual
            quality=actual==reference and len(actual)==books*pages and counts['errors']==0 and counts['stale']==0 and all(row['method'] in ('ocr_unverified','ocr_empty') for row in actual.values())
            row={'mode':mode,'repeat':repeat+1,'seconds':round(elapsed,3),'pagesPerMinute':round(books*pages/elapsed*60,2),'qualityMatch':quality,'counts':counts}
            runs.append(row)
            (output/'runs.json').write_text(json.dumps(runs,ensure_ascii=False,indent=2),encoding='utf-8')
            print(json.dumps(row),flush=True)
            if not quality:raise RuntimeError('동일 페이지 인식 결과가 일치하지 않습니다. 운영 전환을 중단합니다.')
    if any(source_status(sample['document']) for sample in samples):raise RuntimeError('비교 중 원본이 변경되었습니다.')
    medians={mode:round(statistics.median(row['seconds'] for row in runs if row['mode']==mode),3) for mode in modes}
    best=min(('memory-1','memory-2'),key=medians.get)
    report={'books':books,'pages':books*pages,'repeats':repeats,'qualityMatch':True,'medianSeconds':medians,'recommendedWorkers':int(best[-1]),'speedupOverLegacy':round(medians['legacy']/medians[best],2) if legacy else None,'runs':runs}
    (output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',required=True);parser.add_argument('--output',required=True);parser.add_argument('--baseline')
    parser.add_argument('--books',type=int,default=5);parser.add_argument('--pages',type=int,default=12);parser.add_argument('--repeats',type=int,default=2)
    args=parser.parse_args()
    print(json.dumps(run_benchmark(args.source,args.output,args.baseline,args.books,args.pages,args.repeats),ensure_ascii=False),flush=True)
