import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from src.services.ai import model_config
from src.services.opencode import provision


KIMI_DEFAULT_LIMIT = {"context": 262_144, "output": 32_768}


def _load_launcher():
    script = provision._PROJECT_ROOT / "scripts" / "gen_opencode_config.py"
    spec = importlib.util.spec_from_file_location("test_model_limit_launcher", script)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot import {script}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _entry(model_id: str, **extra) -> dict:
    return {
        "id": model_id,
        "name": model_id,
        "base_url": "https://model.example/v1",
        "api_key": "test-key",
        **extra,
    }


class ModelLimitParsingTest(unittest.TestCase):
    """The backend and the OpenCode launcher must accept exactly the same input."""

    VALID = (
        (None, None),
        ({"context": 131_072, "output": 8_192}, {"context": 131_072, "output": 8_192}),
        ({"output": 1, "context": 2}, {"context": 2, "output": 1}),
    )
    INVALID = (
        ([131_072, 8_192], "limit 必须是包含 context 与 output 的对象"),
        ("131072", "limit 必须是包含 context 与 output 的对象"),
        ({"context": 131_072}, "limit.output 必须是正整数"),
        ({"output": 8_192}, "limit.context 必须是正整数"),
        ({"context": 0, "output": 8_192}, "limit.context 必须是正整数"),
        ({"context": 131_072, "output": -1}, "limit.output 必须是正整数"),
        ({"context": 131_072.0, "output": 8_192}, "limit.context 必须是正整数"),
        ({"context": "131072", "output": 8_192}, "limit.context 必须是正整数"),
        ({"context": True, "output": True}, "limit.context 必须是正整数"),
        ({"context": 8_192, "output": 8_192}, "limit.output 必须小于 limit.context"),
        (
            {"context": 131_072, "output": 8_192, "input": 120_000},
            "limit 只支持 context 与 output，不支持：input",
        ),
    )

    def setUp(self):
        self.launcher = _load_launcher()

    def test_valid_declarations_are_forwarded_unchanged(self):
        for value, expected in self.VALID:
            with self.subTest(value=value):
                self.assertEqual(model_config._parse_limit(value), expected)
                self.assertEqual(self.launcher._parse_limit(value), expected)

    def test_invalid_declarations_report_the_same_reason(self):
        for value, message in self.INVALID:
            with self.subTest(value=value):
                with self.assertRaises(ValueError) as backend:
                    model_config._parse_limit(value)
                with self.assertRaises(ValueError) as launcher:
                    self.launcher._parse_limit(value)
                self.assertEqual(str(backend.exception), message)
                self.assertEqual(str(launcher.exception), message)


class ModelLimitConfigTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.models_file = Path(self.temp.name) / "models.json"
        patcher = patch.object(model_config, "MODELS_FILE", self.models_file)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _write(self, document: dict) -> None:
        self.models_file.write_text(
            json.dumps(document, ensure_ascii=False),
            encoding="utf-8",
        )

    def _stored(self) -> dict:
        document = json.loads(self.models_file.read_text(encoding="utf-8"))
        return {item["id"]: item for item in document["models"]}

    def test_declared_limit_wins_and_kimi_keeps_its_default(self):
        declared = {"context": 131_072, "output": 8_192}
        document = {
            "default": "deepseek-v4-flash",
            "models": [
                _entry("deepseek-v4-flash", limit=declared),
                _entry("kimi-k2.6"),
                _entry("kimi-k2.5", limit={"context": 200_000, "output": 16_000}),
                _entry("custom-model"),
                _entry("broken-model", limit={"context": 4_096, "output": 8_192}),
            ],
        }
        self._write(document)

        loaded = {model.id: model for model in model_config.load_models()}
        self.assertEqual(loaded["deepseek-v4-flash"].limit, declared)
        self.assertIsNone(loaded["kimi-k2.6"].limit)
        # A malformed optional budget is ignored without hiding the model.
        self.assertIsNone(loaded["broken-model"].limit)

        programmatic = provision.build_root_config()["provider"]
        launcher = _load_launcher()
        with contextlib.redirect_stdout(io.StringIO()) as output:
            launcher_models = launcher._models_from_file(document)
        generated = launcher._build_config(launcher_models, "deepseek-v4-flash")["provider"]

        self.assertEqual(programmatic, generated)

        def limit_of(model_id: str):
            return programmatic[model_id]["models"][model_id].get("limit")

        self.assertEqual(limit_of("deepseek-v4-flash"), declared)
        self.assertEqual(limit_of("kimi-k2.6"), KIMI_DEFAULT_LIMIT)
        self.assertEqual(limit_of("kimi-k2.5"), {"context": 200_000, "output": 16_000})
        self.assertIsNone(limit_of("custom-model"))
        self.assertIsNone(limit_of("broken-model"))
        self.assertIn(
            "警告：模型 broken-model 的 limit 无效，已忽略：limit.output 必须小于 limit.context",
            output.getvalue(),
        )

    def test_launcher_lists_models_left_without_limit(self):
        self._write({
            "default": "deepseek-v4-flash",
            "models": [
                _entry("deepseek-v4-flash", limit={"context": 131_072, "output": 8_192}),
                _entry("kimi-k2.6"),
                _entry("custom-model"),
            ],
        })
        launcher = _load_launcher()
        out_path = Path(self.temp.name) / "opencode.json"
        with (
            patch.object(launcher, "MODELS_FILE", self.models_file),
            patch.object(launcher.sys, "argv", ["gen_opencode_config.py", str(out_path)]),
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            self.assertEqual(launcher.main(), 0)

        config = json.loads(out_path.read_text(encoding="utf-8"))
        self.assertEqual(
            config["provider"]["deepseek-v4-flash"]["models"]["deepseek-v4-flash"]["limit"],
            {"context": 131_072, "output": 8_192},
        )
        hints = [line for line in output.getvalue().splitlines() if line.startswith("提示：")]
        self.assertEqual(len(hints), 1)
        self.assertIn("[custom-model]", hints[0])

    def test_adding_a_model_keeps_existing_limits(self):
        declared = {"context": 131_072, "output": 8_192}
        self._write({
            "default": "deepseek-v4-flash",
            "models": [_entry("deepseek-v4-flash", limit=declared)],
        })

        added = model_config.add_model("new-model", "https://new.example/v1", "new-key")

        self.assertIsNone(added.limit)
        stored = self._stored()
        self.assertEqual(stored["deepseek-v4-flash"]["limit"], declared)
        self.assertNotIn("limit", stored["new-model"])

    def test_updating_a_model_endpoint_keeps_hand_edited_fields(self):
        declared = {"context": 131_072, "output": 8_192}
        self._write({
            "default": "other-model",
            "models": [
                _entry("other-model"),
                _entry("deepseek-v4-flash", name="DeepSeek V4 Flash", vision=False, limit=declared),
            ],
        })

        updated = model_config.upsert_model(
            "deepseek-v4-flash",
            "https://updated.example/v1",
            "updated-key",
            make_default=True,
        )

        stored = self._stored()["deepseek-v4-flash"]
        self.assertEqual(stored["base_url"], "https://updated.example/v1")
        self.assertEqual(stored["api_key"], "updated-key")
        self.assertEqual(stored["limit"], declared)
        self.assertEqual(stored["name"], "DeepSeek V4 Flash")
        self.assertIs(stored["vision"], False)
        self.assertEqual(updated.limit, declared)
        self.assertEqual(updated.name, "DeepSeek V4 Flash")
        self.assertEqual(model_config.default_model_id(), "deepseek-v4-flash")

        provider = provision.build_root_config()["provider"]["deepseek-v4-flash"]
        self.assertEqual(provider["options"]["baseURL"], "https://updated.example/v1")
        self.assertEqual(provider["models"]["deepseek-v4-flash"]["limit"], declared)

    def test_upserting_a_new_model_does_not_invent_a_limit(self):
        self._write({"default": "", "models": []})

        created = model_config.upsert_model(
            "deepseek-v4-flash",
            "https://model.example/v1",
            "test-key",
        )

        self.assertIsNone(created.limit)
        self.assertNotIn("limit", self._stored()["deepseek-v4-flash"])
        provider = provision.build_root_config()["provider"]["deepseek-v4-flash"]
        self.assertNotIn("limit", provider["models"]["deepseek-v4-flash"])


if __name__ == "__main__":
    unittest.main()
