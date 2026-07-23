from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from src.services.courses.store import CourseConflictError, CourseStore
from src.services.locking import exclusive_file_lock


class CourseCommitReceiptTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.store = CourseStore(root / "courses", root / "workspaces")
        self.store.create_course({"id": "demo-course", "title": "Demo Course"})
        self.identity = {
            "review_id": "review-g6",
            "review_kind": "prerequisites",
            "review_gate": "G6_PREREQUISITE_REVIEW",
            "review_revision": 1,
            "course_id": "demo-course",
            "artifact_hash": "a" * 64,
        }

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_interprocess_file_lock_is_reentrant_on_the_same_thread(self):
        lock_path = Path(self.temporary.name) / "nested.lock"
        completed = threading.Event()

        def acquire_twice() -> None:
            with exclusive_file_lock(lock_path):
                with exclusive_file_lock(lock_path):
                    completed.set()

        worker = threading.Thread(target=acquire_twice, daemon=True)
        worker.start()

        self.assertTrue(
            completed.wait(2),
            "nested acquisition must not open a second self-conflicting OS lock",
        )
        worker.join(2)
        self.assertFalse(worker.is_alive())

    def test_commit_receipt_is_bound_to_conversation_review_course_and_artifact(self):
        workspace = self.store.prepare_workspace("conversation-1")
        course_path = workspace.path / "demo-course" / "course.json"
        course = json.loads(course_path.read_text(encoding="utf-8"))
        course["description"] = "Published by the reviewed pipeline"
        course_path.write_text(json.dumps(course), encoding="utf-8")

        committed = self.store.commit_workspace(
            workspace,
            review_receipt=self.identity,
        )
        receipt = self.store.review_commit_receipt(
            "conversation-1",
            self.identity,
        )

        self.assertIsNotNone(receipt)
        assert receipt is not None
        self.assertEqual(receipt["status"], "committed")
        self.assertEqual(receipt["canonical_fingerprint"], committed["revision"])
        self.assertIn("demo-course", receipt["changed_course_ids"])
        self.assertTrue(receipt["changed_paths"])
        self.assertIsNone(
            self.store.review_commit_receipt(
                "another-conversation",
                self.identity,
            )
        )
        self.assertIsNone(
            self.store.review_commit_receipt(
                "conversation-1",
                {**self.identity, "artifact_hash": "b" * 64},
            )
        )

    def test_prepared_receipt_checks_changed_paths_not_unrelated_courses(self):
        workspace = self.store.prepare_workspace("conversation-1")
        course_path = workspace.path / "demo-course" / "course.json"
        course = json.loads(course_path.read_text(encoding="utf-8"))
        course["description"] = "Reviewed change"
        course_path.write_text(json.dumps(course), encoding="utf-8")
        self.store.commit_workspace(workspace, review_receipt=self.identity)

        receipt_path = (
            self.store.workspace_root
            / "conversation-1"
            / ".course-workspace-commit.json"
        )
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["status"] = "prepared"
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")

        self.assertIsNotNone(
            self.store.review_commit_receipt("conversation-1", self.identity)
        )

        self.store.create_course({"id": "other-course", "title": "Other Course"})
        self.assertIsNotNone(
            self.store.review_commit_receipt("conversation-1", self.identity)
        )

        canonical_path = self.store.root / "demo-course" / "course.json"
        canonical = json.loads(canonical_path.read_text(encoding="utf-8"))
        canonical["description"] = "A later unrelated canonical change"
        canonical_path.write_text(json.dumps(canonical), encoding="utf-8")

        self.assertIsNone(
            self.store.review_commit_receipt("conversation-1", self.identity)
        )

    def test_constructor_completes_interrupted_directory_transaction(self):
        before = self.store._tree_bytes(self.store.root)
        desired = dict(before)
        course_path = Path("demo-course") / "course.json"
        course = json.loads(desired[course_path].decode("utf-8"))
        course["description"] = "Crash-recovered content"
        desired[course_path] = (
            json.dumps(course, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")

        transaction_id = "1" * 32
        journal, staged, previous = self.store._tree_transaction_paths(
            self.store.root,
            transaction_id,
        )
        staged.mkdir()
        for relative, content in desired.items():
            target = staged / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        self.store._write_private_json(
            journal,
            {
                "schema": "course-tree-transaction/1.0",
                "transaction_id": transaction_id,
                "destination": self.store.root.name,
                "previous_fingerprint": self.store._fingerprint_from_tree(before),
                "desired_fingerprint": self.store._fingerprint_from_tree(desired),
            },
        )
        os.replace(self.store.root, previous)

        recovered = CourseStore(self.store.root, self.store.workspace_root)

        self.assertEqual(
            recovered.read_course("demo-course")["description"],
            "Crash-recovered content",
        )
        self.assertFalse(journal.exists())
        self.assertFalse(staged.exists())
        self.assertFalse(previous.exists())

    def test_second_instance_waits_for_live_directory_transaction(self):
        before = self.store._tree_bytes(self.store.root)
        desired = dict(before)
        course_path = Path("demo-course") / "course.json"
        course = json.loads(desired[course_path].decode("utf-8"))
        course["description"] = "Committed by the live writer"
        desired[course_path] = (
            json.dumps(course, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")

        journal = self.store.root.parent / ".courses.transaction.json"
        journal_ready = threading.Event()
        allow_writer_to_continue = threading.Event()
        second_started = threading.Event()
        second_finished = threading.Event()
        writer_errors: list[BaseException] = []
        second_errors: list[BaseException] = []
        second_descriptions: list[str] = []
        original_write = CourseStore._write_private_json

        def pause_after_journal(path: Path, value: dict) -> None:
            original_write(path, value)
            if path == journal:
                journal_ready.set()
                if not allow_writer_to_continue.wait(5):
                    raise RuntimeError("timed out waiting to continue live transaction")

        def write_tree() -> None:
            try:
                self.store._atomic_sync_tree(self.store.root, desired)
            except BaseException as exc:
                writer_errors.append(exc)

        def construct_second_store() -> None:
            second_started.set()
            try:
                second = CourseStore(self.store.root, self.store.workspace_root)
                second_descriptions.append(
                    str(second.read_course("demo-course").get("description"))
                )
            except BaseException as exc:
                second_errors.append(exc)
            finally:
                second_finished.set()

        with patch.object(
            CourseStore,
            "_write_private_json",
            staticmethod(pause_after_journal),
        ):
            writer = threading.Thread(target=write_tree)
            writer.start()
            self.assertTrue(journal_ready.wait(5))

            second_constructor = threading.Thread(target=construct_second_store)
            second_constructor.start()
            self.assertTrue(second_started.wait(5))
            self.assertFalse(
                second_finished.wait(0.1),
                "a second instance must not recover another instance's live transaction",
            )

            allow_writer_to_continue.set()
            writer.join(5)
            second_constructor.join(5)

        self.assertFalse(writer.is_alive())
        self.assertFalse(second_constructor.is_alive())
        self.assertEqual(writer_errors, [])
        self.assertEqual(second_errors, [])
        self.assertEqual(second_descriptions, ["Committed by the live writer"])
        self.assertTrue(self.store.root.is_dir())
        self.assertFalse(journal.exists())

    def test_second_instance_rechecks_stale_workspace_after_waiting_for_commit(self):
        second_store = CourseStore(self.store.root, self.store.workspace_root)
        first_workspace = self.store.prepare_workspace("conversation-1")
        second_workspace = second_store.prepare_workspace("conversation-2")
        first_course_path = first_workspace.path / "demo-course" / "course.json"
        second_course_path = second_workspace.path / "demo-course" / "course.json"
        first_course = json.loads(first_course_path.read_text(encoding="utf-8"))
        first_course["description"] = "first writer wins"
        first_course_path.write_text(json.dumps(first_course), encoding="utf-8")
        second_course = json.loads(second_course_path.read_text(encoding="utf-8"))
        second_course["description"] = "stale second writer"
        second_course_path.write_text(json.dumps(second_course), encoding="utf-8")

        first_at_canonical_swap = threading.Event()
        allow_first_to_commit = threading.Event()
        second_started = threading.Event()
        second_finished = threading.Event()
        first_errors: list[BaseException] = []
        second_errors: list[BaseException] = []
        original_sync = self.store._atomic_sync_tree_locked
        paused = False

        def pause_before_canonical_swap(
            destination: Path,
            desired: dict[Path, bytes],
        ) -> None:
            nonlocal paused
            if destination.resolve() == self.store.root and not paused:
                paused = True
                first_at_canonical_swap.set()
                if not allow_first_to_commit.wait(5):
                    raise RuntimeError("timed out waiting to commit first workspace")
            original_sync(destination, desired)

        def commit_first() -> None:
            try:
                self.store.commit_workspace(first_workspace)
            except BaseException as exc:
                first_errors.append(exc)

        def commit_second() -> None:
            second_started.set()
            try:
                second_store.commit_workspace(second_workspace)
            except BaseException as exc:
                second_errors.append(exc)
            finally:
                second_finished.set()

        with patch.object(
            self.store,
            "_atomic_sync_tree_locked",
            side_effect=pause_before_canonical_swap,
        ):
            first_commit = threading.Thread(target=commit_first)
            first_commit.start()
            self.assertTrue(first_at_canonical_swap.wait(5))

            second_commit = threading.Thread(target=commit_second)
            second_commit.start()
            self.assertTrue(second_started.wait(5))
            self.assertFalse(
                second_finished.wait(0.1),
                "the stale base check must wait for the active canonical commit",
            )

            allow_first_to_commit.set()
            first_commit.join(5)
            second_commit.join(5)

        self.assertFalse(first_commit.is_alive())
        self.assertFalse(second_commit.is_alive())
        self.assertEqual(first_errors, [])
        self.assertEqual(len(second_errors), 1)
        self.assertIsInstance(second_errors[0], CourseConflictError)
        self.assertEqual(
            self.store.read_course("demo-course")["description"],
            "first writer wins",
        )

    @unittest.skipUnless(hasattr(os, "fork"), "requires POSIX process semantics")
    def test_process_exit_releases_tree_lock_and_next_store_recovers(self):
        before = self.store._tree_bytes(self.store.root)
        desired = dict(before)
        course_path = Path("demo-course") / "course.json"
        course = json.loads(desired[course_path].decode("utf-8"))
        course["description"] = "Recovered after process exit"
        desired[course_path] = (
            json.dumps(course, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")
        journal = self.store.root.parent / ".courses.transaction.json"

        pid = os.fork()
        if pid == 0:  # pragma: no cover - assertions run in the parent
            child_store = CourseStore(self.store.root, self.store.workspace_root)
            original_write = child_store._write_private_json

            def exit_after_journal(path: Path, value: dict) -> None:
                original_write(path, value)
                if path == journal:
                    os._exit(23)

            child_store._write_private_json = exit_after_journal  # type: ignore[method-assign]
            child_store._atomic_sync_tree(child_store.root, desired)
            os._exit(24)

        _, wait_status = os.waitpid(pid, 0)
        self.assertTrue(os.WIFEXITED(wait_status))
        self.assertEqual(os.WEXITSTATUS(wait_status), 23)
        self.assertTrue(journal.exists())

        self.assertEqual(
            self.store.read_course("demo-course")["description"],
            "Recovered after process exit",
        )
        self.assertTrue(self.store.root.is_dir())
        self.assertFalse(journal.exists())

    def test_prepared_receipt_rejects_tampered_path_hash_proof(self):
        workspace = self.store.prepare_workspace("conversation-1")
        course_path = workspace.path / "demo-course" / "course.json"
        course = json.loads(course_path.read_text(encoding="utf-8"))
        course["description"] = "Reviewed change"
        course_path.write_text(json.dumps(course), encoding="utf-8")
        self.store.commit_workspace(workspace, review_receipt=self.identity)

        receipt_path = (
            self.store.workspace_root
            / "conversation-1"
            / ".course-workspace-commit.json"
        )
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["status"] = "prepared"
        first_path = receipt["changed_paths"][0]
        receipt["changed_path_sha256"][first_path] = hashlib.sha256(b"wrong").hexdigest()
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")

        self.assertIsNone(
            self.store.review_commit_receipt("conversation-1", self.identity)
        )


if __name__ == "__main__":
    unittest.main()
