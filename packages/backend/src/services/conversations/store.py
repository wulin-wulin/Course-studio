"""Durable single-user conversation history backed by SQLite."""

from __future__ import annotations

from datetime import UTC, datetime
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import threading
import uuid
from typing import Any

from ...config import settings


_ALLOWED_MODES = {"chat", "agent"}
_ALLOWED_WORKFLOWS = {"default", "course-create"}
_ALLOWED_ROLES = {"user", "assistant", "system", "error"}


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _conversation_id(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in str(value))
    return cleaned[:80] or "default"


def _title_from_message(message: str, fallback: str = "新对话") -> str:
    compact = " ".join(str(message).split()).strip()
    if not compact:
        return fallback
    return compact[:42] + ("…" if len(compact) > 42 else "")


class ConversationStore:
    def __init__(self, path: Path | None = None):
        default_path = settings.course_agent_workspace_dir.parent / "conversations.sqlite3"
        self.path = (path or default_path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialize()

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.path, timeout=10.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._lock, self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    workflow TEXT NOT NULL,
                    model TEXT NOT NULL DEFAULT '',
                    opencode_session_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    images_json TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
                ON messages(conversation_id, created_at);

                CREATE INDEX IF NOT EXISTS idx_conversations_updated
                ON conversations(updated_at DESC);
                """
            )

    def ensure_conversation(
        self,
        conversation_id: str,
        *,
        mode: str,
        workflow: str,
        model: str = "",
        title_hint: str = "",
    ) -> str:
        cid = _conversation_id(conversation_id)
        normalized_mode = mode if mode in _ALLOWED_MODES else "agent"
        normalized_workflow = workflow if workflow in _ALLOWED_WORKFLOWS else "default"
        timestamp = _now()
        title = _title_from_message(title_hint)
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO conversations (
                    id, title, mode, workflow, model, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    mode = excluded.mode,
                    workflow = excluded.workflow,
                    model = CASE WHEN excluded.model <> '' THEN excluded.model ELSE conversations.model END,
                    updated_at = excluded.updated_at
                """,
                (cid, title, normalized_mode, normalized_workflow, model, timestamp, timestamp),
            )
        return cid

    def add_message(
        self,
        conversation_id: str,
        *,
        role: str,
        content: str,
        images: list[str] | None = None,
        message_id: str | None = None,
    ) -> str:
        cid = _conversation_id(conversation_id)
        normalized_role = role if role in _ALLOWED_ROLES else "system"
        mid = str(message_id or uuid.uuid4())[:120]
        timestamp = _now()
        serialized_images = json.dumps(images or [], ensure_ascii=False)
        with self._lock, self._connect() as connection:
            conversation = connection.execute(
                "SELECT title FROM conversations WHERE id = ?", (cid,)
            ).fetchone()
            if conversation is None:
                self.ensure_conversation(cid, mode="agent", workflow="default")
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO messages (
                    id, conversation_id, role, content, images_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (mid, cid, normalized_role, str(content), serialized_images, timestamp),
            )
            if cursor.rowcount:
                title_row = connection.execute(
                    "SELECT title FROM conversations WHERE id = ?", (cid,)
                ).fetchone()
                current_title = str(title_row["title"] if title_row else "")
                next_title = current_title
                if normalized_role == "user" and (
                    current_title == "新对话"
                    or (
                        current_title.startswith("开始创建课程")
                        and not str(content).startswith("开始创建课程")
                    )
                ):
                    next_title = _title_from_message(content, current_title)
                connection.execute(
                    "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
                    (next_title, timestamp, cid),
                )
        return mid

    @staticmethod
    def _message(row: sqlite3.Row) -> dict[str, Any]:
        try:
            images = json.loads(row["images_json"] or "[]")
        except json.JSONDecodeError:
            images = []
        return {
            "id": row["id"],
            "role": row["role"],
            "content": row["content"],
            "images": images if isinstance(images, list) else [],
            "created_at": row["created_at"],
        }

    def list_conversations(self, *, limit: int = 100) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit), 500))
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    c.id,
                    c.title,
                    c.mode,
                    c.workflow,
                    c.model,
                    c.created_at,
                    c.updated_at,
                    COUNT(m.id) AS message_count,
                    COALESCE((
                        SELECT content FROM messages latest
                        WHERE latest.conversation_id = c.id
                        ORDER BY latest.created_at DESC, latest.rowid DESC
                        LIMIT 1
                    ), '') AS preview
                FROM conversations c
                LEFT JOIN messages m ON m.conversation_id = c.id
                GROUP BY c.id
                ORDER BY c.updated_at DESC
                LIMIT ?
                """,
                (safe_limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_conversation(self, conversation_id: str) -> dict[str, Any] | None:
        cid = _conversation_id(conversation_id)
        with self._lock, self._connect() as connection:
            row = connection.execute(
                """
                SELECT id, title, mode, workflow, model, created_at, updated_at,
                       opencode_session_id
                FROM conversations WHERE id = ?
                """,
                (cid,),
            ).fetchone()
            if row is None:
                return None
            messages = connection.execute(
                """
                SELECT id, role, content, images_json, created_at
                FROM messages
                WHERE conversation_id = ?
                ORDER BY created_at, rowid
                """,
                (cid,),
            ).fetchall()
        result = dict(row)
        result["messages"] = [self._message(message) for message in messages]
        return result

    def delete_conversation(self, conversation_id: str) -> bool:
        cid = _conversation_id(conversation_id)
        with self._lock, self._connect() as connection:
            cursor = connection.execute("DELETE FROM conversations WHERE id = ?", (cid,))
        return bool(cursor.rowcount)

    def set_opencode_session(self, conversation_id: str, session_id: str) -> None:
        cid = _conversation_id(conversation_id)
        with self._lock, self._connect() as connection:
            connection.execute(
                "UPDATE conversations SET opencode_session_id = ?, updated_at = ? WHERE id = ?",
                (session_id, _now(), cid),
            )

    def get_opencode_session(self, conversation_id: str) -> str | None:
        cid = _conversation_id(conversation_id)
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT opencode_session_id FROM conversations WHERE id = ?", (cid,)
            ).fetchone()
        return str(row["opencode_session_id"]) if row and row["opencode_session_id"] else None


_store: ConversationStore | None = None
_store_lock = threading.Lock()


def get_conversation_store() -> ConversationStore:
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = ConversationStore()
    return _store
