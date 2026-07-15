import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .api.router import api_router

logger = logging.getLogger(__name__)

app = FastAPI(title="课程知识森林 Agent", version="0.1.0")


@app.on_event("startup")
async def _provision_opencode():
    if not settings.opencode_enabled:
        return
    from .services.opencode import client as opencode_client

    # The opencode.json (provider + permissions) is generated and owned by
    # scripts/opencode.sh, since opencode reads its config at server startup
    # via OPENCODE_CONFIG — the backend only verifies the server is reachable.
    try:
        await opencode_client.health()
    except Exception:
        logger.warning(
            "opencode 服务未就绪（%s）。请先启动 opencode（Bash/WSL 使用 "
            "scripts/opencode.sh，Windows 使用 scripts/opencode.ps1）。",
            settings.opencode_base_url,
        )

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in settings.cors_origins.split(",")
        if origin.strip()
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api")
