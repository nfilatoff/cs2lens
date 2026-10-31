"""A one-worker background queue for demo extraction (parsing is CPU and memory heavy)."""

from __future__ import annotations

import itertools
import threading
import time
import traceback
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from queue import Queue


@dataclass
class Job:
    id: int
    kind: str  # "extract" | "replay" | "unpack"
    target: str  # demo or archive path
    match_id: str
    status: str = "queued"  # queued | running | done | error
    progress: float = 0.0
    stage: str = ""
    error: str | None = None
    created: float = field(default_factory=time.time)
    finished: float | None = None


class JobQueue:
    def __init__(self) -> None:
        self._jobs: dict[int, Job] = {}
        self._ids = itertools.count(1)
        self._queue: Queue[tuple[Job, Callable]] = Queue()
        self._lock = threading.Lock()
        threading.Thread(target=self._work, daemon=True, name="cs2lens-jobs").start()

    def submit(self, kind: str, target: str, match_id: str, fn: Callable[[Callable[[float, str], None]], None]) -> Job:
        """Queue ``fn(progress)`` unless the same work is already queued or running."""
        with self._lock:
            for job in self._jobs.values():
                if job.kind == kind and job.target == target and job.status in ("queued", "running"):
                    return job
            job = Job(next(self._ids), kind, target, match_id)
            self._jobs[job.id] = job
        self._queue.put((job, fn))
        return job

    def active_for(self, target: str) -> Job | None:
        with self._lock:
            for job in self._jobs.values():
                if job.target == target and job.status in ("queued", "running"):
                    return job
        return None

    def active_for_match(self, match_id: str) -> Job | None:
        with self._lock:
            for job in self._jobs.values():
                if job.match_id == match_id and job.status in ("queued", "running"):
                    return job
        return None

    def list(self) -> list[dict]:
        with self._lock:
            return [asdict(j) for j in sorted(self._jobs.values(), key=lambda j: -j.id)]

    def _work(self) -> None:
        while True:
            job, fn = self._queue.get()
            job.status = "running"

            def progress(fraction: float, stage: str, job: Job = job) -> None:
                job.progress, job.stage = round(fraction, 3), stage

            try:
                fn(progress)
                job.status, job.progress, job.stage = "done", 1.0, "done"
            except Exception as e:  # noqa: BLE001 - reported to the UI
                job.status, job.error = "error", f"{type(e).__name__}: {e}"
                traceback.print_exc()
            job.finished = time.time()
