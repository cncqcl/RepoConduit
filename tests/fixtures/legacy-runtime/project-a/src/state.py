from enum import Enum


class JobState(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


def can_finish(state: JobState, cancel_requested: bool) -> bool:
    return state == JobState.RUNNING and not cancel_requested
