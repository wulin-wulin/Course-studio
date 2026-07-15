import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  AlertTriangle,
  Bot,
  Brain,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ImagePlus,
  Loader2,
  PanelRightClose,
  Send,
  Terminal,
  X,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import { getBackendWsUrl } from "@/utils/backendWs";
import { CollapsibleContent } from "./CollapsibleContent";
import { ImageAttachments } from "./ImageAttachments";
import { MarkdownContent } from "./MarkdownContent";

type AgentEntry = {
  id: string;
  role: "user" | "agent" | "system" | "error" | "thinking";
  title: string;
  content?: string;
  images?: string[];
  status?: "running" | "success" | "error";
  streaming?: boolean;
};

type AgentRunStatus = {
  label: string;
  detail?: string;
  startedAt: number;
  updatedAt: number;
};

type ConnectionState = "connecting" | "connected" | "disconnected";

type HandlerCtx = {
  setEntries: Dispatch<SetStateAction<AgentEntry[]>>;
  setIsRunning: Dispatch<SetStateAction<boolean>>;
  setRunStatus: Dispatch<SetStateAction<AgentRunStatus | null>>;
  streamingIdRef: RefObject<string | null>;
  thinkingIdRef: RefObject<string | null>;
};

type AgentPanelProps = {
  onCollapse?: () => void;
};

