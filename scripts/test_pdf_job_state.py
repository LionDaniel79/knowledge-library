import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import pdf_job_state


class StatePersistenceTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'win32', 'Windows sharing semantics')
    def test_brief_status_reader_does_not_interrupt_progress(self):
        with tempfile.TemporaryDirectory() as temp:
            index=Path(temp)/'index.sqlite'
            pdf_job_state.write_state(index,'ocr','running',{'processed':1})
            status=index.with_suffix('.ocr-status.json')
            reader=status.open('rb')
            release=threading.Timer(.15,reader.close)
            release.start()
            try:
                pdf_job_state.write_state(index,'ocr','running',{'processed':2})
            finally:
                release.join();reader.close()
            self.assertEqual(json.loads(status.read_text())['counts']['processed'],2)
            self.assertEqual(list(Path(temp).glob('*.tmp')),[])

    @unittest.skipUnless(sys.platform == 'win32', 'Windows sharing semantics')
    def test_persistent_lock_fails_with_last_complete_status_intact(self):
        with tempfile.TemporaryDirectory() as temp:
            index=Path(temp)/'index.sqlite'
            pdf_job_state.write_state(index,'ocr','running',{'processed':1})
            status=index.with_suffix('.ocr-status.json')
            started=time.monotonic()
            with status.open('rb'),patch('pdf_job_state.REPLACE_RETRY_SECONDS',.05,create=True):
                with self.assertRaises(PermissionError):
                    pdf_job_state.write_state(index,'ocr','running',{'processed':2})
            self.assertLess(time.monotonic()-started,1)
            self.assertEqual(json.loads(status.read_text())['counts']['processed'],1)


if __name__ == '__main__':unittest.main()
