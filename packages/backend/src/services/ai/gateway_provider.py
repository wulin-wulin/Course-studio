from typing import AsyncIterator

import openai
import httpx

from .base import AbstractAIProvider, AIRequest, StreamChunk, split_image_data


class GatewayProvider(AbstractAIProvider):
    def __init__(self, base_url: str, api_key: str, models: list[str], names: dict[str, str] | None = None):
        self.client = openai.AsyncOpenAI(
            base_url=base_url,
            api_key=api_key,
            timeout=httpx.Timeout(60.0, connect=10.0),
        )
        self.models = {m: m for m in models}
        self.names = names or {}

    def supports_model(self, model: str) -> bool:
        return model in self.models

    def supports_vision(self) -> bool:
        return True

    def list_models(self) -> list[dict]:
        return [
            {"id": k, "name": self.names.get(k, k), "provider": "gateway"}
            for k in self.models
        ]

    async def stream_generate(self, request: AIRequest) -> AsyncIterator[StreamChunk]:
        messages = self._build_messages(request)

        stream = await self.client.chat.completions.create(
            model=request.model,
            messages=messages,
            max_tokens=request.max_tokens,
            temperature=request.temperature,
            stream=True,
            extra_body={"reasoning_effort": request.reasoning_effort},
        )

        async for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if not delta:
                continue
            if hasattr(delta, "reasoning_content") and delta.reasoning_content:
                yield StreamChunk(type="thinking", content=delta.reasoning_content)
            elif delta.content:
                yield StreamChunk(type="content", content=delta.content)

        yield StreamChunk(type="done")

    async def generate(self, request: AIRequest) -> str:
        messages = self._build_messages(request)

        response = await self.client.chat.completions.create(
            model=request.model,
            messages=messages,
            max_tokens=request.max_tokens,
            temperature=request.temperature,
        )

        return response.choices[0].message.content or ""

    def _build_messages(self, request: AIRequest) -> list[dict]:
        messages = [{"role": "system", "content": request.system_prompt}]

        for msg in request.messages:
            content = []
            if msg.get("images"):
                for image in msg["images"]:
                    mime, data = split_image_data(image)
                    content.append({
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime};base64,{data}"},
                    })
            content.append({"type": "text", "text": msg["content"]})
            messages.append({"role": msg["role"], "content": content})

        return messages
