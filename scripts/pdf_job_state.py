"""Small atomic progress files and OS locks, colocated with the external index."""
import json,os,time
from pathlib import Path
from contextlib import contextmanager
from datetime import datetime,timezone
from functools import lru_cache

REPLACE_RETRY_SECONDS=2

@lru_cache(maxsize=64)
def _canonical_index(absolute):
    return Path(absolute).resolve()

def resolved_index(index):
    # Freeze a job's canonical location at lock acquisition. Repeated Win32
    # handle-based resolution on an external disk is unnecessary per page.
    return _canonical_index(os.path.abspath(index))


def replace_state(tmp,path):
    """Windows readers can briefly deny replacement; retain atomic publication."""
    deadline=time.monotonic()+REPLACE_RETRY_SECONDS;delay=.02
    while True:
        try:os.replace(tmp,path);return
        except PermissionError as error:
            remaining=deadline-time.monotonic()
            if os.name!='nt' or getattr(error,'winerror',None) not in (5,32,33) or remaining<=0:
                raise
            time.sleep(min(delay,remaining));delay=min(delay*2,.2)


def write_state(index,kind,status,counts,reason=None):
    path=resolved_index(index).with_suffix('.'+kind+'-status.json')
    data={'version':1,'kind':kind,'status':status,'updatedAt':datetime.now(timezone.utc).isoformat(),'pid':os.getpid(),'counts':counts,'reason':reason}
    tmp=path.with_name(path.name+f'.{os.getpid()}.tmp')
    tmp.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8');replace_state(tmp,path)
    return data

@contextmanager
def worker_lock(index,kind):
    path=resolved_index(index).with_suffix('.'+kind+'.lock')
    with path.open('a+b') as stream:
        if not path.stat().st_size:stream.write(b'0');stream.flush()
        stream.seek(0)
        if os.name=='nt':
            import msvcrt
            msvcrt.locking(stream.fileno(),msvcrt.LK_NBLCK,1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        try:yield
        finally:
            stream.seek(0)
            if os.name=='nt':msvcrt.locking(stream.fileno(),msvcrt.LK_UNLCK,1)
            else:fcntl.flock(stream.fileno(),fcntl.LOCK_UN)


@contextmanager
def processing_lock(index,kind):
    """OCR/hash share one disk reservation; different indexes remain independent."""
    with worker_lock(index,'disk'):
        with worker_lock(index,kind):yield


def request_stop(index,kind):
    state_path=resolved_index(index).with_suffix('.'+kind+'-status.json')
    state=json.loads(state_path.read_text(encoding='utf-8'))
    pid=state.get('pid')
    if state.get('status')!='running' or not isinstance(pid,int) or pid<=0:
        raise ValueError('실행 중인 작업이 없습니다.')
    path=resolved_index(index).with_suffix('.'+kind+'-stop.json')
    tmp=path.with_name(path.name+f'.{os.getpid()}.tmp')
    tmp.write_text(json.dumps({'pid':pid,'requestedAt':time.time()}),encoding='utf-8')
    replace_state(tmp,path)
    return pid


def stop_requested(index,kind,pid=None):
    path=resolved_index(index).with_suffix('.'+kind+'-stop.json')
    try:
        if path.stat().st_size>1024:return False
        request=json.loads(path.read_text(encoding='utf-8'))
        return request.get('pid')==(os.getpid() if pid is None else pid)
    except (OSError,ValueError,AttributeError):return False
