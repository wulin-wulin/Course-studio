import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  BookPlus,
  Bot,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Database,
  History,
  ImagePlus,
  Loader2,
  MessageCircle,
  PanelRightClose,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Terminal,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import type { ChatMode } from "@/stores/chatStore";
import { getBackendWsUrl } from "@/utils/backendWs";
import { useCourseGenerationStore } from "@/course/generation/generationStore";
import { CollapsibleContent } from "./CollapsibleContent";
import { ImageAttachments } from "./ImageAttachments";
import { MarkdownContent } from "./MarkdownContent";
import { ModelControls } from "./ModelControls";

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
type AgentWorkflow = "default" | "course-create";

type AgentQuestionOption = {
  label: string;
  description: string;
};

type AgentQuestionItem = {
  header: string;
  question: string;
  options: AgentQuestionOption[];
  multiple: boolean;
  custom: boolean;
};

type AgentQuestionRequest = {
  requestId: string;
  conversationId: string;
  questions: AgentQuestionItem[];
};

type ConversationSummary = {
  id: string;
  title: string;
  mode: ChatMode;
  workflow: AgentWorkflow;
  model: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  preview: string;
};

type ConversationDetail = Omit<ConversationSummary, "message_count" | "preview"> & {
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system" | "error";
    content: string;
    images: string[];
    created_at: string;
  }>;
};

type CourseDeletionCandidate = {
  id: string;
  title: string;
  description?: string;
  clusters?: number;
  points?: number;
  invalid: boolean;
};

type HandlerCtx = {
  setEntries: Dispatch<SetStateAction<AgentEntry[]>>;
  setIsRunning: Dispatch<SetStateAction<boolean>>;
  setRunStatus: Dispatch<SetStateAction<AgentRunStatus | null>>;
  streamingIdRef: RefObject<string | null>;
  thinkingIdRef: RefObject<string | null>;
  modeRef: RefObject<ChatMode>;
  workflowRef: RefObject<AgentWorkflow>;
  setPendingQuestion: Dispatch<SetStateAction<AgentQuestionRequest | null>>;
};

type AgentPanelProps = {
  onCollapse?: () => void;
};

const MODE_COPY: Record<
  ChatMode,
  {
    shortLabel: string;
    description: string;
    bannerClass: string;
    emptyTitle: string;
    emptyDescription: string;
    placeholder: string;
  }
> = {
  chat: {
    shortLabel: "只读问答",
    description: "Chat 只读取课程数据，用于查询、解释和学习建议，不会提交任何内容修改。",
    bannerClass: "border-primary/15 bg-primary-light/70 text-primary",
    emptyTitle: "和课程知识对话",
    emptyDescription: "询问课程结构、知识点内容或学习路径。当前模式不会改动课程数据。",
    placeholder: "询问课程内容、概念或学习建议…",
  },
  agent: {
    shortLabel: "课程编辑",
    description: "Agent 可以修改课程 JSON；完成后仍需通过后端结构校验与冲突检查。",
    bannerClass: "border-amber-200 bg-amber-50 text-amber-800",
    emptyTitle: "向 Agent 描述修改需求",
    emptyDescription: "创建课程、补充知识点或调整已有内容。执行过程和提交结果会显示在这里。",
    placeholder: "描述希望 Agent 对课程内容做出的修改…",
  },
};

const CHAT_SUGGESTIONS = [
  "介绍一下当前课程的整体知识结构",
  "我应该按照什么顺序学习这门课程？",
  "解释一个知识点，并说明它的前置知识",
];

const AGENT_SUGGESTIONS = [
  "检查当前课程是否有内容不完整的知识点",
  "为指定知识点补充核心思想和应用场景",
  "调整一个知识点的摘要并保持索引同步",
];

