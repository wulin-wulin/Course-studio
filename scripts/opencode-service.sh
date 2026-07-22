#!/bin/bash
# Keep the host-side OpenCode server alive independently of the launching
# terminal. The foreground launcher remains scripts/opencode.sh; this wrapper
# supervises it, writes a PID file, and restarts it after unexpected exits.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
fi
RUNTIME_DIR="$ROOT_DIR/packages/backend/generated/opencode-service"
PID_FILE="$RUNTIME_DIR/supervisor.pid"
LOG_FILE="$RUNTIME_DIR/opencode-service.log"
HEALTH_URL="http://127.0.0.1:${OPENCODE_PORT:-4096}/global/health"
RESTART_DELAY="${OPENCODE_SERVICE_RESTART_DELAY_SECONDS:-3}"
PLATFORM="$(uname -s)"
if command -v shasum >/dev/null 2>&1; then
    PROJECT_HASH="$(printf '%s' "$ROOT_DIR" | shasum -a 256 | cut -c1-12)"
else
    PROJECT_HASH="$(printf '%s' "$ROOT_DIR" | sha256sum | cut -c1-12)"
fi
SCREEN_SESSION="course-studio-opencode-${PROJECT_HASH}"
SCREEN_BIN="$(command -v screen || true)"

read_pid() {
    if [ ! -f "$PID_FILE" ]; then
        return 1
    fi
    local pid
    pid="$(tr -d '[:space:]' < "$PID_FILE")"
    if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
        return 1
    fi
    printf '%s' "$pid"
}

pid_is_running() {
    local pid="${1:-}"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

server_is_healthy() {
    curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1
}

screen_is_running() {
    [ -n "$SCREEN_BIN" ] \
        && "$SCREEN_BIN" -list 2>/dev/null | grep -Fq ".${SCREEN_SESSION}"
}

wait_for_health() {
    local attempt=0
    while [ "$attempt" -lt 30 ]; do
        if server_is_healthy; then
            return 0
        fi
        sleep 1
        attempt=$((attempt + 1))
    done
    return 1
}

start_screen_service() {
    if [ -z "$SCREEN_BIN" ]; then
        echo "macOS 缺少 screen，无法脱离当前终端运行 OpenCode。"
        return 1
    fi
    mkdir -p "$RUNTIME_DIR"
    if screen_is_running; then
        if server_is_healthy; then
            echo "OpenCode 后台服务已运行（screen ${SCREEN_SESSION}）。"
            return 0
        fi
        "$SCREEN_BIN" -S "$SCREEN_SESSION" -X quit >/dev/null 2>&1 || true
    elif server_is_healthy; then
        echo "4096 端口已有健康的 OpenCode 服务；未重复启动。"
        return 0
    fi

    "$SCREEN_BIN" -dmS "$SCREEN_SESSION" /bin/bash "$0" supervise-logged
    if wait_for_health; then
        echo "OpenCode 后台服务已启动（screen ${SCREEN_SESSION}）。"
        echo "日志：$LOG_FILE"
        return 0
    fi
    echo "OpenCode 后台服务启动失败，请检查日志：$LOG_FILE"
    tail -30 "$LOG_FILE" 2>/dev/null || true
    return 1
}

stop_screen_service() {
    if screen_is_running; then
        "$SCREEN_BIN" -S "$SCREEN_SESSION" -X quit >/dev/null 2>&1 || true
        local attempt=0
        while [ "$attempt" -lt 20 ] && screen_is_running; do
            sleep 0.25
            attempt=$((attempt + 1))
        done
    fi
    rm -f "$PID_FILE"
    echo "OpenCode 后台服务已停止。"
}

status_screen_service() {
    if screen_is_running && server_is_healthy; then
        echo "OpenCode 后台服务运行正常（screen ${SCREEN_SESSION}）。"
        return 0
    fi
    if screen_is_running; then
        echo "OpenCode 后台服务仍在启动，健康检查尚未通过（screen ${SCREEN_SESSION}）。"
        return 1
    fi
    if server_is_healthy; then
        echo "OpenCode 服务健康，但不是由本项目后台服务管理。"
        return 0
    fi
    echo "OpenCode 后台服务未运行。"
    return 1
}

supervise() {
    local stopping=0
    local child_pid=""

    stop_child() {
        stopping=1
        if pid_is_running "$child_pid"; then
            kill "$child_pid" 2>/dev/null || true
            wait "$child_pid" 2>/dev/null || true
        fi
    }

    trap stop_child INT TERM
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] OpenCode supervisor started."
    while [ "$stopping" -eq 0 ]; do
        bash "$SCRIPT_DIR/opencode.sh" &
        child_pid=$!
        wait "$child_pid"
        local exit_code=$?
        child_pid=""
        if [ "$stopping" -ne 0 ]; then
            break
        fi
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] OpenCode exited with code $exit_code; restarting in ${RESTART_DELAY}s."
        sleep "$RESTART_DELAY"
    done
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] OpenCode supervisor stopped."
}

