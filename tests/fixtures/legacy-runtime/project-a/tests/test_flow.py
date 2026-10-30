import unittest

from src.cancel import request_cancel
from src.scheduler import Scheduler, late_audit_branch
from src.state import JobState
from src.store import MemoryStore


class FlowTest(unittest.TestCase):
    def test_normal_flow(self) -> None:
        scheduler = Scheduler(MemoryStore())
        scheduler.submit("a")
        self.assertEqual(scheduler.run_next(), "completed")

    def test_queued_cancel(self) -> None:
        store = MemoryStore()
        scheduler = Scheduler(store)
        scheduler.submit("b")
        self.assertEqual(request_cancel(store, "b"), JobState.CANCELLED)
        self.assertEqual(scheduler.run_next(), "cancelled")

    def test_running_cancel_is_not_terminal(self) -> None:
        store = MemoryStore()
        store.put("c", JobState.RUNNING)
        self.assertEqual(request_cancel(store, "c"), JobState.RUNNING)
        self.assertEqual(late_audit_branch(store, "c"), "cancel_requested_but_not_terminal")


if __name__ == "__main__":
    unittest.main()
