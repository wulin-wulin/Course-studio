import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { AlertCircle, Loader2, PanelRightOpen } from "lucide-react";
import { TopNav } from "./TopNav";
import { CourseCatalog } from "../course/CourseCatalog";
import { CourseForestViewport } from "../course/CourseForestViewport";
import { CourseReadingPage } from "../course/CourseReadingPage";
import { AgentPanel } from "../chat/AgentPanel";
import type { CourseMeta } from "@/course/forest/types";

type AppRoute =
  | { kind: "catalog" }
  | { kind: "forest"; courseId: string }
  | { kind: "reading"; courseId: string; clusterId: string; pointId: string };

const AGENT_PANEL_WIDTH_KEY = "course-studio:agent-panel-width";
const AGENT_PANEL_MIN_WIDTH = 400;
const AGENT_PANEL_MAX_WIDTH = 880;

function agentPanelBounds(viewportWidth = window.innerWidth) {
  return {
    min: AGENT_PANEL_MIN_WIDTH,
    max: Math.max(AGENT_PANEL_MIN_WIDTH, Math.min(AGENT_PANEL_MAX_WIDTH, Math.floor(viewportWidth * 0.65))),
  };
}

function clampAgentPanelWidth(width: number, viewportWidth = window.innerWidth) {
  const bounds = agentPanelBounds(viewportWidth);
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

function defaultAgentPanelWidth(viewportWidth = window.innerWidth) {
  return clampAgentPanelWidth(Math.min(680, Math.max(520, viewportWidth * 0.4)), viewportWidth);
}

function initialAgentPanelWidth() {
  const stored = Number(window.localStorage.getItem(AGENT_PANEL_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0
    ? clampAgentPanelWidth(stored)
    : defaultAgentPanelWidth();
}

/**
 * A tiny hash router keeps the original project's direct-link / browser-back
 * behaviour without tying the shell to a second routing dependency.
 */
function useCourseRoute(): [AppRoute, (path: string) => void] {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(currentHashPath()));

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(currentHashPath()));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((path: string) => {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    if (currentHashPath() === normalized) {
      setRoute(parseRoute(normalized));
      return;
    }
    window.location.hash = normalized;
  }, []);

  return [route, navigate];
}

export function AppShell() {
  const [route, navigate] = useCourseRoute();
  const [isAgentPanelOpen, setIsAgentPanelOpen] = useState(true);
  const [agentPanelWidth, setAgentPanelWidth] = useState(initialAgentPanelWidth);
  const [isResizingAgentPanel, setIsResizingAgentPanel] = useState(false);

  useEffect(() => {
    window.localStorage.setItem(AGENT_PANEL_WIDTH_KEY, String(agentPanelWidth));
  }, [agentPanelWidth]);

  useEffect(() => {
    const handleResize = () => {
      setAgentPanelWidth((current) => clampAgentPanelWidth(current));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const beginAgentPanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.innerWidth < 1024) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = agentPanelWidth;
    setIsResizingAgentPanel(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setAgentPanelWidth(clampAgentPanelWidth(startWidth + startX - moveEvent.clientX));
    };
    const stopResize = () => {
      setIsResizingAgentPanel(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }, [agentPanelWidth]);

  const resetAgentPanelWidth = useCallback(() => {
    setAgentPanelWidth(defaultAgentPanelWidth());
  }, []);

  const panelStyle = {
    "--agent-panel-width": `${agentPanelWidth}px`,
  } as CSSProperties;

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-cream">
      <TopNav onGoHome={() => navigate("/")} isCatalog={route.kind === "catalog"} />
      <main className="flex-1 min-h-0 flex overflow-hidden max-lg:flex-col">
        <section className="flex-1 min-w-0 min-h-0 relative">
          {route.kind === "catalog" ? (
            <CourseCatalog onOpenCourse={(course) => navigate(`/courses/${encodeURIComponent(course.id)}/forest`)} />
          ) : (
            <CourseWorkspace route={route} navigate={navigate} />
          )}
        </section>
        <aside
          style={panelStyle}
          className={`relative shrink-0 min-h-0 border-l border-border bg-surface max-lg:border-l-0 max-lg:border-t ${
            isResizingAgentPanel ? "" : "transition-[width] duration-200"
          } ${
            isAgentPanelOpen
              ? "w-[var(--agent-panel-width)] min-w-[400px] max-lg:!w-full max-lg:min-w-0 max-lg:min-h-[420px]"
              : "w-12 min-w-12 max-lg:w-full max-lg:min-h-12 max-lg:h-12"
          }`}
        >
          {isAgentPanelOpen && (
            <div
              role="separator"
              aria-label="调整课程助手面板宽度"
              aria-orientation="vertical"
              aria-valuemin={agentPanelBounds().min}
              aria-valuemax={agentPanelBounds().max}
              aria-valuenow={agentPanelWidth}
              title="左右拖动调整宽度，双击恢复默认"
              onPointerDown={beginAgentPanelResize}
              onDoubleClick={resetAgentPanelWidth}
              className={`absolute -left-1.5 top-0 z-40 hidden h-full w-3 cursor-col-resize items-center justify-center lg:flex ${
                isResizingAgentPanel ? "bg-primary/5" : ""
              }`}
            >
              <span className={`h-12 w-1 rounded-full transition-colors ${
                isResizingAgentPanel ? "bg-primary" : "bg-border hover:bg-primary/65"
              }`} />
            </div>
          )}
          <div id="course-agent-panel" className={isAgentPanelOpen ? "h-full" : "hidden"}>
            <AgentPanel onCollapse={() => setIsAgentPanelOpen(false)} />
          </div>

          {!isAgentPanelOpen && (
            <button
              type="button"
              onClick={() => setIsAgentPanelOpen(true)}
              aria-controls="course-agent-panel"
              aria-expanded={false}
              aria-label="展开 OpenCode Agent 面板"
              title="展开 OpenCode Agent 面板"
              className="flex h-full w-full flex-col items-center justify-start gap-2 px-2 py-3 text-text-secondary transition-colors hover:bg-cream hover:text-text-primary max-lg:flex-row max-lg:justify-center"
            >
              <PanelRightOpen className="h-4 w-4" aria-hidden="true" />
              <span className="hidden text-xs font-medium max-lg:inline">展开课程助手</span>
            </button>
          )}
        </aside>
      </main>
    </div>
  );
}

function CourseWorkspace({
  route,
  navigate,
}: {
  route: Exclude<AppRoute, { kind: "catalog" }>;
  navigate: (path: string) => void;
}) {
  const [course, setCourse] = useState<CourseMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setCourse(null);
    setError(null);

    void (async () => {
      try {
        const response = await fetch(`/api/courses/${encodeURIComponent(route.courseId)}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`课程请求失败（${response.status}）`);
        const payload: unknown = await response.json();
        const nextCourse = unwrapCourse(payload);
        if (!nextCourse) throw new Error("课程数据格式无效");
        if (alive) setCourse(nextCourse);
      } catch (reason) {
        if (alive) setError(reason instanceof Error ? reason.message : "课程加载失败");
      }
    })();

    return () => {
      alive = false;
    };
  }, [route.courseId]);

  if (error) {
    return (
      <div className="grid h-full place-items-center bg-cream p-6 text-center text-text-secondary">
        <div className="grid max-w-sm justify-items-center gap-3 rounded-xl border border-border bg-surface p-7 shadow-sm">
          <AlertCircle aria-hidden="true" className="h-6 w-6 text-error" />
          <strong className="text-text-primary">无法打开课程</strong>
          <span className="text-sm">{error}</span>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm text-primary hover:bg-primary-light"
            onClick={() => navigate("/")}
          >
            返回课程导览
          </button>
        </div>
      </div>
    );
  }

  if (!course) {
    return (
      <div className="grid h-full place-items-center bg-cream text-text-secondary" role="status">
        <Loader2 aria-hidden="true" className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const forestPath = `/courses/${encodeURIComponent(course.id)}/forest`;
  const openPoint = (point: { id: string; clusterId: string }) =>
    navigate(`/courses/${encodeURIComponent(course.id)}/points/${encodeURIComponent(point.clusterId)}/${encodeURIComponent(point.id)}`);

  if (route.kind === "reading") {
    return (
      <CourseReadingPage
        course={course}
        pointId={route.pointId}
        routeClusterId={route.clusterId}
        onOpenPoint={openPoint}
        onBackToForest={() => navigate(forestPath)}
        onBackToCatalog={() => navigate("/")}
      />
    );
  }

  return (
    <CourseForestViewport
      course={course}
      onOpenPoint={openPoint}
      onBackToCatalog={() => navigate("/")}
    />
  );
}

function currentHashPath() {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash || hash === "/") return "/";
  return hash.startsWith("/") ? hash : `/${hash}`;
}

function parseRoute(path: string): AppRoute {
  const segments = path.split("/").filter(Boolean).map(decodeSegment);
  if (segments.length === 3 && segments[0] === "courses" && segments[2] === "forest") {
    const courseId = segments[1];
    if (courseId) return { kind: "forest", courseId };
  }
  if (segments.length === 5 && segments[0] === "courses" && segments[2] === "points") {
    const courseId = segments[1];
    const clusterId = segments[3];
    const pointId = segments[4];
    if (courseId && clusterId && pointId) {
      return { kind: "reading", courseId, clusterId, pointId };
    }
  }
  return { kind: "catalog" };
}

function decodeSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unwrapCourse(payload: unknown): CourseMeta | null {
  const candidate = isRecord(payload) && "course" in payload ? payload.course : payload;
  if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.title !== "string") return null;
  return {
    id: candidate.id,
    title: candidate.title,
    subtitle: typeof candidate.subtitle === "string" ? candidate.subtitle : undefined,
    description: typeof candidate.description === "string" ? candidate.description : undefined,
    language: typeof candidate.language === "string" ? candidate.language : undefined,
    revision: typeof candidate.revision === "string" || typeof candidate.revision === "number" ? candidate.revision : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
