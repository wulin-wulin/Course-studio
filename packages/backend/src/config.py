from pathlib import Path
import os

from pydantic_settings import BaseSettings


def _default_project_root() -> Path:
    """Find the repository root in a checkout or the application root in Docker."""
    source_file = Path(__file__).resolve()
    for directory in source_file.parents:
        if (directory / "packages" / "backend" / "src").is_dir():
            return directory
    # The container image installs the backend at /app/src rather than
    # preserving the repository's packages/backend hierarchy.
    return source_file.parents[1]


# COURSE_AGENT_ROOT keeps paths deterministic in Docker while the inferred
# value preserves the existing local-development layout.
PROJECT_ROOT = Path(os.environ.get("COURSE_AGENT_ROOT", _default_project_root())).resolve()
# Project root .env (single source of truth, shared with the opencode scripts).
ENV_FILE = PROJECT_ROOT / ".env"


class Settings(BaseSettings):
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    gateway_url: str = ""
    gateway_api_key: str = ""
    gateway_models: str = ""

    agent_base_url: str = ""
    default_model: str = ""

    # Agent mode powered by opencode. When disabled, fall back to the legacy
    # in-process anthropic loop.
    opencode_enabled: bool = True
    opencode_base_url: str = "http://127.0.0.1:4096"
    opencode_provider_id: str = "coursegw"
    opencode_provider_base_url: str = ""
    opencode_server_password: str = ""
    # Maximum time a submitted OpenCode turn may wait for a terminal SSE
    # event.  This prevents a lost ``session.idle`` event or a wedged tool
    # process from leaving the browser in its running state forever.
    opencode_terminal_timeout_seconds: float = 3600.0
    # Course creation can legitimately spend much longer generating and
    # validating dozens of points and animations. Keep its hard ceiling
    # separate so ordinary chat/edit turns still fail fast when wedged.
    course_create_terminal_timeout_seconds: float = 21600.0
    # Course data is intentionally outside the frontend bundle.  It is the
    # canonical JSON package directory used by both the HTTP API and future
    # course-management skills.
    course_data_dir: Path = Path("course-data") / "courses"
    course_default_id: str = "ai-principles"
    # OpenCode receives a restricted course-data workspace.  By default this
    # lives beside the existing generated assets; deployments can override it
    # when OpenCode runs on a different host filesystem.
    course_agent_workspace_dir: Path | None = None
    opencode_course_host_root: str = ""

    backend_host: str = "0.0.0.0"
    backend_port: int = 8000
    # Comma-separated browser origins allowed to call the local API.  Keeping
    # this configurable lets a second local checkout use a different Vite port
    # without weakening CORS for every origin.
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    generated_dir: Path = Path("generated")

    model_config = {
        "env_file": str(ENV_FILE),
        "extra": "ignore",
    }


settings = Settings()


def _first_gateway_model(value: str) -> str:
    return next((item.strip() for item in value.split(",") if item.strip()), "")


if not settings.agent_base_url:
    settings.agent_base_url = settings.gateway_url or "https://token-plan-sgp.xiaomimimo.com/v1"
if not settings.default_model:
    settings.default_model = _first_gateway_model(settings.gateway_models) or "mimo-v2.5-pro"

settings.generated_dir.mkdir(parents=True, exist_ok=True)

# ``course_data_dir`` is a repository-level durable data package.  Generated
# agent workspaces, on the other hand, follow the existing generated_dir so
# local development and Docker retain their established path behaviour.
if not settings.course_data_dir.is_absolute():
    settings.course_data_dir = (PROJECT_ROOT / settings.course_data_dir).resolve()
else:
    settings.course_data_dir = settings.course_data_dir.resolve()
if settings.course_agent_workspace_dir is None:
    settings.course_agent_workspace_dir = (settings.generated_dir / "course_agent_sessions").resolve()
elif not settings.course_agent_workspace_dir.is_absolute():
    settings.course_agent_workspace_dir = settings.course_agent_workspace_dir.resolve()
else:
    settings.course_agent_workspace_dir = settings.course_agent_workspace_dir.resolve()
settings.course_data_dir.mkdir(parents=True, exist_ok=True)
settings.course_agent_workspace_dir.mkdir(parents=True, exist_ok=True)
