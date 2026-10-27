import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from unittest.mock import patch

from src.api import courses as courses_api
from src.services.courses.store import CourseDataError, CourseStore


def _write_course(root: Path, course_id: str, title: str) -> None:
    course = root / course_id
    course.mkdir(parents=True)
    (course / "course.json").write_text(
        json.dumps({"id": course_id, "title": title}), encoding="utf-8"
    )
    (course / "index.json").write_text(
        json.dumps({"courseId": course_id, "clusters": [], "points": []}),
        encoding="utf-8",
    )


class CourseCatalogStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.store = CourseStore(root / "courses", root / "workspaces")
        _write_course(self.store.root, "algebra", "代数")
        _write_course(self.store.root, "physics", "物理")

    def test_missing_catalog_initialises_my_courses_with_every_course(self):
        catalog = self.store.list_catalog()
        self.assertEqual([group["id"] for group in catalog["groups"]], ["my-courses"])
        self.assertEqual(catalog["groups"][0]["course_ids"], ["algebra", "physics"])
        self.assertTrue((self.store.root.parent / "course-catalog.json").is_file())

    def test_assignment_is_exclusive_and_new_course_joins_default_group(self):
        group = self.store.create_catalog_group("理科")
        catalog = self.store.assign_course_to_catalog_group("physics", group["id"])
        owners = {
            course_id: current["id"]
            for current in catalog["groups"]
            for course_id in current["course_ids"]
        }
        self.assertEqual(owners, {"algebra": "my-courses", "physics": group["id"]})

        _write_course(self.store.root, "calculus", "微积分")
        refreshed = self.store.list_catalog()
        owner = next(group for group in refreshed["groups"] if "calculus" in group["course_ids"])
        self.assertEqual(owner["id"], "my-courses")

    def test_legacy_catalog_edges_and_cleanup_on_move_and_delete(self):
        path = self.store.root.parent / "course-catalog.json"
        path.write_text(json.dumps({"schema_version": "course-catalog/1.0", "revision": "old", "groups": [{"id": "my-courses", "name": "My courses", "order": 0, "course_ids": ["algebra", "physics"]}]}), encoding="utf-8")
        self.assertEqual(self.store.read_catalog_group("my-courses")["edges"], [])
        edge = {"fromId": "algebra", "toId": "physics"}
        self.store.update_catalog_edges("my-courses", [edge])
        group = self.store.create_catalog_group("Science")
        self.store.assign_course_to_catalog_group("physics", group["id"])
        self.assertEqual(self.store.read_catalog_group("my-courses")["edges"], [])
        self.store.assign_course_to_catalog_group("physics", "my-courses")
        self.store.update_catalog_edges("my-courses", [edge])
        self.store.delete_course("physics")
        self.assertEqual(self.store.read_catalog_group("my-courses")["edges"], [])

    def test_invalid_edges_are_rejected_without_changing_graph(self):
        _write_course(self.store.root, "calculus", "Calculus")
        edge = {"fromId": "algebra", "toId": "physics"}
        self.store.update_catalog_edges("my-courses", [edge])
        invalid = [
            [{"fromId": "algebra", "toId": "algebra"}],
            [edge, edge],
            [edge, {"fromId": "physics", "toId": "calculus"}, {"fromId": "calculus", "toId": "algebra"}],
            [{"fromId": "algebra", "toId": "missing"}],
        ]
        for edges in invalid:
            with self.subTest(edges=edges), self.assertRaises(CourseDataError):
                self.store.update_catalog_edges("my-courses", edges)
            self.assertEqual(self.store.read_catalog_group("my-courses")["edges"], [edge])
        other = self.store.create_catalog_group("Other")
        self.store.assign_course_to_catalog_group("calculus", other["id"])
        with self.assertRaises(CourseDataError):
            self.store.update_catalog_edges("my-courses", [{"fromId": "algebra", "toId": "calculus"}])

    def test_non_empty_group_cannot_be_deleted_and_course_deletion_cleans_assignment(self):
        group = self.store.create_catalog_group("理科")
        self.store.assign_course_to_catalog_group("physics", group["id"])
        with self.assertRaises(CourseDataError):
            self.store.delete_catalog_group(group["id"])

        self.store.delete_course("physics")
        refreshed = self.store.list_catalog()
        self.assertNotIn("physics", sum((group["course_ids"] for group in refreshed["groups"]), []))

    def test_placeholder_course_is_empty_but_visible_in_catalogue(self):
        group = self.store.create_catalog_group("展示课程")
        result = self.store.create_placeholder_course("线性代数进阶", group["id"])
        placeholder = result["course"]
        self.assertTrue(placeholder["placeholder"])
        self.assertEqual(self.store.read_index(placeholder["id"])["points"], [])
        self.assertEqual(result["group"]["course_ids"], [placeholder["id"]])
        listed = next(item for item in self.store.list_courses() if item["id"] == placeholder["id"])
        self.assertTrue(listed["placeholder"])

    def test_create_group_rejects_catalog_limit_without_corrupting_catalog(self):
        path = self.store.root.parent / "course-catalog.json"
        groups = [
            {
                "id": "my-courses" if index == 0 else f"group-{index}",
                "name": f"Group {index}",
                "order": index,
                "course_ids": ["algebra", "physics"] if index == 0 else [],
                "edges": [],
            }
            for index in range(200)
        ]
        path.write_text(
            json.dumps({
                "schema_version": "course-catalog/1.0",
                "revision": "at-limit",
                "groups": groups,
            }),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(CourseDataError, "学科大类数量超过上限"):
            self.store.create_catalog_group("Overflow")

        persisted = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(len(persisted["groups"]), 200)
        self.assertEqual(len(self.store.list_catalog()["groups"]), 200)


class CourseCatalogApiTest(unittest.TestCase):
    def test_catalog_routes_are_available(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = CourseStore(root / "courses", root / "workspaces")
            _write_course(store.root, "demo-course", "演示课程")
            app = FastAPI()
            app.include_router(courses_api.router, prefix="/courses")
            with patch.object(courses_api, "get_course_store", return_value=store):
                with TestClient(app) as client:
                    response = client.get("/courses/catalog")
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json()["catalog"]["groups"][0]["name"], "我的课程")
                    detail = client.get("/courses/catalog/groups/my-courses")
                    self.assertEqual(detail.status_code, 200)
                    self.assertEqual(detail.json()["group"]["edges"], [])
                    self.assertEqual(client.get("/courses/catalog/groups/missing").status_code, 404)
                    self.assertEqual(client.patch("/courses/catalog/groups/my-courses/edges", json={"edges": [{"fromId": "demo-course", "toId": "demo-course"}]}).status_code, 422)
                    self.assertEqual(client.patch("/courses/catalog/groups/my-courses/edges", json={"edges": []}).status_code, 200)
                    created = client.post("/courses/catalog/groups", json={"name": "数学"})
                    self.assertEqual(created.status_code, 201)
                    self.assertEqual(created.json()["group"]["name"], "数学")
                    placeholder = client.post(
                        "/courses/placeholders",
                        json={"title": "离散数学", "group_id": "my-courses"},
                    )
                    self.assertEqual(placeholder.status_code, 201)
                    self.assertTrue(placeholder.json()["course"]["placeholder"])
                    self.assertEqual(placeholder.json()["group"]["course_ids"][-1], placeholder.json()["course"]["id"])


if __name__ == "__main__":
    unittest.main()
