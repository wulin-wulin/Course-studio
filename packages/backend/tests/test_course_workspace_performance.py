from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from src.services.courses.store import CourseConflictError, CourseStore


class CourseWorkspacePerformanceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.canonical = root / "courses"
        self.sessions = root / "sessions"
        self.store = CourseStore(self.canonical, self.sessions)
        self.store.create_course({
            "id": "demo-course",
            "title": "演示课程",
            "description": "初始说明",
        })

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_reusing_clean_base_skips_workspace_fingerprint_and_copy(self):
        first = self.store.prepare_workspace("conversation-1")

        with (
            patch.object(
                self.store,
                "_copy_canonical_to_workspace",
                wraps=self.store._copy_canonical_to_workspace,
            ) as copy_catalog,
            patch.object(
                self.store,
                "_fingerprint",
                wraps=self.store._fingerprint,
            ) as fingerprint,
        ):
            second = self.store.prepare_workspace("conversation-1")

        self.assertEqual(second.path, first.path)
        copy_catalog.assert_not_called()
        self.assertEqual(
            [call.args[0].resolve() for call in fingerprint.call_args_list],
            [self.canonical.resolve()],
        )

    def test_noop_commit_skips_validation_and_tree_sync(self):
        workspace = self.store.prepare_workspace("conversation-noop")

        with (
            patch.object(self.store, "_validate_root") as validate_root,
            patch.object(
                self.store,
                "_validate_workspace_changes",
            ) as validate_changes,
            patch.object(
                self.store,
                "_atomic_sync_tree",
                wraps=self.store._atomic_sync_tree,
            ) as sync_tree,
        ):
            result = self.store.commit_workspace(workspace)

        self.assertEqual(result["changed_paths"], [])
        validate_root.assert_not_called()
        validate_changes.assert_not_called()
        sync_tree.assert_not_called()

    def test_changed_commit_incrementally_refreshes_workspace(self):
        workspace = self.store.prepare_workspace("conversation-change")
        course_path = workspace.path / "demo-course" / "course.json"
        course = json.loads(course_path.read_text(encoding="utf-8"))
        course["description"] = "更新后的说明"
        course_path.write_text(
            json.dumps(course, ensure_ascii=False),
            encoding="utf-8",
        )

        with patch.object(
            self.store,
            "_copy_canonical_to_workspace",
            wraps=self.store._copy_canonical_to_workspace,
        ) as copy_catalog:
            result = self.store.commit_workspace(workspace)

        copy_catalog.assert_not_called()
        self.assertIn("demo-course/course.json", result["changed_paths"])
        canonical = self.store.read_course("demo-course")
        staged = json.loads(course_path.read_text(encoding="utf-8"))
        self.assertEqual(staged, canonical)
        self.assertEqual(staged["description"], "更新后的说明")

        # The post-commit state is already clean and can be reused immediately.
        with patch.object(
            self.store,
            "_copy_canonical_to_workspace",
            wraps=self.store._copy_canonical_to_workspace,
        ) as copy_catalog:
            reused = self.store.prepare_workspace("conversation-change")
        copy_catalog.assert_not_called()
        self.assertEqual(reused.base_fingerprint, result["revision"])

    def test_readonly_snapshot_reuses_clean_tree_and_repairs_changes(self):
        first = self.store.prepare_readonly_workspace("conversation-chat")
        with patch.object(
            self.store,
            "_copy_canonical_to_workspace",
            wraps=self.store._copy_canonical_to_workspace,
        ) as copy_catalog:
            second = self.store.prepare_readonly_workspace("conversation-chat")
            self.store.restore_readonly_workspace(second)
        copy_catalog.assert_not_called()

        course_path = first.path / "demo-course" / "course.json"
        course_path.write_text("{}", encoding="utf-8")
        with patch.object(
            self.store,
            "_copy_canonical_to_workspace",
            wraps=self.store._copy_canonical_to_workspace,
        ) as copy_catalog:
            self.store.restore_readonly_workspace(first)
        copy_catalog.assert_called_once_with(first.path)
        self.assertEqual(
            json.loads(course_path.read_text(encoding="utf-8")),
            self.store.read_course("demo-course"),
        )

    def test_dirty_workspace_still_conflicts_with_new_canonical_revision(self):
        workspace = self.store.prepare_workspace("conversation-conflict")
        course_path = workspace.path / "demo-course" / "course.json"
        staged = json.loads(course_path.read_text(encoding="utf-8"))
        staged["description"] = "会话中的修改"
        course_path.write_text(json.dumps(staged, ensure_ascii=False), encoding="utf-8")

        self.store.update_course(
            "demo-course",
            {"description": "其他会话已经提交"},
        )

        with self.assertRaises(CourseConflictError):
            self.store.prepare_workspace("conversation-conflict")
        with self.assertRaises(CourseConflictError):
            self.store.commit_workspace(workspace)

    def test_commit_detects_canonical_change_during_final_sync(self):
        workspace = self.store.prepare_workspace("conversation-race")
        staged_path = workspace.path / "demo-course" / "course.json"
        staged = json.loads(staged_path.read_text(encoding="utf-8"))
        staged["description"] = "本会话修改"
        staged_path.write_text(json.dumps(staged, ensure_ascii=False), encoding="utf-8")

        original_sync = self.store._atomic_sync_tree
        injected = False

        def racing_sync(destination, desired, **kwargs):
            nonlocal injected
            if destination.resolve() == self.canonical.resolve() and not injected:
                injected = True
                canonical_path = self.canonical / "demo-course" / "course.json"
                canonical = json.loads(canonical_path.read_text(encoding="utf-8"))
                canonical["description"] = "校验期间的其他提交"
                canonical_path.write_text(
                    json.dumps(canonical, ensure_ascii=False),
                    encoding="utf-8",
                )
            return original_sync(destination, desired, **kwargs)

        with patch.object(
            self.store,
            "_atomic_sync_tree",
            side_effect=racing_sync,
        ):
            with self.assertRaises(CourseConflictError):
                self.store.commit_workspace(workspace)

        self.assertEqual(
            self.store.read_course("demo-course")["description"],
            "校验期间的其他提交",
        )


if __name__ == "__main__":
    unittest.main()