start_service() {
    if [ "$PLATFORM" = "Darwin" ]; then
        start_screen_service
        return
    fi
    mkdir -p "$RUNTIME_DIR"
    local existing_pid=""
    existing_pid="$(read_pid 2>/dev/null || true)"
    if pid_is_running "$existing_pid"; then
        if server_is_healthy; then
            echo "OpenCode 后台服务已运行（supervisor PID ${existing_pid}）。"
            return 0
        fi
        echo "OpenCode supervisor 已运行但健康检查尚未通过（PID ${existing_pid}）。"
        return 1
    fi
    if server_is_healthy; then
        echo "4096 端口已有健康的 OpenCode 服务；未重复启动。"
        return 0
    fi

    nohup bash "$0" supervise >>"$LOG_FILE" 2>&1 </dev/null &
    local supervisor_pid=$!
    printf '%s\n' "$supervisor_pid" > "$PID_FILE"

    local attempt=0
    while [ "$attempt" -lt 30 ]; do
        if server_is_healthy; then
            echo "OpenCode 后台服务已启动（supervisor PID ${supervisor_pid}）。"
            echo "日志：$LOG_FILE"
            return 0
        fi
        if ! pid_is_running "$supervisor_pid"; then
            break
        fi
        sleep 1
        attempt=$((attempt + 1))
    done

    echo "OpenCode 后台服务启动失败，请检查日志：$LOG_FILE"
    tail -30 "$LOG_FILE" 2>/dev/null || true
    if pid_is_running "$supervisor_pid"; then
        kill "$supervisor_pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    return 1
}

stop_service() {
    if [ "$PLATFORM" = "Darwin" ]; then
        stop_screen_service
        return
    fi
    local pid=""
    pid="$(read_pid 2>/dev/null || true)"
    if ! pid_is_running "$pid"; then
        echo "OpenCode 后台服务未运行。"
        rm -f "$PID_FILE"
        return 0
    fi

    kill "$pid"
    local attempt=0
    while [ "$attempt" -lt 20 ]; do
        if ! pid_is_running "$pid"; then
            rm -f "$PID_FILE"
            echo "OpenCode 后台服务已停止。"
            return 0
        fi
        sleep 0.25
        attempt=$((attempt + 1))
    done
    echo "OpenCode supervisor 未在预期时间内停止（PID ${pid}）。"
    return 1
}

status_service() {
    if [ "$PLATFORM" = "Darwin" ]; then
        status_screen_service
        return
    fi
    local pid=""
    pid="$(read_pid 2>/dev/null || true)"
    if pid_is_running "$pid" && server_is_healthy; then
        echo "OpenCode 后台服务运行正常（supervisor PID ${pid}）。"
        return 0
    fi
    if pid_is_running "$pid"; then
        echo "OpenCode supervisor 正在运行，但健康检查失败（PID ${pid}）。"
        return 1
    fi
    if server_is_healthy; then
        echo "OpenCode 服务健康，但不是由本项目 supervisor 管理。"
        return 0
    fi
    echo "OpenCode 后台服务未运行。"
    return 1
}

command="${1:-status}"
case "$command" in
    start)
        start_service
        ;;
    stop)
        stop_service
        ;;
    restart)
        stop_service
        start_service
        ;;
    status)
        status_service
        ;;
    supervise)
        supervise
        ;;
    supervise-logged)
        mkdir -p "$RUNTIME_DIR"
        exec >>"$LOG_FILE" 2>&1
        supervise
        ;;
    logs)
        mkdir -p "$RUNTIME_DIR"
        touch "$LOG_FILE"
        tail -f "$LOG_FILE"
        ;;
    *)
        echo "用法：bash scripts/opencode-service.sh {start|stop|restart|status|logs}"
        exit 2
        ;;
esac
