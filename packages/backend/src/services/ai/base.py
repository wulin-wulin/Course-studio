from abc import ABC, abstractmethod
from typing import AsyncIterator
from dataclasses import dataclass
import re


@dataclass
class StreamChunk:
    type: str  # "thinking" | "content" | "done" | "error"
    content: str = ""
    usage: dict | None = None


@dataclass
class AIRequest:
    system_prompt: str
    messages: list[dict]
    model: str
    enable_thinking: bool = True
    max_tokens: int = 16000
    temperature: float = 0.0
    images: list[bytes] | None = None
    reasoning_effort: str = "low"


_DATA_URL_RE = re.compile(
    r"^data:(?P<mime>[^;,]+)?(?:;charset=[^;,]+)?;base64,(?P<data>.+)$",
    re.DOTALL,
)


def split_image_data(image: str, default_mime: str = "image/png") -> tuple[str, str]:
    value = (image or "").strip()
    if not value:
        return default_mime, ""

    match = _DATA_URL_RE.match(value)
    if match:
        return match.group("mime") or default_mime, match.group("data")

    return default_mime, value


class AbstractAIProvider(ABC):
    @abstractmethod
    async def stream_generate(self, request: AIRequest) -> AsyncIterator[StreamChunk]:
        ...

    @abstractmethod
    async def generate(self, request: AIRequest) -> str:
        ...

    @abstractmethod
    def supports_model(self, model: str) -> bool:
        ...

    @abstractmethod
    def supports_vision(self) -> bool:
        ...

    @abstractmethod
    def list_models(self) -> list[dict]:
        ...
