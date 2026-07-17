import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api import courses as courses_api
from src.services.courses import CourseDataError, CourseValidationError
from src.services.courses.store import CourseStore


def _write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


class CourseAnimationAssetsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        root = Path(self.temporary.name)
        self.course_root = root / "courses"
        self.workspace_root = root / "workspaces"
        self.store = CourseStore(self.course_root, self.workspace_root)
        self.course_id = "demo-course"
        course = self.course_root / self.course_id
        _write_json(course / "course.json", {"id": self.course_id, "title": "演示课程"})
        _write_json(
            course / "index.json",
            {
                "courseId": self.course_id,
                "clusters": [{"id": "linear", "title": "线性结构"}],
                "points": [
                    {
                        "id": "stack",
                        "title": "栈",
                        "clusterId": "linear",
                        "shortSummary": "后进先出结构",
                        "difficulty": "基础",
                        "importance": 0.8,
                        "keyTerms": [],
                        "pos": [0, 0],
                        "scale": 1,
                    }
                ],
            },
        )
        _write_json(
            course / "points" / "stack.json",
            {
                "id": "stack",
                "title": "栈",
                "clusterId": "linear",
                "shortSummary": "后进先出结构",
                "difficulty": "基础",
                "importance": 0.8,
                "keyTerms": [],
                "pos": [0, 0],
                "scale": 1,
                "animationType": "stackPushPop",
            },
        )
        javascript = b"document.body.dataset.animation = 'ready';"
        stylesheet = b"body { color: #234; }"
        animation_root = course / "animations"
        animation_root.mkdir(parents=True)
        (animation_root / "runtime.js").write_bytes(javascript)
        (animation_root / "runtime.css").write_bytes(stylesheet)
        _write_json(
            animation_root / "manifest.json",
            {
                "schema_version": "course-animation-runtime/1.0",
                "source_schema_version": "course-content-animations/1.0",
                "format": "sandboxed-iframe",
                "animations": [
                    {
                        "type": "stackPushPop",
                        "component": "StackPushPop",
                        "title": "栈操作",
                        "bindings": [{"pointId": "stack", "suggestion": "演示入栈与出栈"}],
                    }
                ],
                "assets": {
                    "runtime.js": {
                        "bytes": len(javascript),
                        "sha256": hashlib.sha256(javascript).hexdigest(),
                    },
                    "runtime.css": {
                        "bytes": len(stylesheet),
                        "sha256": hashlib.sha256(stylesheet).hexdigest(),
                    },
                },
            },
        )

    def tearDown(self):
        self.temporary.cleanup()

    def test_reads_integrity_checked_assets_and_preserves_them_on_json_write(self):
        manifest = self.store.read_animation_manifest(self.course_id)
        self.assertEqual(manifest["animations"][0]["type"], "stackPushPop")
        original_javascript = self.store.read_animation_asset(self.course_id, "runtime.js")

        course, index, points = self.store._load_course_objects(self.course_root, self.course_id)
        course["description"] = "更新课程说明"
        self.store._write_package(self.course_id, course, index, points)

        self.assertEqual(
            self.store.read_animation_asset(self.course_id, "runtime.js"),
            original_javascript,
        )

        course, index, points = self.store._load_course_objects(self.course_root, self.course_id)
        points["stack"]["animationType"] = "none"
        with self.assertRaises(CourseValidationError):
            self.store._write_package(self.course_id, course, index, points)

    def test_rejects_tampered_or_unknown_animation_assets(self):
        runtime = self.course_root / self.course_id / "animations" / "runtime.js"
        runtime.write_bytes(runtime.read_bytes() + b"// tampered")
        with self.assertRaises(CourseValidationError):
            self.store.read_animation_manifest(self.course_id)
        with self.assertRaises(CourseDataError):
            self.store.read_animation_asset(self.course_id, "../course.json")

    def test_api_serves_only_known_types_with_csp(self):
        app = FastAPI()
        app.include_router(courses_api.router, prefix="/courses")
        with patch.object(courses_api, "get_course_store", return_value=self.store):
            client = TestClient(app)
            player = client.get(
                f"/courses/{self.course_id}/animations/player",
                params={"type": "stackPushPop"},
            )
            self.assertEqual(player.status_code, 200)
            self.assertIn("script-src 'nonce-", player.headers["content-security-policy"])
            self.assertEqual(player.headers["cross-origin-resource-policy"], "cross-origin")
            self.assertIn("document.body.dataset.animation", player.text)
            self.assertIn("<style nonce=", player.text)
            self.assertNotIn("allow-same-origin", player.text)

            javascript = client.get(f"/courses/{self.course_id}/animations/runtime.js")
            self.assertEqual(javascript.status_code, 200)
            self.assertTrue(javascript.headers["content-type"].startswith("text/javascript"))
            self.assertEqual(
                javascript.headers["cross-origin-resource-policy"],
                "cross-origin",
            )
            self.assertEqual(javascript.content, self.store.read_animation_asset(self.course_id, "runtime.js"))

            missing = client.get(
                f"/courses/{self.course_id}/animations/player",
                params={"type": "notPublished"},
            )
            self.assertEqual(missing.status_code, 404)

    def test_api_deletes_the_selected_course_package(self):
        app = FastAPI()
        app.include_router(courses_api.router, prefix="/courses")
        with patch.object(courses_api, "get_course_store", return_value=self.store):
            client = TestClient(app)
            response = client.delete(f"/courses/{self.course_id}")

            self.assertEqual(response.status_code, 204)
            self.assertFalse((self.course_root / self.course_id).exists())
            self.assertEqual(client.get(f"/courses/{self.course_id}").status_code, 404)
            self.assertEqual(client.get("/courses").json(), {"courses": []})


if __name__ == "__main__":
    unittest.main()
