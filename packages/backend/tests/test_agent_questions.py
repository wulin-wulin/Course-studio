import unittest

from fastapi import HTTPException

from src.api import agent
from src.api.agent import (
    _normalize_opencode_questions,
    _normalize_question_answers,
    pending_question_for_conversation,
    _question_answer_content,
    _question_history_content,
)


class AgentQuestionProtocolTest(unittest.TestCase):
    def setUp(self):
        agent._pending_questions.clear()
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

    def tearDown(self):
        agent._pending_questions.clear()

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

    def test_pending_question_can_be_restored_by_conversation(self):
        agent._pending_questions["question-1"] = {
            "conversation_id": "conversation-1",
            "session_id": "session-1",
            "questions": self.questions,
        }

        restored = pending_question_for_conversation("conversation-1")

        self.assertEqual(restored["request_id"], "question-1")
        self.assertEqual(restored["conversation_id"], "conversation-1")
        self.assertEqual(restored["questions"], self.questions)
        self.assertIsNone(
            pending_question_for_conversation("another-conversation")
        )

    def test_rejects_missing_answer(self):
        with self.assertRaises(HTTPException) as raised:
            _normalize_question_answers(self.pending, [[]])
        self.assertEqual(raised.exception.status_code, 422)

    def test_animation_question_has_no_generation_time_acceptance_gate(self):
        questions = _normalize_opencode_questions([
            {
                "header": "动画偏好",
                "question": "希望动画采用哪种节奏？",
                "options": [
                    {
                        "label": "简洁",
                        "description": "减少状态切换",
                    }
                ],
            }
        ])

        self.assertTrue(questions[0]["custom"])
        self.assertEqual(
            [option["label"] for option in questions[0]["options"]],
            ["简洁"],
        )


if __name__ == "__main__":
    unittest.main()
