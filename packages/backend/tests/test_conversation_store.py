from pathlib import Path
import tempfile
import unittest

from src.services.conversations.store import ConversationStore


class ConversationStoreTest(unittest.TestCase):
    def test_history_persists_and_deduplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "conversations.sqlite3"
            store = ConversationStore(database)
            store.ensure_conversation(
                "conversation-1",
                mode="agent",
                workflow="course-create",
                model="test-model",
                title_hint="开始创建课程",
            )
            store.add_message(
                "conversation-1",
                role="user",
                content="开始创建课程",
                message_id="user-1",
            )
            store.add_message(
                "conversation-1",
                role="assistant",
                content="请提供课程名称。",
                message_id="assistant-1",
            )
            store.add_message(
                "conversation-1",
                role="user",
                content="数据结构入门",
                message_id="user-2",
            )
            store.add_message(
                "conversation-1",
                role="user",
                content="重复消息不应再次写入",
                message_id="user-2",
            )
            store.set_opencode_session("conversation-1", "session-1")

            reopened = ConversationStore(database)
            conversation = reopened.get_conversation("conversation-1")
            self.assertIsNotNone(conversation)
            assert conversation is not None
            self.assertEqual(conversation["title"], "数据结构入门")
            self.assertEqual(conversation["workflow"], "course-create")
            self.assertEqual(conversation["opencode_session_id"], "session-1")
            self.assertEqual(
                [message["id"] for message in conversation["messages"]],
                ["user-1", "assistant-1", "user-2"],
            )
            self.assertEqual(reopened.list_conversations()[0]["message_count"], 3)
            self.assertTrue(reopened.delete_conversation("conversation-1"))
            self.assertIsNone(reopened.get_conversation("conversation-1"))


if __name__ == "__main__":
    unittest.main()
