import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Eye, EyeOff, Loader2, Plus, ServerCog, X } from "lucide-react";

export type ModelOption = {
  id: string;
  name: string;
  base_url: string;
  has_api_key: boolean;
  vision: boolean;
  is_default: boolean;
};

type ModelControlsProps = {
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  disabled?: boolean;
  compact?: boolean;
};

export function ModelControls({ selectedModel, onSelectModel, disabled, compact = false }: ModelControlsProps) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const loadModels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/models", { cache: "no-store" });
      if (!response.ok) throw new Error(`模型列表加载失败（${response.status}）`);
      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) throw new Error("模型列表格式无效");
      const nextModels = payload.filter(isModelOption);
      setModels(nextModels);
      if (!nextModels.some((model) => model.id === selectedModel)) {
        const preferred = nextModels.find((model) => model.is_default) ?? nextModels[0];
        if (preferred) onSelectModel(preferred.id);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模型列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [onSelectModel, selectedModel]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const handleCreated = (model: ModelOption) => {
    setModels((current) => [...current.filter((item) => item.id !== model.id), model]);
    onSelectModel(model.id);
    setDialogOpen(false);
  };

  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <div
          className={`relative min-w-0 flex-1 rounded-lg border bg-surface transition-colors ${
            error ? "border-error/40" : "border-border hover:border-primary/35"
          }`}
          title={error ?? "选择 OpenCode 使用的模型"}
        >
          {loading ? (
            <div className={`flex items-center gap-2 px-3 text-xs text-text-secondary ${compact ? "h-8" : "h-9"}`}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              加载模型
            </div>
          ) : (
            <>
              <select
                value={selectedModel}
                onChange={(event) => onSelectModel(event.target.value)}
                disabled={disabled || models.length === 0}
                className={`${compact ? "h-8" : "h-9"} w-full appearance-none truncate bg-transparent pl-3 pr-8 text-xs font-medium text-text-primary outline-none disabled:cursor-not-allowed disabled:opacity-60`}
                aria-label="选择对话模型"
              >
                {models.length === 0 && <option value="">暂无可用模型</option>}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-secondary" />
            </>
          )}
        </div>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          disabled={disabled}
          className={`inline-flex shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-text-secondary transition-colors hover:border-primary/35 hover:bg-primary-light hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 ${compact ? "h-8 w-8" : "h-9 w-9"}`}
          title="配置新模型"
          aria-label="配置新模型"
        >
          <Plus className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
        </button>
      </div>

      {dialogOpen && (
        <ModelDialog
          onClose={() => setDialogOpen(false)}
          onCreated={handleCreated}
        />
      )}
    </>
  );
}

function ModelDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (model: ModelOption) => void;
}) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !baseUrl.trim() || !apiKey.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          base_url: baseUrl.trim(),
          api_key: apiKey.trim(),
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(readApiError(payload, response.status));
      if (!isModelOption(payload)) throw new Error("后端返回的模型格式无效");
      onCreated(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模型保存失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/25 p-4 backdrop-blur-[2px]" role="presentation">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-surface shadow-lg" role="dialog" aria-modal="true" aria-labelledby="model-dialog-title">
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div className="flex min-w-0 gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-light text-primary">
              <ServerCog className="h-4.5 w-4.5" />
            </div>
            <div>
              <h2 id="model-dialog-title" className="text-sm font-semibold text-text-primary">配置 OpenAI 兼容模型</h2>
              <p className="mt-0.5 text-xs text-text-secondary">密钥只保存在本机 models.json，不会返回到浏览器。</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-text-secondary hover:bg-cream hover:text-text-primary" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4 px-5 py-5">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-text-primary">模型名称 / ID</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如 gpt-4.1-mini"
              autoFocus
              autoComplete="off"
              className="h-10 w-full rounded-lg border border-border bg-cream/45 px-3 text-sm outline-none transition-colors placeholder:text-text-secondary/55 focus:border-primary/55 focus:bg-surface"
            />
            <span className="mt-1 block text-[11px] text-text-secondary">支持字母、数字、点、下划线和连字符。</span>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-text-primary">Base URL</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
              inputMode="url"
              autoComplete="url"
              className="h-10 w-full rounded-lg border border-border bg-cream/45 px-3 text-sm outline-none transition-colors placeholder:text-text-secondary/55 focus:border-primary/55 focus:bg-surface"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-text-primary">API Key</span>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-..."
                autoComplete="new-password"
                className="h-10 w-full rounded-lg border border-border bg-cream/45 pl-3 pr-10 text-sm outline-none transition-colors placeholder:text-text-secondary/55 focus:border-primary/55 focus:bg-surface"
              />
              <button
                type="button"
                onClick={() => setShowKey((value) => !value)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-text-secondary hover:bg-cream-dark hover:text-text-primary"
                aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
              >
                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </label>

          {error && <div className="rounded-lg border border-error/20 bg-red-50 px-3 py-2 text-xs text-error">{error}</div>}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={submitting} className="h-9 rounded-lg border border-border px-4 text-xs font-medium text-text-secondary hover:bg-cream disabled:opacity-50">
              取消
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim() || !baseUrl.trim() || !apiKey.trim()}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-xs font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              保存并选择
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function isModelOption(value: unknown): value is ModelOption {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ModelOption>;
  return typeof candidate.id === "string" && typeof candidate.name === "string";
}

function readApiError(payload: unknown, status: number) {
  if (typeof payload === "object" && payload !== null && "detail" in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
  }
  return `模型保存失败（${status}）`;
}
