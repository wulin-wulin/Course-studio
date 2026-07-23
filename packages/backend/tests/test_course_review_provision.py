import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from src.services.courses import CourseWorkspace
from src.services.opencode import provision


def _load_script_config_module():
    script = provision._PROJECT_ROOT / "scripts" / "gen_opencode_config.py"
    spec = importlib.util.spec_from_file_location("test_gen_opencode_config", script)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot import {script}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CourseReviewProvisionTest(unittest.TestCase):
    def test_course_creation_workspace_uses_project_structured_pipeline_tool(self):
        with tempfile.TemporaryDirectory() as directory:
            session_root = Path(directory) / "conversation-1"
            workspace_path = session_root / "courses"
            workspace_path.mkdir(parents=True)
            workspace = CourseWorkspace("conversation-1", workspace_path, "fingerprint")
            course_store = Mock()
            course_store.prepare_workspace.return_value = workspace

            with patch.object(provision, "get_course_store", return_value=course_store):
                returned = provision.ensure_course_creation_session_assets("conversation-1")

            self.assertEqual(returned, workspace)
            copied_review = session_root / ".opencode" / "tools" / "prepare-course-review.mjs"
            self.assertTrue(copied_review.is_file())
            self.assertEqual(
                copied_review.read_bytes(),
                (provision._PROJECT_ROOT / "scripts" / "prepare-course-review.mjs").read_bytes(),
            )
            copied_runner = session_root / ".opencode" / "tools" / "run-course-pipeline-step.mjs"
            self.assertTrue(copied_runner.is_file())
            self.assertEqual(
                copied_runner.read_bytes(),
                (provision._PROJECT_ROOT / "scripts" / "run-course-pipeline-step.mjs").read_bytes(),
            )
            copied_tool = session_root / ".opencode" / "tools" / "course_pipeline.ts"
            self.assertTrue(provision._COURSE_PIPELINE_TOOL_SOURCE.is_file())
            self.assertFalse(copied_tool.exists())
            prompt = (session_root / provision.AGENTS_FILE_NAME).read_text(encoding="utf-8")
            self.assertIn("G6_PREREQUISITE_REVIEW", prompt)
            self.assertIn('course_pipeline {"action":"review-knowledge-points"', prompt)
            self.assertNotIn("node .opencode/tools/", prompt)

    def test_course_agents_deny_bash_and_only_primary_agents_allow_pipeline(self):
        config = provision.build_root_config()
        self.assertEqual(config["permission"]["bash"], "deny")
        self.assertEqual(config["permission"]["course_pipeline"], "deny")

        outline = config["agent"]["course-outline-creator"]["permission"]
        creator = config["agent"]["course-creator"]["permission"]
        self.assertEqual(outline["bash"], "deny")
        self.assertEqual(outline["course_pipeline"], "allow")
        self.assertEqual(creator["bash"], "deny")
        self.assertEqual(creator["course_pipeline"], "allow")

        for name in ("course-content-worker", "course-animation-worker"):
            permission = config["agent"][name]["permission"]
            self.assertEqual(permission["bash"], "deny")
            self.assertEqual(permission["course_pipeline"], "deny")

    def test_programmatic_and_launcher_permissions_are_equivalent(self):
        launcher = _load_script_config_module()
        with (
            patch.object(provision.model_config, "load_models", return_value=[]),
            patch.object(provision.model_config, "default_model_id", return_value=""),
        ):
            programmatic = provision.build_root_config()

        self.assertEqual(programmatic["permission"], launcher.PERMISSION)
        self.assertEqual(programmatic["agent"], launcher._course_agents())
        self.assertEqual(programmatic["permission"]["doom_loop"], "deny")
        self.assertEqual(programmatic["permission"]["course_pipeline"], "deny")
        for agent in programmatic["agent"].values():
            self.assertEqual(agent["permission"]["doom_loop"], "deny")

    def test_outline_creator_is_a_machine_gate_for_identity_files(self):
        config = provision.build_root_config()
        outline = config["agent"]["course-outline-creator"]
        permissions = outline["permission"]

        self.assertEqual(outline["mode"], "primary")
        self.assertEqual(permissions["task"], "deny")
        self.assertEqual(permissions["bash"], "deny")
        self.assertEqual(permissions["course_pipeline"], "allow")
        self.assertEqual(
            permissions["edit"],
            {
                "**": "deny",
                "**/pipeline/*/course-content/src/data/course.json": "allow",
                "**/pipeline/*/course-content/src/data/index.json": "allow",
                "**/pipeline/*/course-content/generation/manifest.json": "allow",
            },
        )
        self.assertNotIn("knowledge-cluster-builder", permissions["skill"])

    def test_primary_creator_delegates_point_and_animation_file_ownership(self):
        config = provision.build_root_config()
        creator_edit = config["agent"]["course-creator"]["permission"]["edit"]
        content_worker_edit = config["agent"]["course-content-worker"]["permission"]["edit"]
        animation_worker_edit = config["agent"]["course-animation-worker"]["permission"]["edit"]

        self.assertNotIn("**/pipeline/*/course-content/**", creator_edit)
        self.assertNotIn("**/pipeline/*/course-content/src/data/points/*.json", creator_edit)
        self.assertNotIn(
            "**/pipeline/*/course-content/generation/animation-requests/*.json",
            creator_edit,
        )
        self.assertNotIn("**/pipeline/*/course-content/src/animations/*.tsx", creator_edit)
        self.assertEqual(
            content_worker_edit["**/pipeline/*/course-content/src/data/points/*.json"],
            "allow",
        )
        self.assertEqual(
            content_worker_edit[
                "**/pipeline/*/course-content/generation/animation-requests/*.json"
            ],
            "allow",
        )
        self.assertEqual(
            animation_worker_edit["**/pipeline/*/course-content/src/animations/*.tsx"],
            "allow",
        )


if __name__ == "__main__":
    unittest.main()
