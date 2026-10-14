FROM python:3.12-slim

WORKDIR /app

# The local textbook parser uses Poppler's pdftotext for layout-preserving
# extraction.  pypdf remains responsible only for reliable page counting.
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*

COPY packages/backend/pyproject.toml ./pyproject.toml
COPY packages/backend/src/ ./src/
COPY course-data/ ./course-data/

# Runtime dependencies include FastAPI, OpenCode communication, and model
# clients. Course JSON packages, course-creation skills, and pipeline tools are
# copied for standalone container use and can be replaced by Compose bind
# mounts in development.
RUN pip install --no-cache-dir ".[dev]"

COPY skills/ ./skills/
COPY scripts/ ./scripts/

RUN mkdir -p /app/generated

ENV COURSE_AGENT_ROOT=/app

EXPOSE 8000

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload", "--reload-dir", "src"]
