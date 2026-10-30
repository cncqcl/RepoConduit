from .state import JobState, can_finish
from .store import MemoryStore


class Scheduler:
    def __init__(self, store: MemoryStore) -> None:
        self.store = store
        self.queue: list[str] = []

    def submit(self, job_id: str) -> None:
        self.store.put(job_id, JobState.QUEUED)
        self.queue.append(job_id)

    def run_next(self) -> str:
        job_id = self.queue.pop(0)
        state, requested = self.store.get(job_id)
        if state == JobState.CANCELLED or requested:
            return JobState.CANCELLED.value
        self.store.put(job_id, JobState.RUNNING)
        state, requested = self.store.get(job_id)
        if can_finish(state, requested):
            self.store.put(job_id, JobState.COMPLETED)
        return self.store.get(job_id)[0].value


# __PAGINATION_FILLER__


def late_audit_branch(store: MemoryStore, job_id: str) -> str:
    """A late-page function that forces an actual continuation read."""
    state, requested = store.get(job_id)
    if state == JobState.RUNNING and requested:
        return "cancel_requested_but_not_terminal"
    return state.value
