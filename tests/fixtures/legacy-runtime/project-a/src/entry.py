from .scheduler import Scheduler
from .store import MemoryStore


def submit_job(job_id: str) -> str:
    scheduler = Scheduler(MemoryStore())
    scheduler.submit(job_id)
    return scheduler.run_next()
