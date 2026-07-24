import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Loader2,
  Pause,
  Play,
  Radio,
  RotateCcw,
  SkipForward,
  Sparkles,
  Sprout,
  WifiOff,
  X,
} from "lucide-react";
import type { CourseMeta, ForestIndex } from "@/course/forest/types";
import { DemoReplaySource } from "@/course/generation/DemoReplaySource";
import { buildDemoGenerationTimeline } from "@/course/generation/demoTimeline";
import { GenerationForestCanvas } from "@/course/generation/GenerationForestCanvas";
import { useCourseGenerationStore } from "@/course/generation/generationStore";
import {
  GENERATION_GATES,
  type GenerationActivityState,
  type GenerationGate,
  type GenerationPointState,
} from "@/course/generation/types";
import "./courseGeneration.css";

const DEMO_COURSE_ID = "software-engineering";
const SPEEDS = [1, 2, 4];

const GATE_LABELS: Record<GenerationGate, string> = {
  G0_SCOPE: "范围",
  G1_INDEX: "目录",
  G2_IDENTITY_REVIEW: "复核",
  G3_CONTENT: "内容",
  G4_ANIMATIONS: "动画",
  G5_CONTENT_READY: "校验",
  G6_GRAPH: "聚类",
  G7_RELEASE_READY: "发布",
};

type CourseGenerationViewProps = {
  onClose: () => void;
  onOpenCourse: (courseId: string) => void;
  onResume: () => void;
};

