from pathlib import Path
import tempfile
import unittest

from src.services.courses.store import CourseStore


def _meta(point_id: str, cluster_id: str, position: list[int]) -> dict:
    return {
        "id": point_id,
        "title": point_id,
        "clusterId": cluster_id,
        "shortSummary": "用于验证顺序关系的测试知识点摘要",
        "difficulty": "基础",
        "importance": 0.8,
        "keyTerms": [point_id],
        "pos": position,
        "scale": 1,
    }


class CourseSequenceValidationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.store = CourseStore(root / "courses", root / "workspaces")
        self.course = {"id": "demo-course", "title": "演示课程"}
        self.points = {
            "point-a": {**_meta("point-a", "cluster-a", [0, 0]), "prerequisites": []},
            "point-b": {**_meta("point-b", "cluster-b", [1, 1]), "prerequisites": []},
        }
        self.index = {
            "courseId": "demo-course",
            "clusters": [
                {"id": "cluster-a", "title": "簇 A"},
                {"id": "cluster-b", "title": "簇 B"},
            ],
            "points": [
                _meta("point-a", "cluster-a", [0, 0]),
                _meta("point-b", "cluster-b", [1, 1]),
            ],
            "sequences": {
                "cluster": [{"fromId": "cluster-a", "toId": "cluster-b"}],
                "point": [{"fromId": "point-a", "toId": "point-b"}],
            },
        }

    def validate(self):
        return self.store._validate_course_objects(
            "demo-course",
            self.course,
            self.index,
            self.points,
            strict_details=False,
        )

    def test_valid_sequence_edges_are_independent_of_prerequisites(self):
        result = self.validate()
        self.assertTrue(result.ok, result.errors)
        self.assertEqual(self.points["point-b"]["prerequisites"], [])

    def test_sequence_rejects_cycles_duplicates_and_dangling_ids(self):
        self.index["sequences"]["point"].extend([
            {"fromId": "point-b", "toId": "point-a"},
            {"fromId": "point-a", "toId": "point-b"},
            {"fromId": "point-a", "toId": "missing-point"},
        ])
        result = self.validate()
        self.assertFalse(result.ok)
        self.assertTrue(any("形成环" in error for error in result.errors))
        self.assertTrue(any("重复" in error for error in result.errors))
        self.assertTrue(any("悬空" in error for error in result.errors))

    def test_legacy_course_may_omit_sequences(self):
        self.index.pop("sequences")
        result = self.validate()
        self.assertTrue(result.ok, result.errors)

    def test_sequence_rejects_non_string_ids_without_crashing_validation(self):
        self.index["sequences"]["point"] = [
            {"fromId": ["point-a"], "toId": "point-b"},
            {"fromId": "point-a", "toId": None},
        ]
        result = self.validate()
        self.assertFalse(result.ok)
        self.assertEqual(
            sum("fromId/toId 必须是字符串" in error for error in result.errors),
            2,
        )


if __name__ == "__main__":
    unittest.main()
