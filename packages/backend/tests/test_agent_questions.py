import unittest

from fastapi import HTTPException

from src.api.agent import (
    _normalize_opencode_questions,
    _normalize_question_answers,
    _question_answer_content,
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

    def test_rejects_missing_answer(self):
        with self.assertRaises(HTTPException) as raised:
            _normalize_question_answers(self.pending, [[]])
        self.assertEqual(raised.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