export function CourseGenerationView({
  onClose,
  onOpenCourse,
  onResume,
}: CourseGenerationViewProps) {
  const mode = useCourseGenerationStore((state) => state.mode);
  const status = useCourseGenerationStore((state) => state.status);
  const course = useCourseGenerationStore((state) => state.course);
  const gate = useCourseGenerationStore((state) => state.gate);
  const phaseLabel = useCourseGenerationStore((state) => state.phaseLabel);
  const phaseDetail = useCourseGenerationStore((state) => state.phaseDetail);
  const points = useCourseGenerationStore((state) => state.points);
  const clusters = useCourseGenerationStore((state) => state.clusters);
  const totalPoints = useCourseGenerationStore((state) => state.totalPoints);
  const conversationId = useCourseGenerationStore((state) => state.conversationId);
  const activityState = useCourseGenerationStore((state) => state.activityState);
  const activityLabel = useCourseGenerationStore((state) => state.activityLabel);
  const pointCompleted = useCourseGenerationStore((state) => state.pointCompleted);
  const animationCompleted = useCourseGenerationStore(
    (state) => state.animationCompleted
  );
  const animationTotal = useCourseGenerationStore((state) => state.animationTotal);
  const startedAt = useCourseGenerationStore((state) => state.startedAt);
  const lastActivityAt = useCourseGenerationStore((state) => state.lastActivityAt);
  const recentActivities = useCourseGenerationStore(
    (state) => state.recentActivities
  );
  const speed = useCourseGenerationStore((state) => state.speed);
  const error = useCourseGenerationStore((state) => state.error);
  const markLoading = useCourseGenerationStore((state) => state.markLoading);
  const applyEvent = useCourseGenerationStore((state) => state.applyEvent);
  const setPaused = useCourseGenerationStore((state) => state.setPaused);
  const setSpeed = useCourseGenerationStore((state) => state.setSpeed);
  const reset = useCourseGenerationStore((state) => state.reset);
  const requestDemo = useCourseGenerationStore((state) => state.requestDemo);
  const beginResume = useCourseGenerationStore((state) => state.beginResume);
  const leaveView = useCourseGenerationStore((state) =>
    (state as typeof state & { leaveView?: () => void }).leaveView
  );
  const replayRef = useRef<DemoReplaySource | null>(null);
  const resumePendingRef = useRef(false);
  const [timelineProgress, setTimelineProgress] = useState(0);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const isDemo = mode === "demo";

  useEffect(() => {
    if (!isDemo) {
      replayRef.current?.dispose();
      replayRef.current = null;
      return;
    }

    const controller = new AbortController();
    let disposed = false;
    markLoading();

    void Promise.all([
      fetch(`/api/courses/${DEMO_COURSE_ID}`, {
        cache: "no-store",
        signal: controller.signal,
      }),
      fetch(`/api/courses/${DEMO_COURSE_ID}/index`, {
        cache: "no-store",
        signal: controller.signal,
      }),
    ])
      .then(async ([courseResponse, indexResponse]) => {
        if (!courseResponse.ok) {
          throw new Error(`演示课程请求失败（${courseResponse.status}）`);
        }
        if (!indexResponse.ok) {
          throw new Error(`演示课程索引请求失败（${indexResponse.status}）`);
        }
        const [coursePayload, indexPayload]: [unknown, unknown] = await Promise.all([
          courseResponse.json(),
          indexResponse.json(),
        ]);
        const nextCourse = unwrapCourse(coursePayload);
        const nextIndex = unwrapIndex(indexPayload);
        if (!nextCourse || !nextIndex) throw new Error("演示课程数据格式无效");
        if (disposed) return;

        const timeline = buildDemoGenerationTimeline(nextCourse, nextIndex);
        const replay = new DemoReplaySource({
          timeline,
          onEvent: applyEvent,
          onProgress: setTimelineProgress,
        });
        replay.setSpeed(speed);
        replayRef.current = replay;
        replay.start();
      })
      .catch((reason: unknown) => {
        if (disposed || (reason instanceof DOMException && reason.name === "AbortError")) return;
        applyEvent({
          type: "generation_failed",
          message: reason instanceof Error ? reason.message : "无法加载课程生成演示",
        });
      });

    return () => {
      disposed = true;
      controller.abort();
      replayRef.current?.dispose();
      replayRef.current = null;
    };
  }, [applyEvent, isDemo, markLoading, reloadVersion]);

  useEffect(() => {
    if (isDemo || status === "completed") return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isDemo, status]);

  useEffect(() => {
    if (activityState !== "resuming") {
      resumePendingRef.current = false;
    }
  }, [activityState]);

  const completedPoints = useMemo(
    () => points.filter((point) => isPointComplete(point)),
    [points]
  );
  const generatingPoints = useMemo(
    () => points
      .filter((point) => pointStatus(point) === "generating")
      .sort((left, right) => left.order - right.order)
      .slice(0, 4),
    [points]
  );
  const recentPoints = useMemo(
    () => completedPoints.slice(-4).reverse(),
    [completedPoints]
  );
  const activeGateIndex = gate ? GENERATION_GATES.indexOf(gate) : -1;
  const isPaused = status === "paused";
  const isCompleted = status === "completed";
  const isLoading = status === "requested" || status === "loading";
  const isResuming = !isDemo && activityState === "resuming";
  const isWaitingReview = !isDemo && activityState === "waiting-review";
  const isDisconnected = !isDemo && activityState === "disconnected";
  const courseTitle = course?.title || (isDemo ? "软件工程" : "新课程");
  const completedPointCount = Math.max(completedPoints.length, pointCompleted);
  const completedRatio = totalPoints > 0
    ? Math.min(1, completedPointCount / totalPoints)
    : 0;
  const animationRatio = animationTotal > 0
    ? Math.min(1, animationCompleted / animationTotal)
    : 0;
  const elapsedSeconds = startedAt
    ? Math.max(0, Math.floor((clock - startedAt) / 1_000))
    : 0;
  const activityAgoSeconds = lastActivityAt
    ? Math.max(0, Math.floor((clock - lastActivityAt) / 1_000))
    : null;
  const stateCopy = generationStateCopy(activityState, activityLabel);

  const togglePlayback = () => {
    if (isPaused) {
      replayRef.current?.resume();
      setPaused(false);
    } else {
      replayRef.current?.pause();
      setPaused(true);
    }
  };

  const changeSpeed = (nextSpeed: number) => {
    setSpeed(nextSpeed);
    replayRef.current?.setSpeed(nextSpeed);
  };

  const restart = () => {
    setTimelineProgress(0);
    setPaused(false);
    replayRef.current?.restart();
  };

  const retry = () => {
    if (!isDemo) {
      if (isResuming || resumePendingRef.current) return;
      resumePendingRef.current = true;
      if (conversationId) beginResume(conversationId);
      onResume();
      return;
    }
    replayRef.current?.dispose();
    replayRef.current = null;
    requestDemo();
    setTimelineProgress(0);
    setReloadVersion((current) => current + 1);
  };

  const close = () => {
    replayRef.current?.dispose();
    if (isDemo) reset();
    else leaveView?.();
    onClose();
  };

  const openCourse = () => {
    const courseId = course?.id ?? (isDemo ? DEMO_COURSE_ID : "");
    if (!courseId) return;
    replayRef.current?.dispose();
    if (isDemo) reset();
    else leaveView?.();
    onOpenCourse(courseId);
  };

  return (
    <section
      className={`course-generation ${isDemo ? "is-demo" : "is-live"}`}
      aria-label={isDemo ? "课程生成演示" : "课程实时生成进度"}
    >
      <header className="course-generation__header">
        <div className="course-generation__identity">
          <span className="course-generation__brand-icon" aria-hidden="true">
            <Sprout size={19} />
          </span>
          <div>
            <div className="course-generation__title-row">
              <strong>
                {courseTitle}
                {isCompleted
                  ? "课程已完成"
                  : isWaitingReview
                    ? "课程等待审核"
                    : isDisconnected
                      ? "课程创建已断线"
                      : isPaused
                        ? "课程创建已暂停"
                        : "课程正在生长"}
              </strong>
              <span
                className={`course-generation__mode-badge ${
                  isDemo
                    ? "is-demo"
                    : `is-live is-${activityState}`
                }`}
              >
                {isDemo ? (
                  <Sparkles aria-hidden="true" size={11} />
                ) : isDisconnected ? (
                  <WifiOff aria-hidden="true" size={11} />
                ) : isWaitingReview ? (
                  <ClipboardCheck aria-hidden="true" size={11} />
                ) : (
                  <Radio aria-hidden="true" size={11} />
                )}
                {isDemo ? "演示模式" : stateCopy.badge}
              </span>
            </div>
            <span>
              {isDemo
                ? "使用预定义课程数据回放真实生成流程"
                : isDisconnected
                  ? "连接恢复后可以从已保存进度继续"
                  : isWaitingReview
                    ? "确认审核结果后流程会自动继续"
                    : course
                      ? "生成结果会随智能体工作实时更新"
                      : "等待智能体确认课程范围和名称"}
            </span>
          </div>
        </div>

        <div className="course-generation__header-actions">
          {isCompleted && course?.id && (
            <button
              type="button"
              className="course-generation__enter-button"
              onClick={openCourse}
            >
              进入课程
              <ArrowRight aria-hidden="true" size={15} />
            </button>
          )}
          <button
            type="button"
            className="course-generation__close-button"
            onClick={close}
            title={isDemo ? "退出生成演示" : "返回课程导览"}
            aria-label={isDemo ? "退出生成演示" : "返回课程导览"}
          >
            <X aria-hidden="true" size={17} />
          </button>
        </div>
      </header>

      <div className="course-generation__gates" aria-label="课程生成阶段">
        {GENERATION_GATES.map((item, index) => {
          const complete = index < activeGateIndex || isCompleted;
          const active = index === activeGateIndex && !isCompleted;
          return (
            <div
              key={item}
              className={`course-generation__gate ${
                complete ? "is-complete" : active ? "is-active" : ""
              }`}
              aria-current={active ? "step" : undefined}
            >
              <i aria-hidden="true">
                {complete ? <CheckCircle2 size={13} /> : index + 1}
              </i>
              <span>{GATE_LABELS[item]}</span>
            </div>
          );
        })}
      </div>

      <div className="course-generation__stage">
        <GenerationForestCanvas
          points={points}
          clusters={clusters}
          totalPoints={totalPoints}
          completed={isCompleted}
        />

        <aside className="course-generation__status-card" aria-live="polite">
          <span className="course-generation__status-kicker">
            {isCompleted
              ? "森林已完成"
              : !isDemo && activityState !== "working"
                ? stateCopy.badge
                : gate
                  ? GATE_LABELS[gate]
                  : "准备中"}
          </span>
          <h2>
            {isLoading
              ? isDemo
                ? "正在准备演示数据"
                : "正在连接课程生成状态"
              : !isDemo && activityState !== "working"
                ? stateCopy.title
                : activityLabel ||
                  phaseLabel ||
                  (isDemo ? "课程生成即将开始" : "等待课程范围确认")}
          </h2>
          <p>
            {isLoading
              ? isDemo
                ? "正在读取预定义的课程目录和知识点。"
                : "正在同步智能体已生成的课程文件。"
              : !isDemo && activityState !== "working"
                ? stateCopy.detail
                : phaseDetail ||
                  (isDemo
                    ? "稍候，第一颗知识树马上长出。"
                    : "你可以继续在右侧对话；确认后，知识树会在这里依次出现。")}
          </p>

          {!isDemo && (
            <dl className="course-generation__timing">
              <div>
                <dt>
                  <Clock3 aria-hidden="true" size={11} />
                  已用时
                </dt>
                <dd>{formatDuration(elapsedSeconds)}</dd>
              </div>
              <div>
                <dt>最后活动</dt>
                <dd>{formatActivityAge(activityAgoSeconds)}</dd>
              </div>
            </dl>
          )}

          <div className="course-generation__point-progress">
            <div>
              <span>已完成知识点</span>
              <strong>
                {completedPointCount}
                <small> / {totalPoints || "—"}</small>
              </strong>
            </div>
            <div
              className="course-generation__point-progress-track"
              role="progressbar"
              aria-label="知识点编写进度"
              aria-valuemin={0}
              aria-valuemax={totalPoints || 1}
              aria-valuenow={completedPointCount}
            >
              <i style={{ width: `${completedRatio * 100}%` }} />
            </div>
          </div>

          {!isDemo && animationTotal > 0 && (
            <div className="course-generation__animation-progress">
              <div>
                <span>教学动画</span>
                <strong>
                  {animationCompleted}
                  <small> / {animationTotal}</small>
                </strong>
              </div>
              <div
                className="course-generation__point-progress-track"
                role="progressbar"
                aria-label="教学动画生成进度"
                aria-valuemin={0}
                aria-valuemax={animationTotal}
                aria-valuenow={animationCompleted}
              >
                <i style={{ width: `${animationRatio * 100}%` }} />
              </div>
            </div>
          )}

          {generatingPoints.length > 0 && (
            <div className="course-generation__working">
              <span>正在并行编写 {generatingPoints.length} 个知识点</span>
              <div aria-hidden="true">
                {generatingPoints.map((point) => (
                  <i
                    key={point.id}
                    style={{ "--point-progress": `${pointProgress(point)}%` } as CSSProperties}
                  />
                ))}
              </div>
            </div>
          )}

          {!isDemo && recentActivities.length > 0 ? (
            <div className="course-generation__recent">
              <span>最近活动</span>
              <ul>
                {recentActivities
                  .slice(-3)
                  .reverse()
                  .map((activity, index) => (
                    <li
                      key={`${activity.at}:${activity.label}`}
                      className={index === 0 ? "is-latest" : ""}
                    >
                      <CheckCircle2 aria-hidden="true" size={13} />
                      <span>{activity.label}</span>
                      <time>{formatActivityAge(Math.max(0, Math.floor((clock - activity.at) / 1_000)))}</time>
                    </li>
                  ))}
              </ul>
            </div>
          ) : recentPoints.length > 0 && (
            <div className="course-generation__recent">
              <span>最近长成</span>
              <ul>
                {recentPoints.map((point, index) => (
                  <li key={point.id} className={index === 0 ? "is-latest" : ""}>
                    <CheckCircle2 aria-hidden="true" size={13} />
                    {point.title}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        {clusters.length > 0 && (
          <aside className="course-generation__cluster-legend" aria-label="知识簇">
            <span>知识簇正在形成</span>
            <div>
              {clusters.map((cluster) => (
                <i
                  key={cluster.id}
                  title={cluster.title}
                  aria-label={cluster.title}
                  style={{ backgroundColor: cluster.accent }}
                />
              ))}
            </div>
            <small>{clusters.length} 个知识簇</small>
          </aside>
        )}

        {(status === "error" ||
          (!isDemo &&
            (activityState === "paused" || activityState === "disconnected"))) && (
          <div
            className={`course-generation__error ${
              isDisconnected ? "is-disconnected" : ""
            }`}
            role="alert"
          >
            {isDisconnected ? (
              <WifiOff aria-hidden="true" size={23} />
            ) : (
              <AlertTriangle aria-hidden="true" size={23} />
            )}
            <strong>
              {isDemo
                ? "演示暂时无法启动"
                : isDisconnected
                  ? "与课程助手的连接已中断"
                  : "课程创建已暂停"}
            </strong>
            <span>
              {error ||
                "对话和已经生成的数据仍然保留，可以从当前进度继续。"}
            </span>
            <button type="button" onClick={retry}>
              {!isDemo && <Play aria-hidden="true" size={14} />}
              {isDemo ? "重试" : isDisconnected ? "重新连接后继续" : "继续创建"}
            </button>
          </div>
        )}

        {isWaitingReview && (
          <div className="course-generation__notice is-review" role="status">
            <ClipboardCheck aria-hidden="true" size={23} />
            <strong>等待你的审核</strong>
            <span>审核页已经准备好；确认知识结构后，课程创建会自动继续。</span>
          </div>
        )}

        {(isLoading || isResuming) && (
          <div className="course-generation__loading" role="status">
            <Loader2 aria-hidden="true" size={21} />
            {isDemo
              ? "正在装载课程种子"
              : isResuming
                ? "正在恢复课程创建，请稍候"
                : "正在同步生成现场"}
          </div>
        )}

        {isDemo && !isLoading && status !== "error" && (
          <div className="course-generation__controls" aria-label="演示播放控制">
            <button
              type="button"
              onClick={restart}
              title="重新播放"
              aria-label="重新播放"
            >
              <RotateCcw aria-hidden="true" size={15} />
            </button>
            <button
              type="button"
              className="course-generation__play-button"
              onClick={isCompleted ? restart : togglePlayback}
              title={isCompleted ? "重新播放" : isPaused ? "继续" : "暂停"}
              aria-label={isCompleted ? "重新播放" : isPaused ? "继续播放" : "暂停播放"}
            >
              {isCompleted ? (
                <RotateCcw aria-hidden="true" size={16} />
              ) : isPaused ? (
                <Play aria-hidden="true" size={17} fill="currentColor" />
              ) : (
                <Pause aria-hidden="true" size={17} fill="currentColor" />
              )}
            </button>
            <button
              type="button"
              onClick={() => replayRef.current?.skipToNextPhase()}
              disabled={isCompleted}
              title="跳到下一阶段"
              aria-label="跳到下一阶段"
            >
              <SkipForward aria-hidden="true" size={16} />
            </button>
            <span className="course-generation__control-divider" aria-hidden="true" />
            <div className="course-generation__speed">
              {SPEEDS.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={speed === item ? "is-active" : ""}
                  onClick={() => changeSpeed(item)}
                  aria-pressed={speed === item}
                >
                  {item}×
                </button>
              ))}
            </div>
            <span className="course-generation__timeline" aria-hidden="true">
              <i style={{ width: `${timelineProgress * 100}%` }} />
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function pointStatus(point: GenerationPointState) {
  return String(point.status);
}

function isPointComplete(point: GenerationPointState) {
  const status = pointStatus(point);
  return status === "grown" || status === "clustered";
}

function pointProgress(point: GenerationPointState) {
  const candidate = (point as GenerationPointState & { progress?: number }).progress;
  return Number.isFinite(candidate)
    ? Math.max(0, Math.min(100, candidate ?? 0))
    : 0;
}

function generationStateCopy(state: GenerationActivityState, activityLabel: string) {
  switch (state) {
    case "waiting-review":
      return {
        badge: "等待审核",
        title: activityLabel || "等待你的审核",
        detail: "审核结果提交后，系统会自动从当前 Gate 继续。",
      };
    case "waiting-user":
      return {
        badge: "等待确认",
        title: activityLabel || "等待你的确认",
        detail: "请在右侧课程助手中完成选择，流程会立即继续。",
      };
    case "resuming":
      return {
        badge: "正在恢复",
        title: activityLabel || "正在恢复课程创建",
        detail: "正在读取已保存的产物和审核状态，不会重复生成已完成内容。",
      };
    case "paused":
      return {
        badge: "已暂停",
        title: activityLabel || "课程创建已暂停",
        detail: "已生成的数据和对话仍然保留，可以继续创建。",
      };
    case "disconnected":
      return {
        badge: "连接中断",
        title: "与课程助手的连接已中断",
        detail: "系统正在尝试重新连接，现有进度不会丢失。",
      };
    case "completed":
      return {
        badge: "已完成",
        title: "课程发布完成",
        detail: "课程内容、知识图谱和动画资源已经准备完成。",
      };
    case "error":
      return {
        badge: "遇到问题",
        title: "课程创建遇到问题",
        detail: "当前进度已经保留，可以查看提示后重试。",
      };
    default:
      return {
        badge: "实时生成",
        title: activityLabel || "课程创建中",
        detail: "课程助手正在推进当前阶段。",
      };
  }
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  if (hours > 0) return `${hours}时${String(minutes).padStart(2, "0")}分`;
  if (minutes > 0) return `${minutes}分${String(remaining).padStart(2, "0")}秒`;
  return `${remaining}秒`;
}

function formatActivityAge(seconds: number | null) {
  if (seconds === null) return "等待首次活动";
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  return `${Math.floor(minutes / 60)}小时前`;
}

function unwrapCourse(payload: unknown): CourseMeta | null {
  const candidate = isRecord(payload) && "course" in payload ? payload.course : payload;
  if (
    !isRecord(candidate) ||
    typeof candidate.id !== "string" ||
    typeof candidate.title !== "string"
  ) {
    return null;
  }
  return {
    id: candidate.id,
    title: candidate.title,
    description:
      typeof candidate.description === "string" ? candidate.description : undefined,
  };
}

function unwrapIndex(payload: unknown): ForestIndex | null {
  const candidate = isRecord(payload) && "index" in payload ? payload.index : payload;
  if (
    !isRecord(candidate) ||
    !Array.isArray(candidate.clusters) ||
    !Array.isArray(candidate.points)
  ) {
    return null;
  }
  return candidate as unknown as ForestIndex;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
