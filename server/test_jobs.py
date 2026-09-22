import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from jobs import Jobs, JobBusy


class JobsTest(unittest.TestCase):
    def test_running_waiting_timeout_and_error_cleanup(self):
        jobs = Jobs()
        gpu = threading.Lock()
        running, release, waiting = threading.Event(), threading.Event(), threading.Event()

        def work():
            running.set()
            self.assertTrue(release.wait(3))

        class ObservedLock:
            def acquire(self, timeout):
                waiting.set()
                return gpu.acquire(timeout=timeout)

            def release(self):
                gpu.release()

        with ThreadPoolExecutor(2) as pool:
            first = pool.submit(jobs.run, gpu, work)
            try:
                self.assertTrue(running.wait(3))
                second = pool.submit(jobs.run, ObservedLock(), lambda: None, 0.1)
                self.assertTrue(waiting.wait(3))
                self.assertEqual(jobs.snapshot(), {'active_jobs': 1, 'queued_jobs': 1})
                with self.assertRaises(JobBusy):
                    second.result(timeout=3)
                self.assertEqual(jobs.snapshot(), {'active_jobs': 1, 'queued_jobs': 0})
            finally:
                release.set()
                first.result(timeout=3)
        with self.assertRaises(ValueError):
            jobs.run(gpu, lambda: (_ for _ in ()).throw(ValueError('failed')))
        self.assertFalse(gpu.locked())
        self.assertEqual(jobs.snapshot(), {'active_jobs': 0, 'queued_jobs': 0})
