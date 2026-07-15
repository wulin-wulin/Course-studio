from fastapi import APIRouter

from .health import router as health_router
from .agent import router as agent_router
from .settings import router as settings_router
from .courses import router as courses_router

api_router = APIRouter()
api_router.include_router(health_router, tags=["health"])
api_router.include_router(agent_router, prefix="/agent", tags=["agent"])
api_router.include_router(courses_router, prefix="/courses", tags=["courses"])
api_router.include_router(settings_router, tags=["settings"])