export function AgentPanel({ onCollapse }: AgentPanelProps) {
  const selectedModel = useChatStore((s) => s.selectedModel);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const createConversation = useChatStore((s) => s.createConversation);
  const [entries, setEntries] = useState<AgentEntry[]>([]);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [runStatus, setRunStatus] = useState<AgentRunStatus | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const wsUrlRef = useRef(getBackendWsUrl("/api/agent/ws"));
  const lastActiveConversationIdRef = useRef<string | null>(activeConversationId);
  const streamingIdRef = useRef<string | null>(null);
  const thinkingIdRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    let disposed = false;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const connect = () => {
      if (disposed) return;
      clearReconnectTimer();
      setConnectionState("connecting");

      let opened = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrlRef.current);
      } catch {
        reconnectTimerRef.current = window.setTimeout(connect, 1200);
        return;
      }
      const openTimer = window.setTimeout(() => {
        if (!opened) ws.close();
      }, 2500);
      wsRef.current = ws;

      ws.onopen = () => {
        opened = true;
        window.clearTimeout(openTimer);
        setConnectionState("connected");
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleAgentEvent(data, {
            setEntries,
            setIsRunning,
            setRunStatus,
            streamingIdRef,
            thinkingIdRef,
          });
        } catch {
          setEntries((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "error",
              title: "事件解析失败",
              content: "无法解析后端发来的 Agent 事件。",
              status: "error",
            },
          ]);
        }
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        window.clearTimeout(openTimer);
        if (wsRef.current === ws) wsRef.current = null;
        if (disposed) return;
        setConnectionState("disconnected");
        settleActiveEntries(setEntries, "error");
        setIsRunning(false);
        setRunStatus(null);
        streamingIdRef.current = null;
        thinkingIdRef.current = null;
        reconnectTimerRef.current = window.setTimeout(connect, 1200);
      };
    };

    connect();

    return () => {
      disposed = true;
      clearReconnectTimer();
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!activeConversationId || activeConversationId === lastActiveConversationIdRef.current) return;
    lastActiveConversationIdRef.current = activeConversationId;
    setEntries([]);
    setIsRunning(false);
    setRunStatus(null);
    streamingIdRef.current = null;
    thinkingIdRef.current = null;
    stickToBottomRef.current = true;
  }, [activeConversationId]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [entries, isRunning, runStatus]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= 24;
  }, []);

  useEffect(() => {
    if (!isRunning) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  const send = useCallback(() => {
    const message = input.trim();
    if ((!message && images.length === 0) || isRunning || wsRef.current?.readyState !== WebSocket.OPEN) return;

    let conversationId = activeConversationId;
    if (!conversationId) {
      conversationId = createConversation();
      lastActiveConversationIdRef.current = conversationId;
    }

    streamingIdRef.current = null;
    thinkingIdRef.current = null;
    stickToBottomRef.current = true;
    setEntries((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "user",
        title: "你",
        content: message || (images.length > 0 ? `已发送 ${images.length} 张图片` : ""),
        images: images.length > 0 ? [...images] : undefined,
      },
    ]);
    setInput("");
    setImages([]);
    setIsRunning(true);
    setRunStatus(makeRunStatus("Agent 启动中", "正在准备课程数据工作区"));
    wsRef.current.send(
      JSON.stringify({
        type: "agent_request",
        payload: {
          conversation_id: conversationId,
          message,
          images,
          model: selectedModel,
        },
      })
    );
  }, [activeConversationId, createConversation, images, input, isRunning, selectedModel]);

  const handleImageUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        if (result) {
          setImages((prev) => [...prev, result]);
        }
      };
      reader.readAsDataURL(file);
    });

    event.target.value = "";
  }, []);

  const status = useMemo(() => {
    if (isRunning) return "运行中";
    if (connectionState === "connected") return "就绪";
    if (connectionState === "connecting") return "连接中";
    return "重连中";
  }, [connectionState, isRunning]);

  const isConnected = connectionState === "connected";
  const elapsedSeconds = runStatus ? Math.max(0, Math.floor((clock - runStatus.startedAt) / 1000)) : 0;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-surface text-text-primary">
      <div className="px-3 py-2 border-b border-border bg-cream/70 flex items-center justify-between">
        <div className="min-w-0 flex items-center gap-2">
          <div className="w-7 h-7 rounded-md border border-border bg-surface flex items-center justify-center">
            <BookOpen className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">课程智能体</div>
            <div className="text-[11px] text-text-secondary truncate">OpenCode · 课程数据工作区</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-md border ${
              isConnected
                ? "border-primary/25 text-primary bg-primary-light"
                : "border-warning/30 text-warning bg-warning/10"
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? "bg-primary" : "bg-warning"}`} />
            {status}
          </span>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              aria-controls="course-agent-panel"
              aria-expanded={true}
              aria-label="收起 OpenCode Agent 面板"
              title="收起 OpenCode Agent 面板"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-cream-dark hover:text-text-primary"
            >
              <PanelRightClose className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-3 space-y-2 bg-surface"
      >
        {entries.length === 0 && (
          <div className="h-full flex flex-col justify-center text-center px-5 text-text-secondary">
            <div className="mx-auto w-10 h-10 rounded-md bg-cream border border-border flex items-center justify-center mb-3">
              <Terminal className="w-5 h-5 text-primary" />
            </div>
            <h3 className="text-sm font-medium text-text-primary mb-1">Agent 会话</h3>
            <p className="text-xs leading-relaxed">创建课程、填充知识点，或维护现有课程内容。</p>
          </div>
        )}

        {entries.map((entry) => (
          <AgentEntryView key={entry.id} entry={entry} />
        ))}

        {isRunning && (
          <AgentRunStatusView status={runStatus} elapsedSeconds={elapsedSeconds} />
        )}
      </div>

      <div className="p-3 border-t border-border bg-surface">
        <div className="rounded-lg bg-cream border border-border overflow-hidden shadow-sm">
          {images.length > 0 && (
            <div className="flex gap-2 flex-wrap px-3 pt-3">
              {images.map((img, index) => (
                <div
                  key={`${img.slice(0, 24)}-${index}`}
                  className="relative h-12 w-12 overflow-hidden rounded-md border border-border bg-surface"
                >
                  <img src={img} alt="" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== index))}
                    className="absolute right-0 top-0 inline-flex h-4 w-4 items-center justify-center rounded-bl-md bg-black/55 text-white"
                    title="移除图片"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2 px-3 py-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-1.5 rounded-md hover:bg-cream-dark text-text-secondary transition-colors"
              title="上传图片"
            >
              <ImagePlus className="w-4 h-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleImageUpload}
            />
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="例如：为课程新增一个知识点，或修改某个知识点内容"
              rows={3}
              className="flex-1 resize-none bg-transparent px-0 py-1 text-sm text-text-primary outline-none placeholder:text-text-secondary/60"
            />
            <button
              onClick={send}
              disabled={!isConnected || isRunning || (!input.trim() && images.length === 0)}
              className="w-7 h-7 rounded-md bg-primary hover:bg-primary-hover text-white disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
              title="发送"
            >
              {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
          <div className="flex items-center justify-between px-3 pb-2">
            <span className="text-[11px] text-text-secondary">Enter 发送 / Shift+Enter 换行</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function handleAgentEvent(
  data: { type: string; payload?: Record<string, unknown> },
  ctx: HandlerCtx
) {
  const { setEntries, setIsRunning, setRunStatus, streamingIdRef, thinkingIdRef } = ctx;
  const payload = data.payload ?? {};

  switch (data.type) {
    case "agent_heartbeat":
      setRunStatus((prev) => (prev ? { ...prev, updatedAt: Date.now() } : prev));
      return;

    case "agent_start":
      updateRunStatus(setRunStatus, "Agent 启动中", "正在准备工作环境");
      return;

    case "agent_status":
      updateRunStatus(setRunStatus, String(payload.label ?? "Agent 工作中"));
      return;

    case "agent_thinking_delta": {
      const text = String(payload.text ?? "");
      if (!text) return;
      finalizeThinkingIfMissing(thinkingIdRef, setEntries);
      const thinkingId = thinkingIdRef.current;
      setEntries((prev) =>
        prev.map((e) =>
          e.id === thinkingId ? { ...e, content: (e.content ?? "") + text } : e
        )
      );
      return;
    }

    case "agent_text_delta": {
      const text = String(payload.text ?? "");
      if (!text) return;
      finalizeThinking(thinkingIdRef, setEntries);
      finalizeStreamingIfMissing(streamingIdRef, setEntries);
      const streamingId = streamingIdRef.current;
      setEntries((prev) =>
        prev.map((e) =>
          e.id === streamingId ? { ...e, content: (e.content ?? "") + text } : e
        )
      );
      return;
    }

    case "agent_text_done": {
      const streamingId = streamingIdRef.current;
      streamingIdRef.current = null;
      if (!streamingId) return;
      setEntries((prev) => {
        const target = prev.find((e) => e.id === streamingId);
        if (!target) return prev;
        if (!target.content || !target.content.trim()) {
          return prev.filter((e) => e.id !== streamingId);
        }
        return prev.map((e) => (e.id === streamingId ? { ...e, streaming: false } : e));
      });
      return;
    }

    case "agent_tool_use": {
      finalizeStreaming(streamingIdRef, setEntries);
      finalizeThinking(thinkingIdRef, setEntries);
      updateRunStatus(setRunStatus, "Agent 工作中");
      return;
    }

    case "agent_tool_result": {
      return;
    }

    case "course_data_changed": {
      window.dispatchEvent(new CustomEvent("course-data-changed", { detail: payload }));
      updateRunStatus(setRunStatus, "课程数据已更新", "知识森林正在刷新");
      setEntries((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          title: "课程数据已更新",
          content: "知识森林已收到最新课程数据，正在重新加载。",
          status: "success",
        },
      ]);
      return;
    }

    case "agent_done": {
      finalizeStreaming(streamingIdRef, setEntries);
      finalizeThinking(thinkingIdRef, setEntries);
      settleActiveEntries(setEntries, Number(payload.return_code) === 0 ? "success" : "error");
      setIsRunning(false);
      setRunStatus(null);
      const code = Number(payload.return_code);
      if (code === 0) return;
      setEntries((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "error",
          title: "Agent 异常退出",
          content: `退出码 ${String(payload.return_code ?? "未知")}`,
          status: "error",
        },
      ]);
      return;
    }

    case "agent_error": {
      finalizeStreaming(streamingIdRef, setEntries);
      finalizeThinking(thinkingIdRef, setEntries);
      settleActiveEntries(setEntries, "error");
      const message = String(payload.message ?? payload.content ?? "");
      setIsRunning(false);
      setRunStatus(null);
      setEntries((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "error",
          title: "Agent 错误",
          content: message,
          status: "error",
        },
      ]);
      return;
    }

    default:
      return;
  }
}

function finalizeStreamingIfMissing(
  streamingIdRef: RefObject<string | null>,
  setEntries: Dispatch<SetStateAction<AgentEntry[]>>
) {
  if (streamingIdRef.current) return;
  const id = crypto.randomUUID();
  streamingIdRef.current = id;
  setEntries((prev) => [
    ...prev,
    { id, role: "agent", title: "Agent", content: "", streaming: true },
  ]);
}

function finalizeStreaming(
  streamingIdRef: RefObject<string | null>,
  setEntries: Dispatch<SetStateAction<AgentEntry[]>>
) {
  const streamingId = streamingIdRef.current;
  streamingIdRef.current = null;
  if (!streamingId) return;
  setEntries((prev) => {
    const target = prev.find((e) => e.id === streamingId);
    if (!target) return prev;
    if (!target.content || !target.content.trim()) {
      return prev.filter((e) => e.id !== streamingId);
    }
    return prev.map((e) => (e.id === streamingId ? { ...e, streaming: false } : e));
  });
}

function finalizeThinkingIfMissing(
  thinkingIdRef: RefObject<string | null>,
  setEntries: Dispatch<SetStateAction<AgentEntry[]>>
) {
  if (thinkingIdRef.current) return;
  const id = crypto.randomUUID();
  thinkingIdRef.current = id;
  setEntries((prev) => [
    ...prev,
    { id, role: "thinking", title: "Agent 思考中", content: "", streaming: true },
  ]);
}

function finalizeThinking(
  thinkingIdRef: RefObject<string | null>,
  setEntries: Dispatch<SetStateAction<AgentEntry[]>>
) {
  const thinkingId = thinkingIdRef.current;
  thinkingIdRef.current = null;
  if (!thinkingId) return;
  setEntries((prev) => {
    const target = prev.find((e) => e.id === thinkingId);
    if (!target) return prev;
    if (!target.content || !target.content.trim()) {
      return prev.filter((e) => e.id !== thinkingId);
    }
    return prev.map((e) => (e.id === thinkingId ? { ...e, streaming: false } : e));
  });
}

function settleActiveEntries(
  setEntries: Dispatch<SetStateAction<AgentEntry[]>>,
  _toolStatus: "success" | "error"
) {
  setEntries((prev) =>
    prev
      .filter((entry) => {
        if (!entry.streaming) return true;
        if (entry.role !== "agent" && entry.role !== "thinking") return true;
        return Boolean(entry.content?.trim());
      })
      .map((entry) => {
        if (entry.streaming) {
          return { ...entry, streaming: false };
        }
        return entry;
      })
  );
}

function makeRunStatus(label: string, detail?: string): AgentRunStatus {
  const now = Date.now();
  return { label, detail, startedAt: now, updatedAt: now };
}

function updateRunStatus(
  setRunStatus: Dispatch<SetStateAction<AgentRunStatus | null>>,
  label: string,
  detail?: string
) {
  const now = Date.now();
  setRunStatus((prev) => ({
    label,
    detail,
    startedAt: prev?.startedAt ?? now,
    updatedAt: now,
  }));
}

function AgentRunStatusView({
  status,
  elapsedSeconds,
}: {
  status: AgentRunStatus | null;
  elapsedSeconds: number;
}) {
  const label = status?.label ?? "Agent 工作中";
  const detail = status?.detail ?? (elapsedSeconds >= 10 ? "正在等待 Agent 输出" : undefined);

  return (
    <div className="rounded-md border border-border bg-cream px-2.5 py-2 text-xs text-text-secondary">
      <div className="flex items-center gap-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="font-mono tabular-nums text-[11px] text-text-secondary/70">
          {formatElapsed(elapsedSeconds)}
        </span>
      </div>
      {detail && <div className="mt-1 pl-5 text-[11px] text-text-secondary/80">{detail}</div>}
    </div>
  );
}

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = String(seconds % 60).padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

const AgentEntryView = memo(function AgentEntryView({ entry }: { entry: AgentEntry }) {
  if (entry.role === "user") {
    return (
      <div className="flex justify-end py-1">
        <div className="max-w-[86%] rounded-lg rounded-tr-sm bg-primary px-3 py-2 text-sm leading-relaxed text-white shadow-sm">
          <CollapsibleContent
            content={entry.content ?? ""}
            maxChars={900}
            maxLines={12}
            previewClassName="whitespace-pre-wrap break-words"
            buttonClassName="mt-2 border-white/25 bg-white/10 text-white/85 hover:border-white/40 hover:text-white"
          />
        </div>
      </div>
    );
  }

  if (entry.role === "thinking") {
    return <ThinkingEntryView entry={entry} />;
  }

  const Icon =
    entry.role === "error"
      ? AlertTriangle
      : entry.status === "success"
        ? CheckCircle2
        : entry.role === "system"
          ? Terminal
          : Bot;

  const tone =
    entry.role === "error"
      ? "text-error bg-red-50 border-red-100"
      : entry.status === "success"
        ? "text-primary bg-primary-light border-primary/15"
        : "text-text-secondary bg-cream border-border";

  const contentClass = `rounded-md border px-2.5 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words ${tone}`;

  return (
    <div className="flex gap-2.5 py-1.5">
      <div className={`mt-0.5 w-6 h-6 rounded-md border flex items-center justify-center flex-shrink-0 ${tone}`}>
        <Icon className="w-3.5 h-3.5" />
      </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] font-medium text-text-secondary">
            <span className="truncate">{entry.title}</span>
            {entry.streaming && <Loader2 className="w-3 h-3 animate-spin text-primary" />}
          </div>
        {"images" in entry && <ImageAttachments images={entry.images ?? []} className="mt-1" />}
        {entry.role === "agent" && (entry.content || entry.streaming) && (
          <AgentMarkdown content={entry.content ?? ""} />
        )}
        {entry.content && entry.role !== "agent" && (
          <div className={`mt-1 font-sans ${contentClass}`}>
            <CollapsibleContent
              content={entry.content}
              maxChars={1100}
              maxLines={16}
              previewClassName="whitespace-pre-wrap break-words"
            />
          </div>
        )}
      </div>
    </div>
  );
});

function ThinkingEntryView({ entry }: { entry: AgentEntry }) {
  const [open, setOpen] = useState(true);
  const content = entry.content ?? "";

  return (
    <div className="flex gap-2.5 py-1.5">
      <div className="mt-0.5 w-6 h-6 rounded-md border border-border bg-cream flex items-center justify-center flex-shrink-0 text-text-secondary">
        <Brain className="w-3.5 h-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] font-medium text-text-secondary cursor-pointer hover:text-text-primary"
        >
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <span className="truncate">{entry.title}</span>
          {entry.streaming && <Loader2 className="w-3 h-3 animate-spin text-primary" />}
        </button>
        {open && content && (
          <div className="mt-1 rounded-md border border-border bg-cream px-2.5 py-2 text-[11px] leading-relaxed font-sans text-text-secondary/90 italic">
            <CollapsibleContent
              content={content}
              maxChars={900}
              maxLines={12}
              previewClassName="whitespace-pre-wrap break-words"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function AgentMarkdown({ content }: { content: string }) {
  return (
    <div className="mt-1 min-w-0 rounded-lg border border-border bg-cream px-3 py-2 text-sm leading-relaxed text-text-primary shadow-sm overflow-hidden">
      <CollapsibleContent
        content={content}
        maxChars={1200}
        maxLines={18}
        previewClassName="whitespace-pre-wrap break-words"
        renderContent={(value) => (
          <MarkdownContent
            content={value}
            className="prose prose-sm max-w-full text-text-primary [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_code]:rounded [&_code]:bg-cream-dark [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:text-xs [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-cream-dark [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1"
          />
        )}
      />
    </div>
  );
}
