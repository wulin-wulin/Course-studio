import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  Layers3,
  Loader2,
  RefreshCw,
  Sparkles,
  Trees,
} from "lucide-react";
import { useCourseGenerationStore } from "@/course/generation/generationStore";
import "./CourseCatalog.css";

/**
 * The small, stable representation returned by GET /api/courses.
 *
 * Keep this separate from a course's editable course.json: the catalogue can
 * render a course without downloading its full forest index.
 */
export type CourseSummary = {
  id: string;
  title: string;
  description?: string;
  language?: string;
  revision?: string | number;
  clusters?: number;
  points?: number;
  invalid?: boolean;
};

type CourseCatalogProps = {
  onOpenCourse: (course: CourseSummary) => void;
  onOpenGeneration: (conversationId: string) => void;
  onStartGenerationDemo: () => void;
};

const COURSE_API = "/api/courses";

export function CourseCatalog({
  onOpenCourse,
  onOpenGeneration,
  onStartGenerationDemo,
}: CourseCatalogProps) {
  const liveRuns = useCourseGenerationStore((state) => state.liveRuns);
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);

  const loadCourses = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoadError(null);
    setIsRefreshing(true);

    try {
      const response = await fetch(COURSE_API, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`课程列表请求失败（${response.status}）`);
      }

      const payload: unknown = await response.json();
      const nextCourses = unwrapCourses(payload);
      if (!nextCourses) {
        throw new Error("课程列表格式无效");
      }

      if (!mountedRef.current || requestId !== requestRef.current) return;
      setCourses(nextCourses);
    } catch (error) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setLoadError(error instanceof Error ? error.message : "课程列表加载失败");
    } finally {
      if (mountedRef.current && requestId === requestRef.current) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    // StrictMode intentionally runs the effect setup twice in development.
    // Resetting the flag keeps the second (real) request eligible to update UI.
    mountedRef.current = true;
    void loadCourses();

    const onCourseDataChanged = () => {
      void loadCourses();
    };
    window.addEventListener("course-data-changed", onCourseDataChanged);

    return () => {
      mountedRef.current = false;
      window.removeEventListener("course-data-changed", onCourseDataChanged);
    };
  }, [loadCourses]);

  const validCourses = courses.filter((course) => !course.invalid);
  const invalidCourses = courses.filter((course) => course.invalid);
  const validCourseIds = new Set(validCourses.map((course) => course.id));
  const activeGenerations = Object.values(liveRuns)
    .filter(
      (run) =>
        !run.published &&
        !(run.course?.id && validCourseIds.has(run.course.id))
    )
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const runningGenerationCount = activeGenerations.filter(
    (run) => run.status === "running"
  ).length;
  const pausedGenerationCount =
    activeGenerations.length - runningGenerationCount;

  return (
    <main className="course-catalog" aria-label="课程导览">
      <div className="course-catalog__inner">
        <header className="course-catalog__hero">
          <p className="course-catalog__eyebrow">
            <Trees aria-hidden="true" size={17} />
            知识森林
          </p>
          <h2>课程导览</h2>
          <p className="course-catalog__intro">
            每一门课程都是一片森林。选择一门课程，沿着知识路径走进它的地图。
          </p>
        </header>

        <div className="course-catalog__heading-row">
          <div className="course-catalog__heading-copy">
            <span>可用课程</span>
            <strong>
              {isLoading
                ? "正在整理课程…"
                : [
                    `${validCourses.length} 门课程`,
                    runningGenerationCount > 0
                      ? `${runningGenerationCount} 门创建中`
                      : "",
                    pausedGenerationCount > 0
                      ? `${pausedGenerationCount} 门已暂停`
                      : "",
                  ].filter(Boolean).join(" · ")}
            </strong>
          </div>
          <div className="course-catalog__heading-actions">
            <button
              type="button"
              className="course-catalog__demo"
              onClick={onStartGenerationDemo}
            >
              <Sparkles aria-hidden="true" size={14} />
              <span>生成演示</span>
            </button>
            <button
              type="button"
              className="course-catalog__refresh"
              onClick={() => void loadCourses()}
              disabled={isRefreshing}
              aria-label="刷新课程列表"
              title="刷新课程列表"
            >
              <RefreshCw aria-hidden="true" size={15} className={isRefreshing ? "is-spinning" : undefined} />
              <span>刷新</span>
            </button>
          </div>
        </div>

        {isLoading &&
          courses.length === 0 &&
          activeGenerations.length === 0 && <CatalogState kind="loading" />}

        {loadError && courses.length === 0 && activeGenerations.length === 0 && (
          <CatalogState kind="error" message={loadError} onRetry={() => void loadCourses()} />
        )}

        {!isLoading &&
          !loadError &&
          validCourses.length === 0 &&
          activeGenerations.length === 0 && <CatalogState kind="empty" />}

        {(activeGenerations.length > 0 || validCourses.length > 0) && (
          <ul className="course-catalog__shelf" aria-label="可进入的课程">
            {activeGenerations.map((run) => {
              const completedPoints = run.points.filter(
                (point) => point.status === "grown" || point.status === "clustered"
              ).length;
              const interrupted =
                run.status === "error" || run.status === "paused";
              return (
                <li key={`generation:${run.conversationId}`}>
                  <button
                    type="button"
                    className={`course-catalog__card course-catalog__card--generation ${
                      interrupted ? "is-error" : ""
                    }`}
                    onClick={() => onOpenGeneration(run.conversationId)}
                    aria-label={`查看${run.course?.title ?? "新课程"}的创建进度`}
                  >
                    <span className="course-catalog__card-icon" aria-hidden="true">
                      {interrupted ? (
                        <AlertCircle size={19} />
                      ) : (
                        <Loader2 size={19} className="is-spinning" />
                      )}
                    </span>
                    <span className="course-catalog__generation-badge">
                      {interrupted ? "创建已暂停" : "正在创建"}
                    </span>
                    <span className="course-catalog__card-title">
                      {run.course?.title ?? "正在创建的新课程"}
                    </span>
                    <span className="course-catalog__card-description">
                      {run.error || run.phaseDetail}
                    </span>
                    <span className="course-catalog__metrics">
                      <span>
                        <Layers3 aria-hidden="true" size={14} />
                        {run.clusters.length || "—"} 个知识簇
                      </span>
                      <span>
                        {completedPoints} / {run.totalPoints || "—"} 个知识点
                      </span>
                    </span>
                    <span className="course-catalog__enter">
                      {interrupted ? "查看并继续创建" : "查看生长过程"}
                      <ArrowRight aria-hidden="true" size={16} />
                    </span>
                  </button>
                </li>
              );
            })}
            {validCourses.map((course) => (
              <li key={course.id}>
                <button
                  type="button"
                  className="course-catalog__card"
                  onClick={() => onOpenCourse(course)}
                  aria-label={`进入${course.title}课程地图`}
                >
                  <span className="course-catalog__card-icon" aria-hidden="true">
                    <BookOpen size={19} />
                  </span>
                  <span className="course-catalog__card-title">{course.title}</span>
                  <span className="course-catalog__card-description">
                    {course.description?.trim() || "这门课程正在形成一片新的知识森林。"}
                  </span>
                  <span className="course-catalog__metrics">
                    <span>
                      <Layers3 aria-hidden="true" size={14} />
                      {formatCount(course.clusters)} 个知识簇
                    </span>
                    <span>{formatCount(course.points)} 个知识点</span>
                  </span>
                  <span className="course-catalog__enter">
                    走进森林
                    <ArrowRight aria-hidden="true" size={16} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {loadError && (courses.length > 0 || activeGenerations.length > 0) && (
          <p className="course-catalog__soft-error" role="status">
            <AlertCircle aria-hidden="true" size={15} />
            课程列表暂未刷新：{loadError}
          </p>
        )}

        {invalidCourses.length > 0 && (
          <p className="course-catalog__soft-error" role="status">
            <AlertCircle aria-hidden="true" size={15} />
            {invalidCourses.length} 门课程的数据尚未通过校验，暂不能打开。
          </p>
        )}
      </div>
    </main>
  );
}

function CatalogState({
  kind,
  message,
  onRetry,
}: {
  kind: "loading" | "empty" | "error";
  message?: string;
  onRetry?: () => void;
}) {
  if (kind === "loading") {
    return (
      <div className="course-catalog__state" role="status">
        <Loader2 aria-hidden="true" size={24} className="is-spinning" />
        <span>正在加载课程导览…</span>
      </div>
    );
  }

  if (kind === "error") {
    return (
      <div className="course-catalog__state course-catalog__state--error" role="alert">
        <AlertCircle aria-hidden="true" size={24} />
        <strong>无法加载课程列表</strong>
        <span>{message}</span>
        <button type="button" onClick={onRetry}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="course-catalog__state">
      <BookOpen aria-hidden="true" size={24} />
      <strong>还没有可展示的课程</strong>
      <span>课程创建完成后会自动显示在这里。</span>
    </div>
  );
}

function unwrapCourses(payload: unknown): CourseSummary[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.courses)) return null;

  const courses: CourseSummary[] = [];
  for (const item of payload.courses) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) return null;
    courses.push({
      id: item.id,
      title: typeof item.title === "string" && item.title.trim() ? item.title : item.id,
      description: typeof item.description === "string" ? item.description : undefined,
      language: typeof item.language === "string" ? item.language : undefined,
      revision: typeof item.revision === "string" || typeof item.revision === "number" ? item.revision : undefined,
      clusters: toNonNegativeInteger(item.clusters),
      points: toNonNegativeInteger(item.points),
      invalid: item.invalid === true,
    });
  }
  return courses;
}

function toNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function formatCount(value: number | undefined): string {
  return typeof value === "number" ? String(value) : "—";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
