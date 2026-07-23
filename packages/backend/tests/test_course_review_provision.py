import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from src.services.courses import CourseWorkspace
from src.services.opencode import provision


def _load_script_config_module():
    script = provision._PROJECT_ROOT / "scripts" / "gen_opencode_config.py"
    spec = importlib.util.spec_from_file_location(
        "test_gen_opencode_config",
        script,
    )
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot import {script}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CourseReviewProvisionTest(unittest.TestCase):
    def test_creation_workspace_installs_review_runner_but_not_shadow_tool(self):
        with tempfile.TemporaryDirectory() as directory:
            session_root = Path(directory) / "conversation-1"
            workspace_path = session_root / "courses"
            workspace_path.mkdir(parents=True)
            workspace = CourseWorkspace(
                "conversation-1",
                workspace_path,
                "fingerprint",
            )
            course_store = Mock()
            course_store.prepare_workspace.return_value = workspace

            with patch.object(
                provision,
                "get_course_store",
                return_value=course_store,
            ):
                returned = provision.ensure_course_creation_session_assets(
                    "conversation-1"
                )

            self.assertEqual(returned, workspace)
            tools = session_root / ".opencode" / "tools"
            for file_name in (
                "prepare-course-review.mjs",
                "run-course-pipeline-step.mjs",
            ):
                copied = tools / file_name
                self.assertTrue(copied.is_file())
                self.assertEqual(
                    copied.read_bytes(),
                    (provision._PROJECT_ROOT / "scripts" / file_name).read_bytes(),
                )
            self.assertTrue(provision._COURSE_PIPELINE_TOOL_SOURCE.is_file())
            self.assertFalse((tools / "course_pipeline.ts").exists())
            prompt = (session_root / provision.AGENTS_FILE_NAME).read_text(
                encoding="utf-8"
            )
            self.assertIn("G6_GRAPH_REVIEW", prompt)
            self.assertIn(
                'course_pipeline {"action":"review-knowledge-graph"',
                prompt,
            )
            self.assertNotIn("node .opencode/tools/", prompt)

    def test_only_primary_creation_agents_can_call_pipeline(self):
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

    def test_launcher_and_programmatic_permissions_match(self):
        launcher = _load_script_config_module()
        with (
            patch.object(provision.model_config, "load_models", return_value=[]),
            patch.object(provision.model_config, "default_model_id", return_value=""),
        ):
            programmatic = provision.build_root_config()

        self.assertEqual(programmatic["permission"], launcher.PERMISSION)
        self.assertEqual(programmatic["agent"], launcher._course_agents())

    def test_outline_creator_cannot_generate_details_or_graph(self):
        permission = provision.build_root_config()["agent"][
            "course-outline-creator"
        ]["permission"]
        self.assertEqual(permission["task"], "deny")
        self.assertEqual(
            permission["edit"],
            {
                "**": "deny",
                "**/pipeline/*/course-content/src/data/course.json": "allow",
                "**/pipeline/*/course-content/src/data/index.json": "allow",
                "**/pipeline/*/course-content/generation/manifest.json": "allow",
            },
        )
        self.assertNotIn("knowledge-cluster-builder", permission["skill"])

    def test_full_creator_preserves_worker_file_ownership(self):
        config = provision.build_root_config()
        creator = config["agent"]["course-creator"]["permission"]["edit"]
        content = config["agent"]["course-content-worker"]["permission"]["edit"]
        animation = config["agent"]["course-animation-worker"]["permission"]["edit"]

        self.assertNotIn("**/pipeline/*/course-content/**", creator)
        self.assertNotIn(
            "**/pipeline/*/course-content/src/data/points/*.json",
            creator,
        )
        self.assertEqual(
            content["**/pipeline/*/course-content/src/data/points/*.json"],
            "allow",
        )
        self.assertEqual(
            animation["**/pipeline/*/course-content/src/animations/*.tsx"],
            "allow",
        )


if __name__ == "__main__":
    unittest.main()
