"""Standalone worker contract; uses only invented temporary state."""
import tempfile
import unittest
from pathlib import Path
import worker

class WorkerManagementCase(unittest.TestCase):
    def test_empty_private_library_without_legacy_index(self):
        with tempfile.TemporaryDirectory() as folder:
            value = worker.dispatch({'action':'library-status','directory':folder})
            self.assertEqual(value['resources'], 0)
            self.assertEqual(value['queue']['pending'], 0)
            self.assertFalse(value['paused'])
            self.assertFalse(any(p.name == 'desktop-registry-v2.sqlite' for p in Path(folder).iterdir()))

    def test_pause_resume_durable_without_search_lifetime(self):
        with tempfile.TemporaryDirectory() as folder:
            worker.dispatch({'action':'library-pause','directory':folder,'paused':True})
            self.assertTrue(worker.dispatch({'action':'library-status','directory':folder})['paused'])
            worker.dispatch({'action':'library-pause','directory':folder,'paused':False})
            self.assertFalse(worker.dispatch({'action':'library-status','directory':folder})['paused'])

    def test_prepare_summary_keeps_large_outbox_bodies_in_private_worker(self):
        with tempfile.TemporaryDirectory() as folder:
            value=worker.dispatch({'action':'library-prepare-web','directory':folder,'summary':True})
            self.assertEqual(value,{'pending':0})

if __name__=='__main__':unittest.main()
