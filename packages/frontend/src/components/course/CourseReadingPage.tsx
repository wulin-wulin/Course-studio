import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Home,
  Loader2,
  Map,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import type {
  CourseDataChangedDetail,
  CourseMeta,
  CoursePointDetail,
  ForestCluster,
  ForestIndex,
  ForestPoint,
} from "@/course/forest/types";
import "./courseReading.css";

type CourseReadingPageProps = {
  course: CourseMeta;
  pointId: string;
  routeClusterId?: string;
  onOpenPoint: (point: ForestPoint) => void;
  onBackToForest: () => void;
  onBackToCatalog: () => void;
};

/**
 * The original course project changes from the map into a dedicated reading
 * page.  This component keeps that behaviour while reading live JSON from the
 * course API instead of from a bundled static module.
 */
export function CourseReadingPage({
  course,
  pointId,
  routeClusterId,
  onOpenPoint,
  onBackToForest,
  onBackToCatalog,
}: CourseReadingPageProps) {
  const [index, setIndex] = useState<ForestIndex | null>(null);
  const [point, setPoint] = useState<CoursePointDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDockOpen, setIsDockOpen] = useState(true);

  const courseApi = `/api/courses/${encodeURIComponent(course.id)}`;

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [indexResponse, pointResponse] = await Promise.all([
        fetch(`${courseApi}/index`, { cache: "no-store" }),
        fetch(`${courseApi}/points/${encodeURIComponent(pointId)}`, { cache: "no-store" }),
      ]);
      if (!indexResponse.ok) throw new Error(`课程索引请求失败（${indexResponse.status}）`);
      if (!pointResponse.ok) throw new Error(`知识点详情请求失败（${pointResponse.status}）`);

      const [indexPayload, pointPayload]: [unknown, unknown] = await Promise.all([
        indexResponse.json(),
        pointResponse.json(),
      ]);
      const nextIndex = unwrapForestIndex(indexPayload);
      const nextPoint = unwrapPointDetail(pointPayload);
      if (!nextIndex || !nextPoint) throw new Error("课程数据格式无效");

      setIndex(nextIndex);
      setPoint(nextPoint);
    } catch (reason) {
      setIndex(null);
      setPoint(null);
      setError(reason instanceof Error ? reason.message : "知识点加载失败");
    } finally {
      setIsLoading(false);
    }
  }, [courseApi, pointId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onCourseDataChanged = (event: Event) => {
      const detail = (event as CustomEvent<CourseDataChangedDetail>).detail;
      if (detail?.course_id && detail.course_id !== course.id) return;
      void load();
    };
    window.addEventListener("course-data-changed", onCourseDataChanged);
    return () => window.removeEventListener("course-data-changed", onCourseDataChanged);
  }, [course.id, load]);

  const pointMeta = useMemo(
    () => index?.points.find((item) => item.id === pointId) ?? null,
    [index, pointId]
  );
  const activePoint = point ? { ...pointMeta, ...point } : pointMeta;
  const activeCluster = useMemo(() => {
    const clusterId = activePoint?.clusterId ?? routeClusterId;
    return index?.clusters.find((item) => item.id === clusterId) ?? null;
  }, [activePoint?.clusterId, index, routeClusterId]);
  const clusterPoints = useMemo(
    () => index?.points.filter((item) => item.clusterId === activeCluster?.id) ?? [],
    [activeCluster?.id, index]
  );
  const pointPosition = useMemo(() => {
    const allPoints = index?.points ?? [];
    const current = allPoints.findIndex((item) => item.id === pointId);
    return {
      previous: current > 0 ? allPoints[current - 1] ?? null : null,
      next: current >= 0 && current < allPoints.length - 1 ? allPoints[current + 1] ?? null : null,
      inCluster: clusterPoints.findIndex((item) => item.id === pointId) + 1,
    };
  }, [clusterPoints, index, pointId]);

  const accent = activeCluster?.accent ?? "#2f7567";
  const soft = activeCluster?.soft ?? "#e8f0e8";
  const readerStyle = { "--course-reader-accent": accent, "--course-reader-soft": soft } as CSSProperties;

  return (
    <section
      className={`course-reader ${isDockOpen ? "" : "course-reader--dock-collapsed"}`}
      aria-label={`${course.title}知识点阅读`}
      style={readerStyle}
    >
      <main className="course-reader__main" id="course-reading-content">
        <div className="course-reader__content">
          <nav className="course-reader__breadcrumb" aria-label="阅读导航">
            <button type="button" onClick={onBackToForest}>
              <Map aria-hidden="true" size={15} />
              返回知识地图
            </button>
            <span aria-hidden="true">/</span>
            <button type="button" onClick={onBackToCatalog}>
              <Home aria-hidden="true" size={15} />
              课程导览
            </button>
          </nav>

          {isLoading && (
            <div className="course-reader__state" role="status">
              <Loader2 aria-hidden="true" size={24} />
              正在展开知识点内容…
            </div>
          )}

          {!isLoading && error && (
            <div className="course-reader__state course-reader__state--error" role="alert">
              <strong>无法加载知识点</strong>
              <span>{error}</span>
              <button type="button" onClick={() => void load()}>
                重试
              </button>
            </div>
          )}

          {!isLoading && !error && activePoint && (
            <ReadingArticle
              point={activePoint as CoursePointDetail}
              cluster={activeCluster}
              course={course}
              previous={pointPosition.previous}
              next={pointPosition.next}
              positionInCluster={pointPosition.inCluster}
              clusterTotal={clusterPoints.length}
              onOpenPoint={onOpenPoint}
            />
          )}
        </div>
      </main>

      <aside
        className="course-reader__dock"
        aria-label="当前知识簇目录"
        aria-expanded={isDockOpen}
      >
        {isDockOpen ? (
          <>
            <div className="course-reader__dock-head">
              <div>
                <span>本知识簇</span>
                <strong>{activeCluster?.title ?? "章节目录"}</strong>
              </div>
              <button
                type="button"
                onClick={() => setIsDockOpen(false)}
                aria-label="收起本知识簇目录"
                title="收起本知识簇目录"
              >
                <PanelRightClose aria-hidden="true" size={17} />
              </button>
            </div>

            <ol className="course-reader__dock-list">
              {clusterPoints.map((item, itemIndex) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={item.id === pointId ? "is-current" : ""}
                    aria-current={item.id === pointId ? "page" : undefined}
                    onClick={() => onOpenPoint(item)}
                  >
                    <span>{String(itemIndex + 1).padStart(2, "0")}</span>
                    <strong>{item.title}</strong>
                  </button>
                </li>
              ))}
            </ol>

            <div className="course-reader__dock-foot">
              <button type="button" onClick={onBackToForest}>
                <ChevronLeft aria-hidden="true" size={15} />
                切换知识簇
              </button>
              <button type="button" onClick={onBackToCatalog}>
                <Home aria-hidden="true" size={15} />
                返回课程导览
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            className="course-reader__dock-expand"
            onClick={() => setIsDockOpen(true)}
            aria-label="展开本知识簇目录"
            title="展开本知识簇目录"
          >
            <PanelRightOpen aria-hidden="true" size={17} />
            <span>目录</span>
          </button>
        )}
      </aside>
    </section>
  );
}

