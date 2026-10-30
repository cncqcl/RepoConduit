from .state import JobState


class MemoryStore:
    def __init__(self) -> None:
        self.rows: dict[str, tuple[JobState, bool]] = {}

    def put(self, job_id: str, state: JobState, cancel_requested: bool = False) -> None:
        self.rows[job_id] = (state, cancel_requested)

    def get(self, job_id: str) -> tuple[JobState, bool]:
        return self.rows[job_id]
