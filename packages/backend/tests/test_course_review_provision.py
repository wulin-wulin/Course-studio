import importlib.util
from pathlib import Path
import shutil
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
    def test_content_worker_contract_is_explicit_and_mirror_stays_in_sync(self):
        canonical = (
            provision._PROJECT_ROOT
            / "skills"
            / "candidate-knowledge-point-generator"
        )
        mirror = (
            provision._PROJECT_ROOT
            / "skills"
            / "knowledge-cluster-builder"
            / "candidate-knowledge-point-generator"
        )
        canonical_files = sorted(
            path.relative_to(canonical)
            for path in canonical.rglob("*")
            if path.is_file()
        )
        mirror_files = sorted(
            path.relative_to(mirror)
            for path in mirror.rglob("*")
            if path.is_file()
        )
        self.assertEqual(canonical_files, mirror_files)
        for relative_path in canonical_files:
            with self.subTest(relative_path=str(relative_path)):
                self.assertEqual(
                    (canonical / relative_path).read_bytes(),
                    (mirror / relative_path).read_bytes(),
                )

        orchestration = (canonical / "orchestration.md").read_text(
            encoding="utf-8"
        )
        for required_contract in (
            "加载 `candidate-knowledge-point-generator` Skill",
            "data-contract.md 的路径",
            "animation-contract.md 的路径",
            "point.schema.json 的路径",
            "animation-request.schema.json 的路径",
            'course_pipeline {"action":"validate-point-drafts"',
            "合计 3–5 个知识点的 canary",
            'course_pipeline {"action":"validate-animation-drafts"',
            "第一个动画组件必须作为 canary",
            "10 个互斥任务一波并发",
        ):
            self.assertIn(required_contract, orchestration)

        creator_prompt = provision._COURSE_CREATOR_PROMPT_PATH.read_text(
            encoding="utf-8"
        )
        self.assertIn(
            'course_pipeline {"action":"validate-point-drafts"',
            creator_prompt,
        )
        self.assertIn(
            'course_pipeline {"action":"sync-textbook-manifest"',
            creator_prompt,
        )
        self.assertIn("不得用 `write` 手写", creator_prompt)
        self.assertIn("当前一波全部通过后", creator_prompt)
        self.assertIn(
            'course_pipeline {"action":"validate-animation-drafts"',
            creator_prompt,
        )
        self.assertIn("第一个动画组件作为 canary", creator_prompt)
        self.assertIn("最多 10 个互斥任务一波并发", creator_prompt)

    def test_textbook_worker_handoff_contract_guards_spans_json_and_ownership(self):
        project_root = provision._PROJECT_ROOT
        candidate_root = (
            project_root / "skills" / "candidate-knowledge-point-generator"
        )
        candidate_skill = (candidate_root / "SKILL.md").read_text(
            encoding="utf-8"
        )
        orchestration = (candidate_root / "orchestration.md").read_text(
            encoding="utf-8"
        )
        data_contract = (candidate_root / "data-contract.md").read_text(
            encoding="utf-8"
        )
        pipeline_skill = (
            project_root / "skills" / "knowledge-pipeline-orchestrator" / "SKILL.md"
        ).read_text(encoding="utf-8")
        creator_prompt = provision._COURSE_CREATOR_PROMPT_PATH.read_text(
            encoding="utf-8"
        )

        for source in (
            creator_prompt,
            candidate_skill,
            orchestration,
            data_contract,
            pipeline_skill,
        ):
            with self.subTest(contract="trusted point evidence"):
                self.assertIn("manifest.pointEvidence", source)
            with self.subTest(contract="chunk ids are not provenance"):
                self.assertIn("chunk-*", source)
                self.assertIn("block-*", source)
            with self.subTest(contract="latex JSON escaping"):
                self.assertIn("LaTeX", source)
                self.assertIn("\\\\delta", source)
            with self.subTest(contract="worker readback"):
                self.assertIn("`read`", source)

        self.assertIn(
            "`manifest.pointEvidence.sourceSpans` 深度相等且顺序一致",
            candidate_skill,
        )
        self.assertIn(
            "`manifest.pointEvidence.sourceSpans` 深度相等且顺序一致",
            orchestration,
        )
        self.assertIn("JSON parse error", orchestration)
        self.assertIn("同所有权 repair task", data_contract)
        self.assertIn("父 Agent 不得直接使用 `edit`/`write`", creator_prompt)
        self.assertIn("主智能体不得用 `edit`/`write`", pipeline_skill)
        self.assertNotIn("主智能体接管该文件", orchestration)

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
            ), patch.object(
                provision,
                "_seed_session_opencode_runtime",
                return_value=True,
            ) as seed_runtime:
                returned = provision.ensure_course_creation_session_assets(
                    "conversation-1"
                )

            self.assertEqual(returned, workspace)
            seed_runtime.assert_called_once_with(session_root)
            tools = session_root / ".opencode" / "tools"
            for file_name in (
                "prepare-course-review.mjs",
                "run-course-pipeline-step.mjs",
                "validate-textbook-outline.mjs",
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

    def test_runtime_seed_uses_hardlinks_and_cleanup_preserves_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "shared-node-modules"
            plugin = source / "@opencode-ai" / "plugin"
            plugin.mkdir(parents=True)
            source_manifest = plugin / "package.json"
            source_manifest.write_text(
                '{"name":"@opencode-ai/plugin","version":"1.17.20"}\n',
                encoding="utf-8",
            )
            (source.parent / "package.json").write_text(
                '{"dependencies":{"@opencode-ai/plugin":"1.17.20"}}\n',
                encoding="utf-8",
            )
            marker = source / "runtime-marker.txt"
            marker.write_text("preserved", encoding="utf-8")
            session_root = root / "sessions" / "conversation-1"
            (session_root / ".opencode").mkdir(parents=True)

            with patch.object(
                provision,
                "_SHARED_OPENCODE_NODE_MODULES",
                source,
            ):
                seeded = provision._seed_session_opencode_runtime(session_root)

            destination = session_root / ".opencode" / "node_modules"
            self.assertTrue(seeded)
            self.assertFalse(destination.is_symlink())
            self.assertTrue(
                (destination / "@opencode-ai" / "plugin" / "package.json").is_file()
            )
            self.assertTrue(
                (destination / "@opencode-ai" / "plugin" / "package.json").samefile(
                    source_manifest
                )
            )

            shutil.rmtree(session_root)
            self.assertEqual(marker.read_text(encoding="utf-8"), "preserved")

    def test_runtime_seed_falls_back_without_pre_warmed_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            session_root = root / "conversation-1"
            (session_root / ".opencode").mkdir(parents=True)
            with patch.object(
                provision,
                "_SHARED_OPENCODE_NODE_MODULES",
                root / "missing",
            ):
                seeded = provision._seed_session_opencode_runtime(session_root)

            self.assertFalse(seeded)
            self.assertFalse((session_root / ".opencode" / "node_modules").exists())

    def test_runtime_seed_falls_back_for_non_object_manifests(self):
        cases = (
            ("[]", '{"dependencies":{"@opencode-ai/plugin":"1.17.20"}}'),
            ('{"version":"1.17.20"}', "[]"),
            ('{"version":"1.17.20"}', '{"dependencies":[]}'),
        )
        for source_json, runtime_json in cases:
            with self.subTest(
                source_json=source_json,
                runtime_json=runtime_json,
            ), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / "shared-node-modules"
                plugin = source / "@opencode-ai" / "plugin"
                plugin.mkdir(parents=True)
                (plugin / "package.json").write_text(
                    source_json,
                    encoding="utf-8",
                )
                (source.parent / "package.json").write_text(
                    runtime_json,
                    encoding="utf-8",
                )
                session_root = root / "conversation-1"
                (session_root / ".opencode").mkdir(parents=True)

                with patch.object(
                    provision,
                    "_SHARED_OPENCODE_NODE_MODULES",
                    source,
                ):
                    seeded = provision._seed_session_opencode_runtime(session_root)

                self.assertFalse(seeded)
                self.assertFalse(
                    (session_root / ".opencode" / "node_modules").exists()
                )

    def test_only_primary_creation_agents_can_call_pipeline(self):
        config = provision.build_root_config()
        self.assertEqual(config["permission"]["bash"], "deny")
        self.assertEqual(config["permission"]["course_pipeline"], "deny")

        for name in (
            "course-outline-creator",
            "course-creator",
            "textbook-outline-creator",
            "textbook-course-creator",
        ):
            configured = config["agent"][name]
            self.assertEqual(configured["mode"], "primary")
            self.assertEqual(configured["permission"]["bash"], "deny")
            self.assertEqual(configured["permission"]["course_pipeline"], "allow")

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

    def test_launcher_and_programmatic_model_budgets_match(self):
        launcher = _load_script_config_module()
        kimi_model_ids = (
            "kimi-k2.5",
            "kimi-k2.6",
            "kimi-k2-0905-preview",
            "kimi-k2-turbo-preview",
        )
        model_ids = (*kimi_model_ids, "custom-model")
        models = [
            provision.model_config.ModelDef(
                id=model_id,
                name=model_id,
                base_url="https://model.example/v1",
                api_key="test-key",
            )
            for model_id in model_ids
        ]
        launcher_models = [
            {
                "id": model.id,
                "base_url": model.base_url,
                "api_key": model.api_key,
            }
            for model in models
        ]

        with (
            patch.object(provision.model_config, "load_models", return_value=models),
            patch.object(
                provision.model_config,
                "default_model_id",
                return_value="kimi-k2.6",
            ),
        ):
            programmatic = provision.build_root_config()
        generated = launcher._build_config(launcher_models, "kimi-k2.6")

        expected_compaction = {
            "auto": True,
            "keep": {"tokens": 15_000},
            "buffer": 20_000,
            "reserved": 20_000,
        }
        expected_limit = {"context": 262_144, "output": 32_768}
        self.assertEqual(programmatic["compaction"], expected_compaction)
        self.assertEqual(generated["compaction"], expected_compaction)
        for model_id in kimi_model_ids:
            self.assertEqual(
                programmatic["provider"][model_id]["models"][model_id]["limit"],
                expected_limit,
            )
            self.assertEqual(
                generated["provider"][model_id]["models"][model_id]["limit"],
                expected_limit,
            )
        self.assertNotIn(
            "limit",
            programmatic["provider"]["custom-model"]["models"]["custom-model"],
        )
        self.assertNotIn(
            "limit",
            generated["provider"]["custom-model"]["models"]["custom-model"],
        )

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
                "**/pipeline/*/textbook-outline.json": "allow",
            },
        )
        self.assertNotIn("knowledge-cluster-builder", permission["skill"])

    def test_full_creator_preserves_worker_file_ownership(self):
        config = provision.build_root_config()
        creator = config["agent"]["course-creator"]["permission"]["edit"]
        content = config["agent"]["course-content-worker"]["permission"]["edit"]
        animation = config["agent"]["course-animation-worker"]["permission"]["edit"]

        self.assertNotIn("**/pipeline/*/course-content/**", creator)
        self.assertEqual(
            creator["**/pipeline/*/course-content/generation/manifest.json"],
            "allow",
        )
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

    def test_textbook_creators_cannot_replace_trusted_manifest(self):
        config = provision.build_root_config()
        manifest_pattern = (
            "**/pipeline/*/course-content/generation/manifest.json"
        )

        self.assertEqual(
            config["agent"]["course-outline-creator"]["permission"]["edit"][
                manifest_pattern
            ],
            "allow",
        )
        self.assertEqual(
            config["agent"]["course-creator"]["permission"]["edit"][
                manifest_pattern
            ],
            "allow",
        )
        for name in ("textbook-outline-creator", "textbook-course-creator"):
            self.assertNotIn(
                manifest_pattern,
                config["agent"][name]["permission"]["edit"],
            )


if __name__ == "__main__":
    unittest.main()
