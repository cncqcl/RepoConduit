from .state import JobState
from .store import MemoryStore


def request_cancel(store: MemoryStore, job_id: str) -> JobState:
    state, _ = store.get(job_id)
    if state == JobState.QUEUED:
        store.put(job_id, JobState.CANCELLED, True)
        return JobState.CANCELLED
    if state == JobState.RUNNING:
        store.put(job_id, JobState.RUNNING, True)
    return store.get(job_id)[0]
