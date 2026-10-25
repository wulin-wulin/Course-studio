import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  X,
} from "lucide-react";

export type MineruParserMode = "local" | "mineru" | "auto";
export type MineruModelVersion = "vlm" | "pipeline";

export type MineruSettings = {
  documentParser: MineruParserMode;
  apiBase: string;
  tokenMasked: string;
  tokenConfigured: boolean;
  timeoutSeconds: number;
  modelVersion: MineruModelVersion;
};

type MineruSettingsDialogProps = {
  open: boolean;
  onClose: () => void;
};

const DEFAULT_SETTINGS: MineruSettings = {
  documentParser: "local",
  apiBase: "https://mineru.net/api/v4",
  tokenMasked: "",
  tokenConfigured: false,
  timeoutSeconds: 300,
  modelVersion: "vlm",
};

/**
 * The MinerU credential is deliberately edited in a separate dialog.  The
 * browser only ever receives the masked value returned by the backend; a new
 * token is sent only when the user explicitly enters one and is never stored
 * in localStorage or included in UI logs.
 */
export function MineruSettingsDialog({
  open,
  onClose,
}: MineruSettingsDialogProps) {
  const [settings, setSettings] = useState<MineruSettings>(DEFAULT_SETTINGS);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const loadSettings = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    setSavedMessage(null);
    try {
      const response = await fetch("/api/settings/mineru", {
        cache: "no-store",
        signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(readApiError(payload, response.status, "MinerU 配置加载失败"));
      }
      setSettings(parseMineruSettings(payload));
      setToken("");
      setShowToken(false);
    } catch (reason) {
      if (signal?.aborted) return;
      setError(reason instanceof Error ? reason.message : "MinerU 配置加载失败");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    const controller = new AbortController();
    void loadSettings(controller.signal);

    return () => controller.abort();
  }, [loadSettings, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open, saving]);

  if (!open) return null;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading || saving) return;

    const apiBase = settings.apiBase.trim();
    const timeoutSeconds = Number(settings.timeoutSeconds);
    if (!apiBase) {
      setError("请填写 MinerU API 地址。");
      return;
    }
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
      setError("超时时间需要在 1 到 3600 秒之间。");
      return;
    }
    if (settings.documentParser === "mineru" && !settings.tokenConfigured && !token.trim()) {
      setError("在线 MinerU 模式需要填写 API Token。");
      return;
    }

    setSaving(true);
    setError(null);
    setSavedMessage(null);
    try {
      const body: Record<string, unknown> = {
        document_parser: settings.documentParser,
        mineru_api_base: apiBase,
        mineru_timeout_seconds: timeoutSeconds,
        mineru_model_version: settings.modelVersion,
      };
      // An empty token means “keep the existing credential”.  The backend also
      // ignores its masked value, but we never send that value back at all.
      if (token.trim()) body.mineru_api_token = token.trim();

      const response = await fetch("/api/settings/mineru", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(readApiError(payload, response.status, "MinerU 配置保存失败"));
      }
      const nextSettings = parseMineruSettings(payload);
      setSettings(nextSettings);
      setToken("");
      setShowToken(false);
      setSavedMessage("MinerU 配置已保存。下一次 PDF 解析会使用新设置。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "MinerU 配置保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/25 p-4 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-surface shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mineru-settings-title"
      >
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div className="flex min-w-0 gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-light text-primary">
              <ServerCog className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 id="mineru-settings-title" className="text-sm font-semibold text-text-primary">
                配置 MinerU 教材解析
              </h2>
              <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
                这里的设置决定 PDF 上传时使用本地解析还是在线 MinerU。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg p-1.5 text-text-secondary hover:bg-cream hover:text-text-primary disabled:opacity-40"
            aria-label="关闭 MinerU 设置"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={save} className="space-y-4 px-5 py-5">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-text-primary">PDF 解析方式</span>
            <select
              value={settings.documentParser}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  documentParser: parseParserMode(event.target.value),
                }))
              }
              disabled={loading || saving}
              className="h-10 w-full rounded-lg border border-border bg-cream/45 px-3 text-sm outline-none transition-colors focus:border-primary/55 focus:bg-surface disabled:opacity-60"
            >
              <option value="local">本地解析（不调用 MinerU）</option>
              <option value="mineru">在线 MinerU（必须配置 Token）</option>
              <option value="auto">自动选择（有 Token 时使用 MinerU）</option>
            </select>
            <span className="mt-1 block text-[11px] leading-relaxed text-text-secondary">
              建议使用“在线 MinerU”获得教材结构和版面识别；没有 Token 时可暂时使用本地解析。
            </span>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-text-primary">MinerU API 地址</span>
            <input
              value={settings.apiBase}
              onChange={(event) => setSettings((current) => ({ ...current, apiBase: event.target.value }))}
              placeholder="https://mineru.net/api/v4"
              inputMode="url"
              autoComplete="url"
              disabled={loading || saving}
              className="h-10 w-full rounded-lg border border-border bg-cream/45 px-3 text-sm outline-none transition-colors placeholder:text-text-secondary/55 focus:border-primary/55 focus:bg-surface disabled:opacity-60"
            />
          </label>

          <div>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-text-primary">MinerU API Token</span>
              <div className="relative">
                <input
                  type={showToken ? "text" : "password"}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder={settings.tokenConfigured ? "已配置；输入新 Token 可替换" : "粘贴 MinerU Token"}
                  autoComplete="new-password"
                  disabled={loading || saving}
                  className="h-10 w-full rounded-lg border border-border bg-cream/45 pl-3 pr-10 text-sm outline-none transition-colors placeholder:text-text-secondary/55 focus:border-primary/55 focus:bg-surface disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((value) => !value)}
                  disabled={loading || saving}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-text-secondary hover:bg-cream-dark hover:text-text-primary disabled:opacity-40"
                  aria-label={showToken ? "隐藏 MinerU Token" : "显示 MinerU Token"}
                >
                  {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </label>
            <div className="mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-text-secondary">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
              <span>
                {settings.tokenConfigured
                  ? `后端已保存 Token（${settings.tokenMasked || "已配置"}）。留空会保留当前 Token。`
                  : "Token 只保存到后端 .env，不会写入浏览器缓存或课程内容。"}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-text-primary">模型版本</span>
              <select
                value={settings.modelVersion}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    modelVersion: parseModelVersion(event.target.value),
                  }))
                }
                disabled={loading || saving}
                className="h-10 w-full rounded-lg border border-border bg-cream/45 px-3 text-sm outline-none transition-colors focus:border-primary/55 focus:bg-surface disabled:opacity-60"
              >
                <option value="vlm">VLM（版面理解）</option>
                <option value="pipeline">Pipeline（标准流水线）</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-text-primary">单段超时（秒）</span>
              <input
                type="number"
                min={1}
                max={3600}
                step={1}
                value={settings.timeoutSeconds}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    timeoutSeconds: Number(event.target.value),
                  }))
                }
                disabled={loading || saving}
                className="h-10 w-full rounded-lg border border-border bg-cream/45 px-3 text-sm outline-none transition-colors focus:border-primary/55 focus:bg-surface disabled:opacity-60"
              />
            </label>
          </div>

          {loading && (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-cream/45 px-3 py-2 text-xs text-text-secondary" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              正在读取后端 MinerU 配置…
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-error/20 bg-red-50 px-3 py-2 text-xs leading-relaxed text-error" role="alert">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
          {savedMessage && (
            <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary-light px-3 py-2 text-xs leading-relaxed text-primary" role="status">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{savedMessage}</span>
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={() => void loadSettings()}
              disabled={loading || saving}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium text-text-secondary hover:bg-cream disabled:opacity-50"
              title="重新读取后端配置"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              重新读取
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="h-9 rounded-lg border border-border px-4 text-xs font-medium text-text-secondary hover:bg-cream disabled:opacity-50"
              >
                关闭
              </button>
              <button
                type="submit"
                disabled={loading || saving}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-xs font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                保存配置
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function parseMineruSettings(payload: unknown): MineruSettings {
  const source = isRecord(payload) && isRecord(payload.settings) ? payload.settings : payload;
  if (!isRecord(source)) return DEFAULT_SETTINGS;

  const tokenValue = readString(source, "mineru_api_token", "api_token", "token");
  const tokenConfigured =
    readBoolean(source, "mineru_token_configured", "token_configured", "has_token") ??
    Boolean(tokenValue && !/^\*+$/.test(tokenValue));
  return {
    documentParser: parseParserMode(readString(source, "document_parser", "parser") || DEFAULT_SETTINGS.documentParser),
    apiBase: readString(source, "mineru_api_base", "api_base", "base_url") || DEFAULT_SETTINGS.apiBase,
    tokenMasked: tokenValue || (tokenConfigured ? "已配置" : ""),
    tokenConfigured,
    timeoutSeconds: readNumber(source, "mineru_timeout_seconds", "timeout_seconds", "timeout") ?? DEFAULT_SETTINGS.timeoutSeconds,
    modelVersion: parseModelVersion(readString(source, "mineru_model_version", "model_version", "model") || DEFAULT_SETTINGS.modelVersion),
  };
}

function parseParserMode(value: string): MineruParserMode {
  return value === "mineru" || value === "auto" ? value : "local";
}

function parseModelVersion(value: string): MineruModelVersion {
  return value === "pipeline" ? "pipeline" : "vlm";
}

function readString(source: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (typeof source[key] === "string") return source[key].trim();
  }
  return "";
}

function readNumber(source: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function readBoolean(source: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (typeof source[key] === "boolean") return source[key];
  }
  return null;
}

function readApiError(payload: unknown, status: number, fallback: string) {
  if (isRecord(payload) && typeof payload.detail === "string") return payload.detail;
  return `${fallback}（${status}）`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
