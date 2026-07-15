from .base import AbstractAIProvider
from .gateway_provider import GatewayProvider
from . import model_config


class AIModelRouter:
    def __init__(self):
        self.providers: list[AbstractAIProvider] = []
        self._init_providers()

    def reload(self):
        """Rebuild providers after settings change so new models take effect."""
        self.providers = []
        self._init_providers()

    def _init_providers(self):
        # models.json is the single source of truth. One provider per declared
        # model so each can carry its own endpoint and API key.
        for m in model_config.load_models():
            if m.base_url and m.api_key:
                self.providers.append(
                    GatewayProvider(m.base_url, m.api_key, [m.id], {m.id: m.name})
                )

    def get_provider(self, model: str) -> AbstractAIProvider:
        for provider in self.providers:
            if provider.supports_model(model):
                return provider
        if self.providers:
            return self.providers[0]
        raise ValueError("No AI provider configured. Add a model to models.json.")

    def list_available_models(self) -> list[dict]:
        models = []
        for provider in self.providers:
            models.extend(provider.list_models())
        return models


ai_router = AIModelRouter()