function ReadingArticle({
  point,
  cluster,
  course,
  previous,
  next,
  positionInCluster,
  clusterTotal,
  onOpenPoint,
}: {
  point: CoursePointDetail;
  cluster: ForestCluster | null;
  course: CourseMeta;
  previous: ForestPoint | null;
  next: ForestPoint | null;
  positionInCluster: number;
  clusterTotal: number;
  onOpenPoint: (point: ForestPoint) => void;
}) {
  const expressionTags = [
    point.formula ? "公式" : null,
    point.visualType ? "图示" : null,
    point.animationType && point.animationType !== "none" ? "动画" : null,
  ].filter((tag): tag is string => Boolean(tag));
  const visualNotes = [point.visualSuggestion, point.animationSuggestion].filter(
    (item): item is string => Boolean(item)
  );
  const pros = point.prosCons?.pros ?? [];
  const cons = point.prosCons?.cons ?? [];

  return (
    <article className="course-reader__article">
      <nav className="course-reader__point-nav" aria-label="知识点推进">
        <button type="button" disabled={!previous} onClick={() => previous && onOpenPoint(previous)}>
          <ChevronLeft aria-hidden="true" size={17} />
          <span>{previous?.title ?? "已是第一个知识点"}</span>
        </button>
        <span>
          {cluster?.title ?? course.title} · 第 {Math.max(positionInCluster, 1)}/{clusterTotal || 1} 点
        </span>
        <button type="button" disabled={!next} onClick={() => next && onOpenPoint(next)}>
          <span>{next?.title ?? "已是最后一个知识点"}</span>
          <ChevronRight aria-hidden="true" size={17} />
        </button>
      </nav>

      <header className="course-reader__heading">
        <div className="course-reader__tags">
          <span>{cluster?.title ?? course.title}</span>
          {point.difficulty && <span>{point.difficulty}</span>}
          {expressionTags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
        <h1>{point.title}</h1>
        {point.shortSummary && <p>{point.shortSummary}</p>}
      </header>

      {point.coreIdea && (
        <section className="course-reader__lead">
          <span>核心思想</span>
          <p>{point.coreIdea}</p>
        </section>
      )}

      <div className="course-reader__reference-grid">
        {(point.keyTerms?.length ?? 0) > 0 && <TagSection title="关键词" items={point.keyTerms ?? []} />}
        {(point.prerequisites?.length ?? 0) > 0 && (
          <TagSection title="前置知识" items={point.prerequisites ?? []} muted />
        )}
        {(point.aliases?.length ?? 0) > 0 && <TagSection title="别名与关联称呼" items={point.aliases ?? []} muted />}
      </div>

      {point.formula && (
        <section className="course-reader__section course-reader__section--formula">
          <h2>用一个式子概括</h2>
          <pre>{point.formula}</pre>
        </section>
      )}

      <ListSection title="基本原理" items={point.principles} />
      <ListSection title="典型应用" items={point.applications} cards />
      <ListSection title="相关对比" items={point.comparisons} />

      {(point.intuition || point.history) && (
        <section className="course-reader__section">
          <h2>讲解线索</h2>
          <div className="course-reader__story-grid">
            {point.intuition && (
              <article>
                <span>直觉解释</span>
                <p>{point.intuition}</p>
              </article>
            )}
            {point.history && (
              <article>
                <span>发展脉络</span>
                <p>{point.history}</p>
              </article>
            )}
          </div>
        </section>
      )}

      <ListSection title="常见误区" items={point.misconceptions} warning />

      {(pros.length > 0 || cons.length > 0) && (
        <section className="course-reader__section">
          <h2>优势与局限</h2>
          <div className="course-reader__pros-cons">
            {pros.length > 0 && <ListSection title="优势" items={pros} tone="positive" />}
            {cons.length > 0 && <ListSection title="局限" items={cons} tone="negative" />}
          </div>
        </section>
      )}

      {(point.qa?.length ?? 0) > 0 && (
        <section className="course-reader__section">
          <h2>自测问答</h2>
          <div className="course-reader__qa-list">
            {point.qa?.map((item, index) => (
              <article key={`${item.q}-${index}`}>
                <span>Q{index + 1}</span>
                <strong>{item.q}</strong>
                <p>{item.a}</p>
              </article>
            ))}
          </div>
        </section>
      )}

      {visualNotes.length > 0 && <ListSection title="图示与动画提示" items={visualNotes} />}
      {point.ideologicalElement && <TextSection title="延伸思考" content={point.ideologicalElement} />}
    </article>
  );
}

function TagSection({ title, items, muted = false }: { title: string; items: string[]; muted?: boolean }) {
  return (
    <section className={`course-reader__tag-section ${muted ? "is-muted" : ""}`}>
      <h2>{title}</h2>
      <div>
        {items.map((item, index) => (
          <span key={`${item}-${index}`}>{item}</span>
        ))}
      </div>
    </section>
  );
}

function ListSection({
  title,
  items,
  cards = false,
  warning = false,
  tone,
}: {
  title: string;
  items: string[] | undefined;
  cards?: boolean;
  warning?: boolean;
  tone?: "positive" | "negative";
}) {
  if (!items || items.length === 0) return null;
  const className = [
    "course-reader__section",
    cards ? "course-reader__section--cards" : "",
    warning ? "course-reader__section--warning" : "",
    tone ? `course-reader__section--${tone}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <section className={className}>
      <h2>{title}</h2>
      <ul>
        {items.map((item, index) => (
          <li key={`${item}-${index}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function TextSection({ title, content }: { title: string; content: string }) {
  return (
    <section className="course-reader__section course-reader__section--coda">
      <h2>{title}</h2>
      <p>{content}</p>
    </section>
  );
}

function unwrapForestIndex(payload: unknown): ForestIndex | null {
  const candidate = isRecord(payload) && "index" in payload ? payload.index : payload;
  if (!isRecord(candidate) || !Array.isArray(candidate.clusters) || !Array.isArray(candidate.points)) return null;
  return candidate as unknown as ForestIndex;
}

function unwrapPointDetail(payload: unknown): CoursePointDetail | null {
  const candidate = isRecord(payload) && "point" in payload ? payload.point : payload;
  if (!isRecord(candidate) || typeof candidate.id !== "string") return null;
  return candidate as unknown as CoursePointDetail;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
