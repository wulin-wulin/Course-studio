import unittest

from fastapi import HTTPException

from src.api.agent import (
    _prepare_animation_gate_questions,
    _normalize_opencode_questions,
    _normalize_question_answers,
    _question_answer_content,
    _question_history_content,
    _validate_animation_gate_answers,
)


class AgentQuestionProtocolTest(unittest.TestCase):
    def setUp(self):
        self.questions = _normalize_opencode_questions([
            {
                "header": "发布课程",
                "question": "是否发布到项目？",
                "options": [
                    {"label": "确认发布", "description": "生成正式课程数据"},
                    {"label": "暂不发布", "description": "保留中间产物"},
                ],
                "multiple": False,
            }
        ])
        self.pending = {"questions": self.questions}

    def test_normalizes_native_question_payload(self):
        self.assertEqual(len(self.questions), 1)
        self.assertEqual(self.questions[0]["header"], "发布课程")
        self.assertTrue(self.questions[0]["custom"])
        self.assertEqual(
            [option["label"] for option in self.questions[0]["options"]],
            ["确认发布", "暂不发布"],
        )

    def test_validates_and_formats_answers(self):
        answers = _normalize_question_answers(self.pending, [["确认发布"]])
        self.assertEqual(answers, [["确认发布"]])
        self.assertEqual(
            _question_answer_content(self.pending, answers),
            "确认选择\n发布课程：确认发布",
        )

    def test_formats_question_card_for_history_restore(self):
        content = _question_history_content(self.questions)

        self.assertIn("需要你的确认", content)
        self.assertIn("### 发布课程", content)
        self.assertIn("是否发布到项目？", content)
        self.assertIn("确认发布：生成正式课程数据", content)

    def test_rejects_missing_answer(self):
        with self.assertRaises(HTTPException) as raised:
            _normalize_question_answers(self.pending, [[]])
        self.assertEqual(raised.exception.status_code, 422)

    def test_animation_gate_removes_skip_and_disables_custom_bypass(self):
        questions = _normalize_opencode_questions([
            {
                "header": "动画验收阻断",
                "question": "当前无法操作浏览器，要如何继续 G5？",
                "options": [
                    {
                        "label": "跳过动画验收直接继续",
                        "description": "先构建图谱并发布",
                    }
                ],
            }
        ])

        prepared, gate_indexes = _prepare_animation_gate_questions(questions)

        self.assertEqual(gate_indexes, [0])
        self.assertFalse(prepared[0]["custom"])
        self.assertEqual(
            [option["label"] for option in prepared[0]["options"]],
            ["已完成实际动画验收", "保持 G5 阻断"],
        )

    def test_animation_gate_rejects_bypass_answer(self):
        pending = {
            "questions": [{"header": "动画验收", "question": "是否已验收？"}],
            "animation_gate_indexes": [0],
        }

        with self.assertRaises(HTTPException) as raised:
            _validate_animation_gate_answers(
                pending, [["跳过动画验收直接继续"]]
            )

        self.assertEqual(raised.exception.status_code, 422)
        self.assertIn("不能跳过", raised.exception.detail)

    def test_animation_gate_only_accepts_explicit_attestation(self):
        pending = {
            "questions": [{"header": "动画验收", "question": "是否已验收？"}],
            "animation_gate_indexes": [0],
        }

        self.assertTrue(
            _validate_animation_gate_answers(
                pending, [["已完成实际动画验收"]]
            )
        )
        self.assertFalse(
            _validate_animation_gate_answers(
                pending, [["保持 G5 阻断"]]
            )
        )


if __name__ == "__main__":
    unittest.main()
