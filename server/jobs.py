"""Thread-safe counts for work sharing the GPU, including photo encoding."""
import threading


class JobBusy(Exception):
    pass


class Jobs:
    def __init__(self):
        self._mutex = threading.Lock()
        self._queued = 0
        self._running = 0

    def snapshot(self):
        with self._mutex:
            return {'active_jobs': self._running, 'queued_jobs': self._queued}

    def run(self, gpu_lock, work, timeout=300):
        with self._mutex:
            self._queued += 1
        acquired = False
        try:
            acquired = gpu_lock.acquire(timeout=timeout)
        finally:
            with self._mutex:
                self._queued -= 1
                if acquired:
                    self._running += 1
        if not acquired:
            raise JobBusy()
        try:
            return work()
        finally:
            with self._mutex:
                self._running -= 1
            gpu_lock.release()
