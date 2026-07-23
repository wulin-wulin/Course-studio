#!/bin/bash
# Start the OpenCode headless server on the host for course-data Agent mode.
# The backend stages one all-course workspace per conversation beneath
# packages/backend/generated/course_agent_sessions. Docker reaches this
# process via host.docker.internal and shares that directory through a bind
# mount, so the backend and OpenCode always see the same staged JSON files.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
export COURSE_STUDIO_PROJECT_ROOT="$ROOT_DIR"

# Keep the launcher, generated config and backend on one environment file.
ENV_FILE="$ROOT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
fi

# OpenCode installs custom-tool dependencies in the background. Keep npm's
# cache inside the project so a root-owned entry in ~/.npm cannot prevent the
# structured course_pipeline tool from loading.
NPM_CACHE="${NPM_CONFIG_CACHE:-${npm_config_cache:-$ROOT_DIR/.tools/npm-cache}}"
export NPM_CONFIG_CACHE="$NPM_CACHE"
export npm_config_cache="$NPM_CACHE"
mkdir -p "$NPM_CACHE"

# .opencode/package.json is a generated, ignored runtime file. Recreate it from
# the tracked manifest so every launch uses the plugin version expected by the
# project-owned custom tool.
OPENCODE_TOOL_PACKAGE="$SCRIPT_DIR/opencode-tool-package.json"
OPENCODE_PROJECT_DIR="$ROOT_DIR/.opencode"
if [ ! -f "$OPENCODE_TOOL_PACKAGE" ]; then
    echo "缺少 OpenCode 自定义工具依赖清单：$OPENCODE_TOOL_PACKAGE"
    exit 1
fi
mkdir -p "$OPENCODE_PROJECT_DIR"
cp "$OPENCODE_TOOL_PACKAGE" "$OPENCODE_PROJECT_DIR/package.json"

PORT="${OPENCODE_PORT:-4096}"
HOSTNAME="${OPENCODE_HOSTNAME:-127.0.0.1}"
CORS="${OPENCODE_CORS:-http://127.0.0.1:5173}"

# Resolve the opencode binary: prefer one on PATH, otherwise fall back to the
# project-local copy under .tools/bin (used when the global npm install fails
# to fetch the platform binary, e.g. the optionalDependencies npm bug).
OPENCODE_BIN=""
if command -v opencode >/dev/null 2>&1; then
    OPENCODE_BIN="$(command -v opencode)"
else
    for candidate in \
        "$ROOT_DIR/.tools/bin/opencode" \
        /opt/homebrew/bin/opencode \
        /usr/local/bin/opencode; do
        if [ -x "$candidate" ]; then
            OPENCODE_BIN="$candidate"
            break
        fi
    done
fi
if [ -z "$OPENCODE_BIN" ]; then
    echo "opencode 未安装。安装方式（任选其一）："
    echo "  1) curl -fsSL https://opencode.ai/install | bash"
    echo "  2) brew install sst/tap/opencode"
    exit 1
fi

# opencode reads config from $XDG_CONFIG_HOME (default ~/.config). If that path
# is not writable — e.g. ~/.config is owned by root and you can't sudo — point
# the XDG dirs at a project-local location so opencode never touches $HOME.
CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
if [ -n "${XDG_CONFIG_HOME:-}" ] || { [ -d "$CONFIG_BASE" ] && [ -w "$CONFIG_BASE" ]; } || { [ ! -e "$CONFIG_BASE" ] && [ -w "$HOME" ]; }; then
    : # config dir is usable as-is
else
    echo "~/.config 不可写，改用项目内 XDG 目录（.tools/xdg）。"
    export XDG_CONFIG_HOME="$ROOT_DIR/.tools/xdg/config"
    export XDG_DATA_HOME="${XDG_DATA_HOME:-$ROOT_DIR/.tools/xdg/data}"
    export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$ROOT_DIR/.tools/xdg/cache}"
    export XDG_STATE_HOME="${XDG_STATE_HOME:-$ROOT_DIR/.tools/xdg/state}"
    mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
fi

# opencode does NOT auto-load opencode.json from the serve working directory; it
# only reads the global config dir and the project's git root. We therefore
# generate the config from .env here and point OPENCODE_CONFIG at it, so the
# provider is registered the moment the server boots (config is read at startup,
# not hot-reloaded per session).
# COURSE_DATA_DIR is the canonical persisted catalog. This directory holds
# backend-managed per-conversation copies that are validated and synchronized
# back to the catalog after each Agent turn.
DEFAULT_WORKDIR="$ROOT_DIR/packages/backend/generated/course_agent_sessions"
WORKDIR="${OPENCODE_WORKSPACE_DIR:-$DEFAULT_WORKDIR}"
if [[ "$WORKDIR" != /* && ! "$WORKDIR" =~ ^[A-Za-z]:[\\/].* ]]; then
    WORKDIR="$ROOT_DIR/$WORKDIR"
fi
mkdir -p "$WORKDIR"
cd "$WORKDIR"

# Generate opencode.json from models.json (or GATEWAY_* env fallback). Each
# model becomes its own provider so per-model endpoints/keys work. Prefer
# python3, but accept python for Git Bash and other Windows-oriented shells.
PY_BIN="$(command -v python3 || command -v python || true)"
if [ -z "$PY_BIN" ]; then
    echo "缺少 Python：生成 opencode 配置需要 python3 或 python。"
    exit 1
fi

CONFIG_FILE="$WORKDIR/opencode.json"
if ! "$PY_BIN" "$SCRIPT_DIR/gen_opencode_config.py" "$CONFIG_FILE"; then
    echo "生成 opencode 配置失败。请检查 models.json 或 .env 的模型/密钥配置。"
    exit 1
fi
export OPENCODE_CONFIG="$CONFIG_FILE"

echo "Starting OpenCode course-data server in $WORKDIR (port $PORT)..."
echo "Using opencode binary: $OPENCODE_BIN"
echo "Using config: $OPENCODE_CONFIG"
exec "$OPENCODE_BIN" serve --port "$PORT" --hostname "$HOSTNAME" --cors "$CORS"