export function AgentPanel({ onCollapse }: AgentPanelProps) {
  const requestGenerationDemo = useCourseGenerationStore((state) => state.requestDemo);
  const generationStatus = useCourseGenerationStore((state) => state.status);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const setModel = useChatStore((s) => s.setModel);
  const mode = useChatStore((s) => s.mode);
  const setMode = useChatStore((s) => s.setMode);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const createConversation = useChatStore((s) => s.createConversation);
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const [entries, setEntries] = useState<AgentEntry[]>([]);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [runStatus, setRunStatus] = useState<AgentRunStatus | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [workflow, setWorkflow] = useState<AgentWorkflow>("default");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState<AgentQuestionRequest | null>(null);
  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  const [questionError, setQuestionError] = useState("");
  const [modeInfoOpen, setModeInfoOpen] = useState(false);
  const [courseDeleteOpen, setCourseDeleteOpen] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const wsUrlRef = useRef(getBackendWsUrl("/api/agent/ws"));
  const lastActiveConversationIdRef = useRef<string | null>(activeConversationId);
  const modeRef = useRef<ChatMode>(mode);
  const workflowRef = useRef<AgentWorkflow>("default");
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
        // Re-fetch the catalog after backend restarts or a missed commit event.
        // The initial connection may cause one harmless duplicate no-store
        // request, while reconnects make externally completed publications
        // visible without requiring a full page refresh.
        window.dispatchEvent(new CustomEvent("course-data-changed", {
          detail: { source: "agent-websocket-connected" },
        }));
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
            modeRef,
            workflowRef,
            setPendingQuestion,
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
        setPendingQuestion(null);
        setQuestionSubmitting(false);
        setQuestionError("");
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
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    setQuestionError("");
    setQuestionSubmitting(false);
  }, [pendingQuestion?.requestId]);

  useEffect(() => {
    if (!activeConversationId || activeConversationId === lastActiveConversationIdRef.current) return;
    lastActiveConversationIdRef.current = activeConversationId;
    setEntries([]);
    setIsRunning(false);
    setRunStatus(null);
    setPendingQuestion(null);
    setQuestionSubmitting(false);
    setQuestionError("");
    setWorkflow("default");
    workflowRef.current = "default";
    streamingIdRef.current = null;
    thinkingIdRef.current = null;
    stickToBottomRef.current = true;
  }, [activeConversationId]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [entries, isRunning, pendingQuestion, runStatus]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= 24;
  }, []);

  const resetConversationView = useCallback(() => {
    setEntries([]);
    setInput("");
    setImages([]);
    setIsRunning(false);
    setRunStatus(null);
    setPendingQuestion(null);
    setQuestionSubmitting(false);
    setQuestionError("");
    setWorkflow("default");
    workflowRef.current = "default";
    streamingIdRef.current = null;
    thinkingIdRef.current = null;
    stickToBottomRef.current = true;
  }, []);

  const loadConversationHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const response = await fetch("/api/conversations", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { conversations?: ConversationSummary[] };
      setConversations(Array.isArray(data.conversations) ? data.conversations : []);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "加载历史对话失败");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (historyOpen) void loadConversationHistory();
  }, [historyOpen, loadConversationHistory]);

  const openHistoricalConversation = useCallback(async (conversationId: string) => {
    if (isRunning) return;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const conversation = await response.json() as ConversationDetail;
      const restoredMode: ChatMode = conversation.mode === "chat" ? "chat" : "agent";
      const restoredWorkflow: AgentWorkflow = conversation.workflow === "course-create"
        ? "course-create"
        : "default";

      lastActiveConversationIdRef.current = conversation.id;
      setActiveConversation(conversation.id);
      setMode(restoredMode);
      modeRef.current = restoredMode;
      setWorkflow(restoredWorkflow);
      workflowRef.current = restoredWorkflow;
      if (conversation.model) setModel(conversation.model);
      setInput("");
      setImages([]);
      setRunStatus(null);
      setPendingQuestion(null);
      setQuestionSubmitting(false);
      setQuestionError("");
      setEntries(conversation.messages.map((message) => ({
        id: message.id,
        role: message.role === "assistant" ? "agent" : message.role,
        title: message.role === "user"
          ? "你"
          : message.role === "assistant"
            ? "课程助手"
            : message.role === "error"
              ? "错误"
              : "系统",
        content: message.content,
        images: message.images.length ? message.images : undefined,
        status: message.role === "error" ? "error" : "success",
      })));
      stickToBottomRef.current = true;
      setHistoryOpen(false);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "恢复历史对话失败");
    } finally {
      setHistoryLoading(false);
    }
  }, [isRunning, setActiveConversation, setMode, setModel]);

  const deleteHistoricalConversation = useCallback(async (
    event: React.MouseEvent,
    conversation: ConversationSummary
  ) => {
    event.stopPropagation();
    if (isRunning || !window.confirm(`删除历史对话“${conversation.title}”？`)) return;
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversation.id)}`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
      setConversations((prev) => prev.filter((item) => item.id !== conversation.id));
      if (activeConversationId === conversation.id) {
        const nextId = createConversation();
        lastActiveConversationIdRef.current = nextId;
        resetConversationView();
      }
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "删除历史对话失败");
    }
  }, [activeConversationId, createConversation, isRunning, resetConversationView]);

  const startNewConversation = useCallback(() => {
    if (isRunning) return;
    const conversationId = createConversation();
    lastActiveConversationIdRef.current = conversationId;
    resetConversationView();
  }, [createConversation, isRunning, resetConversationView]);

  const switchMode = useCallback((nextMode: ChatMode) => {
    if (nextMode === mode || isRunning) return;
    setMode(nextMode);
    modeRef.current = nextMode;
    const conversationId = createConversation();
    lastActiveConversationIdRef.current = conversationId;
    resetConversationView();
  }, [createConversation, isRunning, mode, resetConversationView, setMode]);

  useEffect(() => {
    if (!isRunning) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  const submitRequest = useCallback((
    conversationId: string,
    message: string,
    requestImages: string[],
    requestWorkflow: AgentWorkflow,
    displayContent?: string,
    replaceEntries = false
  ) => {
    streamingIdRef.current = null;
    thinkingIdRef.current = null;
    stickToBottomRef.current = true;
    const entry: AgentEntry = {
      id: crypto.randomUUID(),
      role: "user",
      title: "你",
      content: displayContent ?? (message || (requestImages.length > 0 ? `已发送 ${requestImages.length} 张图片` : "")),
      images: requestImages.length > 0 ? [...requestImages] : undefined,
    };
    setEntries((prev) => replaceEntries ? [entry] : [...prev, entry]);
    setIsRunning(true);
    setRunStatus(
      mode === "chat"
        ? makeRunStatus("正在思考", "正在只读检索课程信息")
        : requestWorkflow === "course-create"
          ? makeRunStatus("正在启动课程创建流程", "正在加载课程创建 Skill")
          : makeRunStatus("Agent 启动中", "正在准备课程数据工作区")
    );
    wsRef.current?.send(
      JSON.stringify({
        type: "agent_request",
        payload: {
          conversation_id: conversationId,
          request_id: entry.id,
          message,
          images: requestImages,
          model: selectedModel,
          mode,
          workflow: requestWorkflow,
        },
      })
    );
  }, [mode, selectedModel]);

  const send = useCallback(() => {
    const message = input.trim();
    if ((!message && images.length === 0) || isRunning || wsRef.current?.readyState !== WebSocket.OPEN) return;

    let conversationId = activeConversationId;
    if (!conversationId) {
      conversationId = createConversation();
      lastActiveConversationIdRef.current = conversationId;
    }

    submitRequest(conversationId, message, images, workflow);
    setInput("");
    setImages([]);
  }, [activeConversationId, createConversation, images, input, isRunning, submitRequest, workflow]);

  const startCourseCreation = useCallback(() => {
    if (mode !== "agent" || isRunning || workflow === "course-create" || wsRef.current?.readyState !== WebSocket.OPEN) return;
    const conversationId = createConversation();
    lastActiveConversationIdRef.current = conversationId;
    resetConversationView();
    setWorkflow("course-create");
    workflowRef.current = "course-create";
    submitRequest(
      conversationId,
      "开始创建课程。如果我还没有提供课程或领域名称，请先询问我。",
      [],
      "course-create",
      "创建课程",
      true
    );
  }, [createConversation, isRunning, mode, resetConversationView, submitRequest, workflow]);

  const openCourseDeletion = useCallback(() => {
    if (mode !== "agent" || isRunning || workflow === "course-create") return;
    setHistoryOpen(false);
    setModeInfoOpen(false);
    setCourseDeleteOpen(true);
  }, [isRunning, mode, workflow]);

  const closeCourseDeletion = useCallback(() => {
    setCourseDeleteOpen(false);
  }, []);

  const submitQuestionAnswers = useCallback(async (answers: string[][]) => {
    const question = pendingQuestion;
    if (!question || questionSubmitting) return;
    setQuestionSubmitting(true);
    setQuestionError("");
    try {
      const response = await fetch(
        `/api/agent/questions/${encodeURIComponent(question.requestId)}/reply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: question.conversationId,
            answers,
          }),
        }
      );
      const payload = await response.json().catch(() => ({})) as { content?: string; detail?: string };
      if (!response.ok) throw new Error(payload.detail || `提交失败（${response.status}）`);
      const content = payload.content || formatQuestionAnswers(question.questions, answers);
      setEntries((current) => [
        ...current,
        {
          id: `question-reply:${question.requestId}`,
          role: "user",
          title: "你",
          content,
          status: "success",
        },
      ]);
      setPendingQuestion(null);
      updateRunStatus(setRunStatus, "已收到确认", "课程创建流程继续执行");
      stickToBottomRef.current = true;
    } catch (error) {
      setQuestionError(error instanceof Error ? error.message : "提交确认失败");
    } finally {
      setQuestionSubmitting(false);
    }
  }, [pendingQuestion, questionSubmitting]);

  const rejectQuestion = useCallback(async () => {
    const question = pendingQuestion;
    if (!question || questionSubmitting) return;
    setQuestionSubmitting(true);
    setQuestionError("");
    try {
      const response = await fetch(
        `/api/agent/questions/${encodeURIComponent(question.requestId)}/reject`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversation_id: question.conversationId }),
        }
      );
      const payload = await response.json().catch(() => ({})) as { content?: string; detail?: string };
      if (!response.ok) throw new Error(payload.detail || `取消失败（${response.status}）`);
      setEntries((current) => [
        ...current,
        {
          id: `question-reject:${question.requestId}`,
          role: "user",
          title: "你",
          content: payload.content || "暂不回答当前确认问题",
        },
      ]);
      setPendingQuestion(null);
      stickToBottomRef.current = true;
    } catch (error) {
      setQuestionError(error instanceof Error ? error.message : "取消确认失败");
    } finally {
      setQuestionSubmitting(false);
    }
  }, [pendingQuestion, questionSubmitting]);

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
  const modeCopy = MODE_COPY[mode];
  const suggestions = mode === "chat" ? CHAT_SUGGESTIONS : AGENT_SUGGESTIONS;
  const inputPlaceholder = workflow === "course-create"
    ? "回答课程创建流程的问题…"
    : modeCopy.placeholder;

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-surface text-text-primary">
      <div className="flex items-center justify-between border-b border-border bg-surface px-3.5 py-2.5">
        <div className="min-w-0 flex items-center gap-2">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary text-white shadow-sm">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">课程助手</div>
            <div className="truncate text-[11px] text-text-secondary">OpenCode · {modeCopy.shortLabel}</div>
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
          <button
            type="button"
            onClick={() => setHistoryOpen((value) => !value)}
            disabled={isRunning}
            aria-label="历史对话"
            title="历史对话"
            className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              historyOpen
                ? "bg-primary-light text-primary"
                : "text-text-secondary hover:bg-cream-dark hover:text-text-primary"
            }`}
          >
            <History className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={startNewConversation}
            disabled={isRunning}
            aria-label="新建对话"
            title="新建对话"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-cream-dark hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SquarePen className="h-4 w-4" />
          </button>
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

      {historyOpen && (
        <div className="absolute inset-x-0 bottom-0 top-[53px] z-30 flex flex-col bg-surface">
          <div className="flex items-center justify-between border-b border-border bg-cream/45 px-3.5 py-3">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">历史对话</h3>
              <p className="mt-0.5 text-[11px] text-text-secondary">保存在本机后端，不依赖账号登录</p>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void loadConversationHistory()}
                disabled={historyLoading}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-cream-dark hover:text-text-primary disabled:opacity-40"
                title="刷新"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${historyLoading ? "animate-spin" : ""}`} />
              </button>
              <button
                type="button"
                onClick={() => setHistoryOpen(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-cream-dark hover:text-text-primary"
                title="关闭"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {historyError && (
              <div className="mb-3 rounded-lg border border-error/20 bg-error/5 px-3 py-2 text-xs text-error">
                {historyError}
              </div>
            )}
            {historyLoading && conversations.length === 0 ? (
              <div className="flex h-36 items-center justify-center gap-2 text-xs text-text-secondary">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在加载历史对话
              </div>
            ) : conversations.length === 0 ? (
              <div className="flex h-48 flex-col items-center justify-center text-center text-text-secondary">
                <History className="mb-2 h-6 w-6 opacity-50" />
                <p className="text-xs font-medium text-text-primary">还没有历史对话</p>
                <p className="mt-1 text-[11px]">发送第一条消息后会自动保存</p>
              </div>
            ) : (
              <div className="space-y-2">
                {conversations.map((conversation) => (
                  <div
                    role="button"
                    tabIndex={0}
                    key={conversation.id}
                    onClick={() => void openHistoricalConversation(conversation.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        void openHistoricalConversation(conversation.id);
                      }
                    }}
                    className={`group w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${
                      activeConversationId === conversation.id
                        ? "border-primary/30 bg-primary-light/70"
                        : "border-border bg-cream/45 hover:border-primary/20 hover:bg-cream"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-xs font-semibold text-text-primary">
                            {conversation.title}
                          </span>
                          {conversation.workflow === "course-create" && (
                            <span className="shrink-0 rounded bg-primary-light px-1.5 py-0.5 text-[9px] font-medium text-primary">
                              创建课程
                            </span>
                          )}
                        </div>
                        <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-text-secondary">
                          {conversation.preview || "暂无消息摘要"}
                        </p>
                        <div className="mt-2 flex items-center gap-2 text-[10px] text-text-secondary/80">
                          <span>{conversation.mode === "chat" ? "Chat" : "Agent"}</span>
                          <span>·</span>
                          <span>{conversation.message_count} 条消息</span>
                          <span>·</span>
                          <span>{formatConversationTime(conversation.updated_at)}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(event) => void deleteHistoricalConversation(event, conversation)}
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary opacity-0 transition-all hover:bg-error/10 hover:text-error group-hover:opacity-100 focus:opacity-100"
                        title="删除历史对话"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {courseDeleteOpen && <CourseDeleteDialog onClose={closeCourseDeletion} />}

      <div className="border-b border-border bg-cream/45 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid w-[142px] shrink-0 grid-cols-2 rounded-lg border border-border bg-surface p-0.5 shadow-sm">
            <ModeButton
              active={mode === "chat"}
              disabled={isRunning}
              icon={MessageCircle}
              label="Chat"
              onClick={() => switchMode("chat")}
            />
            <ModeButton
              active={mode === "agent"}
              disabled={isRunning}
              icon={WandSparkles}
              label="Agent"
              onClick={() => switchMode("agent")}
            />
          </div>
          <div className="min-w-0 flex-1">
            <ModelControls
              selectedModel={selectedModel}
              onSelectModel={setModel}
              disabled={isRunning}
              compact
            />
          </div>
          <button
            type="button"
            onClick={() => setModeInfoOpen((current) => !current)}
            aria-expanded={modeInfoOpen}
            title="查看当前模式说明"
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors ${
              modeInfoOpen
                ? "border-primary/25 bg-primary-light text-primary"
                : "border-border bg-surface text-text-secondary hover:border-primary/30 hover:text-primary"
            }`}
          >
            <CircleHelp className="h-3.5 w-3.5" />
          </button>
        </div>
        {modeInfoOpen && (
          <div className={`mt-2 flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px] leading-relaxed ${modeCopy.bannerClass}`}>
            {mode === "chat" ? <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Database className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <span>{modeCopy.description}</span>
          </div>
        )}
      </div>

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 space-y-2 overflow-y-auto bg-surface px-3.5 py-4"
      >
        {entries.length === 0 && (
          <div className="flex h-full flex-col justify-center px-3 text-center text-text-secondary">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl border border-primary/15 bg-primary-light text-primary">
              {mode === "chat" ? <MessageCircle className="h-5 w-5" /> : <WandSparkles className="h-5 w-5" />}
            </div>
            <h3 className="mb-1 text-sm font-semibold text-text-primary">{modeCopy.emptyTitle}</h3>
            <p className="mx-auto max-w-xs text-xs leading-relaxed">{modeCopy.emptyDescription}</p>
            <div className="mx-auto mt-4 grid w-full max-w-sm gap-2">
              {suggestions.map((suggestion) => (
                <button
                  type="button"
                  key={suggestion}
                  onClick={() => setInput(suggestion)}
                  className="rounded-xl border border-border bg-cream/55 px-3 py-2.5 text-left text-xs text-text-secondary transition-colors hover:border-primary/25 hover:bg-primary-light hover:text-text-primary"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {entries.map((entry) => (
          <AgentEntryView key={entry.id} entry={entry} />
        ))}

        {isRunning && (
          <AgentRunStatusView status={runStatus} elapsedSeconds={elapsedSeconds} mode={mode} />
        )}
      </div>

      <div className="border-t border-border bg-surface p-3">
        {pendingQuestion ? (
          <AgentQuestionCard
            request={pendingQuestion}
            submitting={questionSubmitting}
            error={questionError}
            onSubmit={submitQuestionAnswers}
            onReject={rejectQuestion}
          />
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border bg-cream/55 shadow-sm transition-colors focus-within:border-primary/45 focus-within:bg-surface focus-within:shadow-md">
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
          <div className="flex items-end gap-2 px-3 py-2.5">
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
              placeholder={inputPlaceholder}
              rows={2}
              className="max-h-40 min-h-14 flex-1 resize-none bg-transparent px-0 py-1.5 text-sm leading-relaxed text-text-primary outline-none placeholder:text-text-secondary/60"
            />
            <button
              onClick={send}
              disabled={!isConnected || isRunning || (!input.trim() && images.length === 0)}
              className="mb-0.5 flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
              title="发送"
            >
              {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
          <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
            <div className="flex min-w-0 items-center gap-2">
              {mode === "agent" && (
                <>
                  <button
                    type="button"
                    onClick={startCourseCreation}
                    disabled={!isConnected || isRunning || workflow === "course-create"}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-primary/20 bg-primary-light px-2 py-1 text-[11px] font-semibold text-primary transition-colors hover:border-primary/35 hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
                    title={workflow === "course-create" ? "当前对话正在创建课程" : "按照引导创建一门新课程"}
                  >
                    <BookPlus className="h-3.5 w-3.5" />
                    创建课程
                  </button>
                  <button
                    type="button"
                    onClick={requestGenerationDemo}
                    disabled={isRunning || generationStatus !== "idle"}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-700 transition-colors hover:border-amber-300 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                    title={
                      generationStatus === "idle"
                        ? "使用预定义数据播放课程生成过程"
                        : "生成演示正在左侧播放"
                    }
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    生成演示
                  </button>
                  <button
                    type="button"
                    onClick={openCourseDeletion}
                    disabled={isRunning || workflow === "course-create"}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-error/20 bg-error/5 px-2 py-1 text-[11px] font-semibold text-error transition-colors hover:border-error/35 hover:bg-error/10 disabled:cursor-not-allowed disabled:opacity-50"
                    title={workflow === "course-create" ? "课程创建期间不能删除课程" : "选择并删除一门课程"}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    删除课程
                  </button>
                </>
              )}
              <span className="truncate text-[11px] text-text-secondary">
                {workflow === "course-create" ? "课程创建流程进行中" : "Enter 发送 · Shift+Enter 换行"}
              </span>
            </div>
            <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${mode === "chat" ? "bg-primary-light text-primary" : "bg-amber-100 text-amber-700"}`}>
              {mode === "chat" ? "只读" : "可修改数据"}
            </span>
          </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CourseDeleteDialog({ onClose }: { onClose: () => void }) {
  const [courses, setCourses] = useState<CourseDeletionCandidate[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [deletedCourse, setDeletedCourse] = useState<CourseDeletionCandidate | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState("");

  const loadCourses = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    setError("");
    try {
      const response = await fetch("/api/courses", { cache: "no-store", signal });
      if (!response.ok) throw new Error(`课程列表请求失败（${response.status}）`);
      const payload: unknown = await response.json();
      const nextCourses = parseCourseDeletionCandidates(payload);
      if (!nextCourses) throw new Error("课程列表格式无效");
      setCourses(nextCourses);
      setSelectedCourseId((current) => nextCourses.some((course) => course.id === current) ? current : null);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "课程列表加载失败");
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadCourses(controller.signal);
    return () => controller.abort();
  }, [loadCourses]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isDeleting) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isDeleting, onClose]);

  const selectedCourse = courses.find((course) => course.id === selectedCourseId) ?? null;

  const deleteSelectedCourse = useCallback(async () => {
    if (!selectedCourse || isDeleting) return;
    setIsDeleting(true);
    setError("");
    try {
      const response = await fetch(`/api/courses/${encodeURIComponent(selectedCourse.id)}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => null) as { detail?: unknown } | null;
      if (!response.ok && response.status !== 404) {
        const detail = typeof payload?.detail === "string" ? payload.detail : `删除失败（${response.status}）`;
        throw new Error(detail);
      }

      setCourses((current) => current.filter((course) => course.id !== selectedCourse.id));
      setSelectedCourseId(null);
      setDeletedCourse(selectedCourse);
      window.dispatchEvent(new CustomEvent("course-data-changed", {
        detail: {
          course_id: selectedCourse.id,
          deleted: true,
          changed_paths: ["course.json", "index.json", "points/", "animations/"],
        },
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除课程失败");
    } finally {
      setIsDeleting(false);
    }
  }, [isDeleting, selectedCourse]);

  return (
    <div className="absolute inset-0 z-50 flex items-end bg-black/20 p-3 backdrop-blur-[1px] sm:items-center" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="course-delete-title"
        className="mx-auto flex max-h-[min(78vh,660px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border bg-cream/55 px-4 py-3.5">
          <div className="flex min-w-0 items-start gap-2.5">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-error/10 text-error">
              <Trash2 className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 id="course-delete-title" className="text-sm font-semibold text-text-primary">删除课程</h2>
              <p className="mt-0.5 text-[11px] leading-relaxed text-text-secondary">先选择课程，再进行最终确认</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isDeleting}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-cream-dark hover:text-text-primary disabled:opacity-40"
            aria-label="关闭删除课程窗口"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {deletedCourse ? (
            <div className="flex min-h-52 flex-col items-center justify-center text-center">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-primary-light text-primary">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <h3 className="mt-3 text-sm font-semibold text-text-primary">课程已删除</h3>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-text-secondary">
                “{deletedCourse.title}”已从课程数据和课程导览中移除。
              </p>
              <button
                type="button"
                onClick={onClose}
                className="mt-5 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-primary-hover"
              >
                完成
              </button>
            </div>
          ) : isLoading ? (
            <div className="flex min-h-52 items-center justify-center gap-2 text-xs text-text-secondary" role="status">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              正在加载课程列表
            </div>
          ) : courses.length === 0 && !error ? (
            <div className="flex min-h-52 flex-col items-center justify-center text-center text-text-secondary">
              <Database className="h-7 w-7 opacity-50" />
              <h3 className="mt-3 text-sm font-semibold text-text-primary">没有可删除的课程</h3>
              <p className="mt-1 text-xs">创建课程后，它会显示在这里。</p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="mb-3 flex items-start gap-2 rounded-xl border border-warning/25 bg-warning/10 px-3 py-2.5 text-[11px] leading-relaxed text-text-secondary">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span>删除会移除课程元数据、知识点、地图布局和动画资源，当前界面不提供撤销。</span>
              </div>
              {courses.map((course) => {
                const selected = course.id === selectedCourseId;
                return (
                  <button
                    type="button"
                    key={course.id}
                    onClick={() => setSelectedCourseId(course.id)}
                    aria-pressed={selected}
                    className={`w-full rounded-xl border px-3 py-3 text-left transition-all ${
                      selected
                        ? "border-error/45 bg-error/5 shadow-sm"
                        : "border-border bg-cream/45 hover:border-error/25 hover:bg-cream"
                    }`}
                  >
                    <span className="flex items-start gap-2.5">
                      <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
                        selected ? "border-error bg-error text-white" : "border-border bg-surface"
                      }`}>
                        {selected && <CheckCircle2 className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-xs font-semibold text-text-primary">{course.title}</span>
                          {course.invalid && (
                            <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-[9px] font-medium text-warning">数据无效</span>
                          )}
                        </span>
                        <span className="mt-1 block truncate font-mono text-[10px] text-text-secondary">{course.id}</span>
                        <span className="mt-1.5 block text-[10px] text-text-secondary">
                          {formatCourseMetric(course.clusters, "知识簇")} · {formatCourseMetric(course.points, "知识点")}
                        </span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {error && !deletedCourse && (
            <div className="mt-3 rounded-xl border border-error/20 bg-error/5 px-3 py-2.5 text-xs text-error" role="alert">
              <div>{error}</div>
              {!selectedCourse && (
                <button type="button" onClick={() => void loadCourses()} className="mt-2 inline-flex items-center gap-1 font-semibold hover:underline">
                  <RefreshCw className="h-3 w-3" />
                  重新加载
                </button>
              )}
            </div>
          )}
        </div>

        {!deletedCourse && !isLoading && courses.length > 0 && (
          <footer className="flex items-center justify-between gap-3 border-t border-border bg-cream/35 px-4 py-3">
            <span className="min-w-0 truncate text-[11px] text-text-secondary">
              {selectedCourse ? `将删除：${selectedCourse.title}` : "请选择要删除的课程"}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={isDeleting}
                className="rounded-lg border border-border bg-surface px-3 py-2 text-xs font-semibold text-text-secondary transition-colors hover:bg-cream disabled:opacity-40"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void deleteSelectedCourse()}
                disabled={!selectedCourse || isDeleting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-error px-3 py-2 text-xs font-semibold text-white transition-colors hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {isDeleting ? "正在删除" : "确认删除"}
              </button>
            </div>
          </footer>
        )}
      </section>
    </div>
  );
}

function parseCourseDeletionCandidates(payload: unknown): CourseDeletionCandidate[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.courses)) return null;
  const courses: CourseDeletionCandidate[] = [];
  for (const item of payload.courses) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) return null;
    courses.push({
      id: item.id,
      title: typeof item.title === "string" && item.title.trim() ? item.title : item.id,
      description: typeof item.description === "string" ? item.description : undefined,
      clusters: toOptionalCount(item.clusters),
      points: toOptionalCount(item.points),
      invalid: item.invalid === true,
    });
  }
  return courses;
}

function toOptionalCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function formatCourseMetric(value: number | undefined, label: string): string {
  return `${typeof value === "number" ? value : "—"} 个${label}`;
}

function AgentQuestionCard({
  request,
  submitting,
  error,
  onSubmit,
  onReject,
}: {
  request: AgentQuestionRequest;
  submitting: boolean;
  error: string;
  onSubmit: (answers: string[][]) => void;
  onReject: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [selections, setSelections] = useState<string[][]>(() => request.questions.map(() => []));
  const [customValues, setCustomValues] = useState<string[]>(() => request.questions.map(() => ""));

  useEffect(() => {
    setActiveIndex(0);
    setSelections(request.questions.map(() => []));
    setCustomValues(request.questions.map(() => ""));
  }, [request]);

  const answers = useMemo(
    () => request.questions.map((_, index) => {
      const custom = customValues[index]?.trim();
      return custom ? [...(selections[index] ?? []), custom] : selections[index] ?? [];
    }),
    [customValues, request.questions, selections]
  );
  const current = request.questions[activeIndex];
  const currentAnswers = answers[activeIndex] ?? [];
  const allAnswered = answers.every((answer) => answer.length > 0);
  const isLast = activeIndex === request.questions.length - 1;

  if (!current) return null;

  const selectOption = (label: string) => {
    setSelections((existing) => existing.map((values, index) => {
      if (index !== activeIndex) return values;
      if (!current.multiple) return [label];
      return values.includes(label)
        ? values.filter((value) => value !== label)
        : [...values, label];
    }));
    if (!current.multiple) {
      setCustomValues((existing) => existing.map((value, index) => index === activeIndex ? "" : value));
    }
  };

  const updateCustomValue = (value: string) => {
    setCustomValues((existing) => existing.map((currentValue, index) => index === activeIndex ? value : currentValue));
    if (!current.multiple && value) {
      setSelections((existing) => existing.map((values, index) => index === activeIndex ? [] : values));
    }
  };

  return (
    <section
      aria-live="polite"
      className="max-h-[min(58vh,560px)] overflow-y-auto rounded-2xl border border-primary/25 bg-gradient-to-b from-primary-light/80 to-surface shadow-md"
    >
      <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-primary/15 bg-primary-light/95 px-3.5 py-3 backdrop-blur-sm">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary text-white shadow-sm">
            <CircleHelp className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-primary">需要你的确认</div>
            <div className="mt-0.5 truncate text-[11px] text-text-secondary">
              {current.header}
              {request.questions.length > 1 && ` · ${activeIndex + 1}/${request.questions.length}`}
            </div>
          </div>
        </div>
        <span className="shrink-0 rounded-md border border-primary/15 bg-surface/75 px-1.5 py-0.5 text-[10px] font-medium text-primary">
          不会被折叠
        </span>
      </div>

      <div className="space-y-3 p-3.5">
        <p className="text-sm font-medium leading-relaxed text-text-primary">{current.question}</p>
        {current.multiple && (
          <p className="text-[11px] text-text-secondary">可以选择多个选项</p>
        )}

        <div className="grid gap-2">
          {current.options.map((option) => {
            const selected = (selections[activeIndex] ?? []).includes(option.label);
            return (
              <button
                type="button"
                key={option.label}
                onClick={() => selectOption(option.label)}
                disabled={submitting}
                aria-pressed={selected}
                className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
                  selected
                    ? "border-primary/45 bg-primary-light text-text-primary shadow-sm"
                    : "border-border bg-surface text-text-primary hover:border-primary/25 hover:bg-cream/55"
                }`}
              >
                <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
                  selected ? "border-primary bg-primary text-white" : "border-border bg-surface"
                }`}>
                  {selected && <CheckCircle2 className="h-3 w-3" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-semibold">{option.label}</span>
                  {option.description && (
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-text-secondary">
                      {option.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {current.custom && (
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-medium text-text-secondary">自定义填写</span>
            <textarea
              value={customValues[activeIndex] ?? ""}
              onChange={(event) => updateCustomValue(event.target.value)}
              disabled={submitting}
              rows={2}
              placeholder="如果上面的选项不合适，可以直接填写…"
              className="max-h-28 min-h-16 w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 text-xs leading-relaxed text-text-primary outline-none transition-colors placeholder:text-text-secondary/60 focus:border-primary/45 disabled:opacity-60"
            />
          </label>
        )}

        {error && (
          <div className="rounded-lg border border-error/20 bg-error/5 px-3 py-2 text-xs text-error">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-border/70 pt-3">
          <button
            type="button"
            onClick={onReject}
            disabled={submitting}
            className="rounded-lg px-2 py-1.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-cream hover:text-text-primary disabled:opacity-50"
          >
            暂不回答
          </button>
          <div className="flex items-center gap-2">
            {activeIndex > 0 && (
              <button
                type="button"
                onClick={() => setActiveIndex((index) => Math.max(0, index - 1))}
                disabled={submitting}
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-surface px-2.5 text-xs font-medium text-text-secondary hover:border-primary/25 hover:text-primary disabled:opacity-50"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                上一个
              </button>
            )}
            {!isLast ? (
              <button
                type="button"
                onClick={() => setActiveIndex((index) => Math.min(request.questions.length - 1, index + 1))}
                disabled={submitting || currentAnswers.length === 0}
                className="inline-flex h-8 items-center gap-1 rounded-lg bg-primary px-3 text-xs font-semibold text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                下一个
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onSubmit(answers)}
                disabled={submitting || !allAnswered}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-white shadow-sm hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                确认选择
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function formatQuestionAnswers(questions: AgentQuestionItem[], answers: string[][]) {
  const details = answers.map((answer, index) => {
    const header = questions[index]?.header || `问题 ${index + 1}`;
    return `${header}：${answer.join("、")}`;
  });
  return `确认选择\n${details.join("\n")}`;
}

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function ModeButton({
  active,
  disabled,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 items-center justify-center gap-2 rounded-lg text-xs font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? "bg-primary text-white shadow-sm"
          : "text-text-secondary hover:bg-cream hover:text-text-primary"
      }`}
      aria-pressed={active}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function handleAgentEvent(
  data: { type: string; payload?: Record<string, unknown> },
  ctx: HandlerCtx
) {
  const {
    setEntries,
    setIsRunning,
    setRunStatus,
    streamingIdRef,
    thinkingIdRef,
    modeRef,
    workflowRef,
    setPendingQuestion,
  } = ctx;
  const payload = data.payload ?? {};
  const currentMode = modeRef.current;
  const isCourseCreation = workflowRef.current === "course-create";

  switch (data.type) {
    case "agent_heartbeat":
      setRunStatus((prev) => (prev ? { ...prev, updatedAt: Date.now() } : prev));
      return;

    case "agent_start":
      updateRunStatus(
        setRunStatus,
        currentMode === "chat" ? "正在思考" : isCourseCreation ? "课程创建中" : "Agent 启动中",
        currentMode === "chat"
          ? "正在只读检索课程信息"
          : isCourseCreation
            ? "正在按照 Skill 工作流推进"
            : "正在准备工作环境"
      );
      return;

    case "agent_status":
      updateRunStatus(setRunStatus, String(payload.label ?? "Agent 工作中"));
      return;

    case "agent_thinking_delta": {
      if (currentMode === "chat") return;
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

    case "agent_question": {
      const requestId = String(payload.request_id ?? "").trim();
      const conversationId = String(payload.conversation_id ?? "").trim();
      const questions = normalizeAgentQuestions(payload.questions);
      if (!requestId || !conversationId || questions.length === 0) return;
      finalizeStreaming(streamingIdRef, setEntries);
      finalizeThinking(thinkingIdRef, setEntries);
      setPendingQuestion({ requestId, conversationId, questions });
      setIsRunning(true);
      updateRunStatus(setRunStatus, "等待你的确认", "选择一个选项或填写自定义答案");
      return;
    }

    case "agent_question_resolved": {
      const requestId = String(payload.request_id ?? "").trim();
      setPendingQuestion((current) => current?.requestId === requestId ? null : current);
      updateRunStatus(setRunStatus, "已收到确认", "课程创建流程继续执行");
      return;
    }

    case "agent_done": {
      finalizeStreaming(streamingIdRef, setEntries);
      finalizeThinking(thinkingIdRef, setEntries);
      settleActiveEntries(setEntries, Number(payload.return_code) === 0 ? "success" : "error");
      setPendingQuestion(null);
      setIsRunning(false);
      setRunStatus(null);
      const code = Number(payload.return_code);
      if (code === 0) return;
      setEntries((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "error",
          title: currentMode === "chat" ? "Chat 异常退出" : "Agent 异常退出",
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
      setPendingQuestion(null);
      const message = String(payload.message ?? payload.content ?? "");
      setIsRunning(false);
      setRunStatus(null);
      setEntries((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "error",
          title: currentMode === "chat" ? "Chat 错误" : "Agent 错误",
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

function normalizeAgentQuestions(value: unknown): AgentQuestionItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!isRecord(item) || typeof item.question !== "string" || !item.question.trim()) return [];
    const options = Array.isArray(item.options)
      ? item.options.flatMap((option) => {
          if (!isRecord(option) || typeof option.label !== "string" || !option.label.trim()) return [];
          return [{
            label: option.label.trim(),
            description: typeof option.description === "string" ? option.description.trim() : "",
          }];
        })
      : [];
    return [{
      header: typeof item.header === "string" && item.header.trim()
        ? item.header.trim()
        : `问题 ${index + 1}`,
      question: item.question.trim(),
      options,
      multiple: item.multiple === true,
      custom: item.custom !== false,
    }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    { id, role: "agent", title: "课程助手", content: "", streaming: true },
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
  mode,
}: {
  status: AgentRunStatus | null;
  elapsedSeconds: number;
  mode: ChatMode;
}) {
  const label = status?.label ?? (mode === "chat" ? "正在思考" : "Agent 工作中");
  const detail = status?.detail ?? (elapsedSeconds >= 10 ? "正在等待模型输出" : undefined);

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
