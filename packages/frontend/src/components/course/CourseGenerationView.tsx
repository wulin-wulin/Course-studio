import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Sparkles,
  Sprout,
  X,
} from "lucide-react";
import type { CourseMeta, ForestIndex } from "@/course/forest/types";
import { DemoReplaySource } from "@/course/generation/DemoReplaySource";
import { buildDemoGenerationTimeline } from "@/course/generation/demoTimeline";
import { GenerationForestCanvas } from "@/course/generation/GenerationForestCanvas";
import { useCourseGenerationStore } from "@/course/generation/generationStore";
import {
  GENERATION_GATES,
  type GenerationGate,
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
};

export function CourseGenerationView({
  onClose,
  onOpenCourse,
}: CourseGenerationViewProps) {
  const status = useCourseGenerationStore((state) => state.status);
  const course = useCourseGenerationStore((state) => state.course);
  const gate = useCourseGenerationStore((state) => state.gate);
  const phaseLabel = useCourseGenerationStore((state) => state.phaseLabel);
  const phaseDetail = useCourseGenerationStore((state) => state.phaseDetail);
  const points = useCourseGenerationStore((state) => state.points);
  const clusters = useCourseGenerationStore((state) => state.clusters);
  const totalPoints = useCourseGenerationStore((state) => state.totalPoints);
  const speed = useCourseGenerationStore((state) => state.speed);
  const error = useCourseGenerationStore((state) => state.error);
  const markLoading = useCourseGenerationStore((state) => state.markLoading);
  const applyEvent = useCourseGenerationStore((state) => state.applyEvent);
  const setPaused = useCourseGenerationStore((state) => state.setPaused);
  const setSpeed = useCourseGenerationStore((state) => state.setSpeed);
  const reset = useCourseGenerationStore((state) => state.reset);
  const requestDemo = useCourseGenerationStore((state) => state.requestDemo);
  const replayRef = useRef<DemoReplaySource | null>(null);
  const [timelineProgress, setTimelineProgress] = useState(0);
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
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
  }, [applyEvent, markLoading, reloadVersion]);

  const grownPoints = useMemo(
    () => points.filter((point) => point.status !== "planned"),
    [points]
  );
  const recentPoints = useMemo(
    () => grownPoints.slice(-4).reverse(),
    [grownPoints]
  );
  const activeGateIndex = gate ? GENERATION_GATES.indexOf(gate) : -1;
  const isPaused = status === "paused";
  const isCompleted = status === "completed";
  const isLoading = status === "requested" || status === "loading";

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
    replayRef.current?.dispose();
    replayRef.current = null;
    requestDemo();
    setTimelineProgress(0);
    setReloadVersion((current) => current + 1);
  };

  const close = () => {
    replayRef.current?.dispose();
    reset();
    onClose();
  };

  const openCourse = () => {
    const courseId = course?.id ?? DEMO_COURSE_ID;
    replayRef.current?.dispose();
    reset();
    onOpenCourse(courseId);
  };

  return (
    <section className="course-generation" aria-label="课程生成演示">
      <header className="course-generation__header">
        <div className="course-generation__identity">
          <span className="course-generation__brand-icon" aria-hidden="true">
            <Sprout size={19} />
          </span>
          <div>
            <div className="course-generation__title-row">
              <strong>{course?.title ?? "软件工程"}课程正在生长</strong>
              <span className="course-generation__demo-badge">
                <Sparkles aria-hidden="true" size={11} />
                演示模式
              </span>
            </div>
            <span>使用预定义课程数据回放真实生成流程</span>
          </div>
        </div>

        <div className="course-generation__header-actions">
          {isCompleted && (
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
            title="退出生成演示"
            aria-label="退出生成演示"
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
            {isCompleted ? "森林已完成" : gate ? GATE_LABELS[gate] : "准备中"}
          </span>
          <h2>{isLoading ? "正在准备演示数据" : phaseLabel || "课程生成即将开始"}</h2>
          <p>
            {isLoading
              ? "正在读取预定义的课程目录和知识点。"
              : phaseDetail || "稍候，第一颗知识种子马上落下。"}
          </p>

          <div className="course-generation__point-progress">
            <div>
              <span>已完成知识点</span>
              <strong>
                {grownPoints.length}
                <small> / {totalPoints || "—"}</small>
              </strong>
            </div>
            <div
              className="course-generation__point-progress-track"
              role="progressbar"
              aria-label="知识点编写进度"
              aria-valuemin={0}
              aria-valuemax={totalPoints || 1}
              aria-valuenow={grownPoints.length}
            >
              <i
                style={{
                  width: `${totalPoints > 0 ? (grownPoints.length / totalPoints) * 100 : 0}%`,
                }}
              />
            </div>
          </div>

          {recentPoints.length > 0 && (
            <div className="course-generation__recent">
              <span>最近长成</span>
              <ul>
                {recentPoints.map((point, index) => (
                  <li key={point.id} className={index === 0 ? "is-latest" : ""}>
                    <Sprout aria-hidden="true" size={13} />
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

        {status === "error" && (
          <div className="course-generation__error" role="alert">
            <AlertTriangle aria-hidden="true" size={23} />
            <strong>演示暂时无法启动</strong>
            <span>{error}</span>
            <button type="button" onClick={retry}>
              重试
            </button>
          </div>
        )}

        {isLoading && (
          <div className="course-generation__loading" role="status">
            <Loader2 aria-hidden="true" size={21} />
            正在装载课程种子
          </div>
        )}

        {!isLoading && status !== "error" && (
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

