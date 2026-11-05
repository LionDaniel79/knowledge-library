import json
import sys
from reader import search,render

def dispatch(request):
    action=request.pop('action')
    if action=='search':return search(**request)
    if action=='render':return render(**request)
    if action=='scan':
        from registry import scan
        return scan(**request,progress=lambda n,h:print(f'{n}개 확인 · 해시 {h}개',file=sys.stderr,flush=True))
    if action=='preview':
        from manifest import preview
        return preview(**request)
    if action=='audit-v2':
        from audit_v2 import audit
        return audit(**request)
    if action=='ocr':
        from sandbox import process_one
        return process_one(**request)
    raise ValueError('지원하지 않는 작업입니다.')

if __name__=='__main__':
    import os
    if name:=os.environ.get('PDF_DESKTOP_JOB'):
        import ctypes as ct
        from ctypes import wintypes as wt
        kernel=ct.WinDLL('kernel32',use_last_error=True)
        kernel.OpenJobObjectW.argtypes=[wt.DWORD,wt.BOOL,wt.LPCWSTR]
        kernel.OpenJobObjectW.restype=wt.HANDLE
        kernel.AssignProcessToJobObject.argtypes=[wt.HANDLE,wt.HANDLE]
        kernel.CloseHandle.argtypes=[wt.HANDLE]
        handle=kernel.OpenJobObjectW(1,False,name)
        if not handle:sys.exit(2)
        try:
            if not kernel.AssignProcessToJobObject(handle,wt.HANDLE(-1)):sys.exit(2)
        finally:kernel.CloseHandle(handle)
    sys.stdin.reconfigure(encoding='utf-8-sig')
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    try:print(json.dumps(dispatch(json.load(sys.stdin)),ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error':str(error)},ensure_ascii=False))
        sys.exit(1)
