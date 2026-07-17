import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Home,
  Lightbulb,
  ListTree,
  Loader2,
  Map as MapIcon,
  PanelRightClose,
  PanelRightOpen,
  PlayCircle,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type {
  CourseDataChangedDetail,
  CourseMeta,
  CoursePointDetail,
  ForestCluster,
  ForestIndex,
  ForestPoint,
} from "@/course/forest/types";
import { MarkdownContent } from "../chat/MarkdownContent";
import "./courseReading.css";

type CourseReadingPageProps = {
  course: CourseMeta;
  pointId: string;
  routeClusterId?: string;
  onOpenPoint: (point: ForestPoint) => void;
  onBackToForest: () => void;
  onBackToCatalog: () => void;
};

type ArticleSection = {
  id: string;
  label: string;
};

type AnimationAvailability = "checking" | "available" | "unavailable";
type ReaderLayoutMode = "wide" | "compact" | "narrow";

const courseIndexCache = new Map<string, ForestIndex>();

export function CourseReadingPage({
  course,
  pointId,
  routeClusterId,
  onOpenPoint,
  onBackToForest,
  onBackToCatalog,
}: CourseReadingPageProps) {
  const [index, setIndex] = useState<ForestIndex | null>(() => courseIndexCache.get(course.id) ?? null);
  const [point, setPoint] = useState<CoursePointDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDockOpen, setIsDockOpen] = useState(() => window.innerWidth >= 1600);
  const [layoutMode, setLayoutMode] = useState<ReaderLayoutMode>(() => readerLayoutMode(window.innerWidth));
  const readerRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const dockListRef = useRef<HTMLOListElement>(null);
  const dockExpandButtonRef = useRef<HTMLButtonElement>(null);
  const dockCloseButtonRef = useRef<HTMLButtonElement>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const dockPreferenceRef = useRef<"auto" | "manual">("auto");
  const restoreDockFocusRef = useRef(false);
  const courseApi = `/api/courses/${encodeURIComponent(course.id)}`;
  const isDockOverlayOpen = isDockOpen && layoutMode !== "wide";

  const setDock = useCallback((open: boolean, restoreFocus = true) => {
    dockPreferenceRef.current = "manual";
    restoreDockFocusRef.current = !open && restoreFocus;
    setIsDockOpen(open);
  }, []);

  const load = useCallback(async (forceIndex = false) => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setIsLoading(true);
    setError(null);
    setPoint(null);

    try {
      const cachedIndex = forceIndex ? null : courseIndexCache.get(course.id) ?? null;
      const indexRequest = cachedIndex
        ? Promise.resolve(cachedIndex)
        : fetch(`${courseApi}/index`, { cache: "no-store", signal: controller.signal })
            .then(async (response) => {
              if (!response.ok) throw new Error(`课程索引请求失败（${response.status}）`);
              const payload: unknown = await response.json();
              const nextIndex = unwrapForestIndex(payload);
              if (!nextIndex) throw new Error("课程索引格式无效");
              courseIndexCache.set(course.id, nextIndex);
              return nextIndex;
            });
      const pointRequest = fetch(`${courseApi}/points/${encodeURIComponent(pointId)}`, {
        cache: "no-store",
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok) throw new Error(`知识点详情请求失败（${response.status}）`);
        const payload: unknown = await response.json();
        const nextPoint = unwrapPointDetail(payload);
        if (!nextPoint || nextPoint.id !== pointId) throw new Error("知识点详情格式无效");
        return nextPoint;
      });

      const [nextIndex, nextPoint] = await Promise.all([indexRequest, pointRequest]);
      if (controller.signal.aborted) return;
      setIndex(nextIndex);
      setPoint(nextPoint);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      if (controller.signal.aborted) return;
      setPoint(null);
      setError(reason instanceof Error ? reason.message : "知识点加载失败");
    } finally {
      if (!controller.signal.aborted) setIsLoading(false);
    }
  }, [course.id, courseApi, pointId]);

  useEffect(() => {
    void load();
    return () => loadAbortRef.current?.abort();
  }, [load]);

  useEffect(() => {
    const onCourseDataChanged = (event: Event) => {
      const detail = (event as CustomEvent<CourseDataChangedDetail>).detail;
      if (detail?.course_id && detail.course_id !== course.id) return;
      courseIndexCache.delete(course.id);
      void load(true);
    };
    window.addEventListener("course-data-changed", onCourseDataChanged);
    return () => window.removeEventListener("course-data-changed", onCourseDataChanged);
  }, [course.id, load]);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader || typeof ResizeObserver === "undefined") return;
    const updateDockForWidth = (width: number) => {
      setLayoutMode(readerLayoutMode(width));
      if (dockPreferenceRef.current === "auto") setIsDockOpen(width >= 1120);
    };
    updateDockForWidth(reader.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number") updateDockForWidth(width);
    });
    observer.observe(reader);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isDockOverlayOpen) return;
    const focusFrame = window.requestAnimationFrame(() => dockCloseButtonRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      // The global Agent drawer can open above this dialog. Its parent workspace
      // becomes inert, so the underlying course-directory trap must stand down.
      if (readerRef.current?.closest("[inert]")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setDock(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dockRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dockRef.current?.contains(active))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !dockRef.current?.contains(active))) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isDockOverlayOpen, setDock]);

  useEffect(() => {
    if (isDockOpen || !restoreDockFocusRef.current) return;
    restoreDockFocusRef.current = false;
    const frame = window.requestAnimationFrame(() => dockExpandButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isDockOpen]);

  useEffect(() => {
    if (isLoading || !point || point.id !== pointId) return;
    const frame = window.requestAnimationFrame(() => {
      mainRef.current?.scrollTo({ top: 0, behavior: "auto" });
      headingRef.current?.focus({ preventScroll: true });
      const currentItem = dockListRef.current?.querySelector<HTMLElement>("[aria-current='page']");
      currentItem?.scrollIntoView({ block: "nearest" });
    });
    document.title = `${point.title} · ${course.title}`;
    return () => window.cancelAnimationFrame(frame);
  }, [course.title, isLoading, point, pointId]);

  useEffect(() => () => {
    document.title = "课程知识森林";
  }, []);

  const pointMeta = useMemo(
    () => index?.points.find((item) => item.id === pointId) ?? null,
    [index, pointId],
  );
  const activePoint = point ? { ...pointMeta, ...point } : pointMeta;
  const activeCluster = useMemo(() => {
    const clusterId = activePoint?.clusterId ?? routeClusterId;
    return index?.clusters.find((item) => item.id === clusterId) ?? null;
  }, [activePoint?.clusterId, index, routeClusterId]);
  const clusterPoints = useMemo(
    () => index?.points.filter((item) => item.clusterId === activeCluster?.id) ?? [],
    [activeCluster?.id, index],
  );
  const pointPosition = useMemo(() => {
    const current = clusterPoints.findIndex((item) => item.id === pointId);
    return {
      previous: current > 0 ? clusterPoints[current - 1] ?? null : null,
      next: current >= 0 && current < clusterPoints.length - 1 ? clusterPoints[current + 1] ?? null : null,
      inCluster: current + 1,
    };
  }, [clusterPoints, pointId]);

  const accent = activeCluster?.accent ?? "#2f7567";
  const soft = activeCluster?.soft ?? "#e8f0e8";
  const readerStyle = { "--course-reader-accent": accent, "--course-reader-soft": soft } as CSSProperties;

  return (
    <section
      ref={readerRef}
      className={`course-reader course-reader--${layoutMode} ${isDockOpen ? "" : "course-reader--dock-collapsed"}`}
      aria-label={`${course.title}知识点阅读`}
      style={readerStyle}
    >
      <div
        ref={mainRef}
        className="course-reader__main"
        id="course-reading-content"
        role="region"
        aria-labelledby="course-point-title"
        aria-hidden={isDockOverlayOpen || undefined}
        inert={isDockOverlayOpen ? true : undefined}
      >
        <div className="course-reader__content">
          <nav className="course-reader__breadcrumb" aria-label="阅读导航">
            <button type="button" onClick={onBackToCatalog}>
              <Home aria-hidden="true" size={15} />
              课程导览
            </button>
            <ChevronRight aria-hidden="true" size={13} />
            <button type="button" onClick={onBackToForest}>
              <MapIcon aria-hidden="true" size={15} />
              {course.title}知识地图
            </button>
            {activePoint?.title && (
              <>
                <ChevronRight aria-hidden="true" size={13} />
                <span aria-current="page">{activePoint.title}</span>
              </>
            )}
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
                <RefreshCw aria-hidden="true" size={14} />
                重试
              </button>
            </div>
          )}

          {!isLoading && !error && activePoint && index && (
            <ReadingArticle
              point={activePoint as CoursePointDetail}
              cluster={activeCluster}
              course={course}
              allPoints={index.points}
              previous={pointPosition.previous}
              next={pointPosition.next}
              positionInCluster={pointPosition.inCluster}
              clusterTotal={clusterPoints.length}
              headingRef={headingRef}
              scrollRootRef={mainRef}
              onOpenPoint={onOpenPoint}
            />
          )}
        </div>
      </div>

      {isDockOverlayOpen && (
        <button
          type="button"
          className="course-reader__dock-scrim"
          aria-label="关闭本知识簇目录"
          tabIndex={-1}
          onClick={() => setDock(false)}
        />
      )}

      <aside
        ref={dockRef}
        id="course-cluster-directory"
        className="course-reader__dock"
        aria-label="当前知识簇目录"
        role={isDockOverlayOpen ? "dialog" : undefined}
        aria-modal={isDockOverlayOpen ? true : undefined}
      >
        {isDockOpen ? (
          <>
            <div className="course-reader__dock-head">
              <div>
                <span>本知识簇</span>
                <strong>{activeCluster?.title ?? "章节目录"}</strong>
                <small>{clusterPoints.length} 个知识点</small>
              </div>
              <button
                ref={dockCloseButtonRef}
                type="button"
                onClick={() => setDock(false)}
                aria-label="收起本知识簇目录"
                aria-controls="course-cluster-directory"
                aria-expanded="true"
                title="收起本知识簇目录"
              >
                <PanelRightClose aria-hidden="true" size={17} />
              </button>
            </div>

            <ol ref={dockListRef} className="course-reader__dock-list">
              {clusterPoints.map((item, itemIndex) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={item.id === pointId ? "is-current" : ""}
                    aria-current={item.id === pointId ? "page" : undefined}
                    onClick={() => {
                      if (isDockOverlayOpen) setDock(false, false);
                      onOpenPoint(item);
                    }}
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
            ref={dockExpandButtonRef}
            type="button"
            className="course-reader__dock-expand"
            onClick={() => setDock(true)}
            aria-label="展开本知识簇目录"
            aria-controls="course-cluster-directory"
            aria-expanded="false"
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
  allPoints,
  previous,
  next,
  positionInCluster,
  clusterTotal,
  headingRef,
  scrollRootRef,
  onOpenPoint,
}: {
  point: CoursePointDetail;
  cluster: ForestCluster | null;
  course: CourseMeta;
  allPoints: ForestPoint[];
  previous: ForestPoint | null;
  next: ForestPoint | null;
  positionInCluster: number;
  clusterTotal: number;
  headingRef: RefObject<HTMLHeadingElement | null>;
  scrollRootRef: RefObject<HTMLDivElement | null>;
  onOpenPoint: (point: ForestPoint) => void;
}) {
  const hasDeclaredAnimation = Boolean(point.animationType && point.animationType !== "none");
  const [animationAvailability, setAnimationAvailability] = useState<AnimationAvailability>(
    hasDeclaredAnimation ? "checking" : "unavailable",
  );
  const hasDistinctCoreIdea = Boolean(
    point.coreIdea
    && normalizeComparableText(point.coreIdea) !== normalizeComparableText(point.shortSummary ?? ""),
  );
  const pros = point.prosCons?.pros ?? [];
  const cons = point.prosCons?.cons ?? [];
  const visualNotes = [
    point.visual?.caption,
    point.visualSuggestion,
    animationAvailability === "unavailable" ? point.animationSuggestion : null,
  ].filter((item): item is string => Boolean(item?.trim()));
  const hasVisualGuide = visualNotes.length > 0 || Boolean(point.visual?.type);
  const expressionTags = [
    point.difficulty || null,
    point.kind ? formatPointKind(point.kind) : null,
    point.role ? formatPointRole(point.role) : null,
    point.formula ? "含公式" : null,
    hasVisualGuide ? "图示说明" : null,
    animationAvailability === "available" ? "交互演示" : null,
  ].filter((tag): tag is string => Boolean(tag));
  const sections = useMemo<ArticleSection[]>(() => [
    hasDistinctCoreIdea ? { id: "section-core-idea", label: "核心思想" } : null,
    hasDeclaredAnimation && animationAvailability !== "unavailable"
      ? { id: "section-animation", label: "交互演示" }
      : null,
    hasVisualGuide ? { id: "section-visual-guide", label: "图示说明" } : null,
    point.formula ? { id: "section-formula", label: "关键公式" } : null,
    point.principles?.length ? { id: "section-principles", label: "基本原理" } : null,
    point.applications?.length ? { id: "section-applications", label: "典型应用" } : null,
    point.comparisons?.length ? { id: "section-comparisons", label: "相关对比" } : null,
    point.intuition || point.history ? { id: "section-story", label: "讲解线索" } : null,
    point.misconceptions?.length ? { id: "section-misconceptions", label: "常见误区" } : null,
    pros.length || cons.length ? { id: "section-pros-cons", label: "优势与局限" } : null,
    point.qa?.length ? { id: "section-qa", label: "自测问答" } : null,
    point.ideologicalElement ? { id: "section-coda", label: "延伸思考" } : null,
  ].filter((item): item is ArticleSection => Boolean(item)), [
    animationAvailability,
    cons.length,
    hasDeclaredAnimation,
    hasDistinctCoreIdea,
    hasVisualGuide,
    point.applications?.length,
    point.comparisons?.length,
    point.formula,
    point.history,
    point.ideologicalElement,
    point.intuition,
    point.misconceptions?.length,
    point.principles?.length,
    point.qa?.length,
    pros.length,
  ]);
  const [activeSectionId, setActiveSectionId] = useState(sections[0]?.id ?? "");

  useEffect(() => {
    setAnimationAvailability(hasDeclaredAnimation ? "checking" : "unavailable");
  }, [hasDeclaredAnimation, point.id]);

  useEffect(() => {
    setActiveSectionId(sections[0]?.id ?? "");
    const root = scrollRootRef.current;
    if (!root || sections.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const rootTop = root.getBoundingClientRect().top;
      let current = sections[0]?.id ?? "";
      for (const section of sections) {
        const element = document.getElementById(section.id);
        if (!element) continue;
        if (element.getBoundingClientRect().top - rootTop <= 180) current = section.id;
        else break;
      }
      setActiveSectionId(current);
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };
    update();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [point.id, scrollRootRef, sections]);

  const scrollToSection = (section: ArticleSection) => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const target = document.getElementById(section.id);
    if (!target) return;
    target.tabIndex = -1;
    if (!target.hasAttribute("aria-label")) target.setAttribute("aria-label", section.label);
    target.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "start",
    });
    setActiveSectionId(section.id);
    window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
  };

  return (
    <article className="course-reader__article">
      <PointNavigation
        clusterTitle={cluster?.title ?? course.title}
        previous={previous}
        next={next}
        position={positionInCluster}
        total={clusterTotal}
        onOpenPoint={onOpenPoint}
      />

      <header className="course-reader__heading">
        <div className="course-reader__tags">
          <span>{cluster?.title ?? course.title}</span>
          {point.subtitle && point.subtitle !== cluster?.title && <span>{point.subtitle}</span>}
          {expressionTags.map((tag) => <span key={tag}>{tag}</span>)}
          {point.yearIntroduced && <span>{point.yearIntroduced} 年提出</span>}
        </div>
        <h1 ref={headingRef} id="course-point-title" tabIndex={-1}>{point.title}</h1>
        {point.shortSummary && <RichText content={point.shortSummary} className="course-reader__summary" />}
        <div className="course-reader__heading-meta" aria-label="知识点学习信息">
          <span>本簇第 {Math.max(positionInCluster, 1)} / {clusterTotal || 1} 点</span>
          {typeof point.importance === "number" && (
            <span>学习权重 {Math.round(Math.min(1, Math.max(0, point.importance)) * 100)}%</span>
          )}
          <span>{sections.length} 个内容模块</span>
        </div>
      </header>

      {sections.length > 1 && (
        <nav className="course-reader__article-toc" aria-label="本文内容目录">
          <span><ListTree aria-hidden="true" size={14} />本文内容</span>
          <div>
            {sections.map((section) => (
              <button
                type="button"
                key={section.id}
                className={activeSectionId === section.id ? "is-current" : ""}
                aria-current={activeSectionId === section.id ? "location" : undefined}
                onClick={() => scrollToSection(section)}
              >
                {section.label}
              </button>
            ))}
          </div>
        </nav>
      )}

      {hasDistinctCoreIdea && point.coreIdea && (
        <section id="section-core-idea" className="course-reader__lead course-reader__anchored-section">
          <span><Lightbulb aria-hidden="true" size={15} />核心思想</span>
          <RichText content={point.coreIdea} />
        </section>
      )}

      {hasDeclaredAnimation && point.animationType && (
        <CourseAnimationFrame
          courseId={course.id}
          animationType={point.animationType}
          pointTitle={point.title}
          suggestion={point.animationSuggestion}
          onAvailabilityChange={setAnimationAvailability}
        />
      )}

      {hasVisualGuide && (
        <VisualGuide point={point} notes={visualNotes} />
      )}

      <div className="course-reader__reference-grid">
        {(point.keyTerms?.length ?? 0) > 0 && <TagSection title="关键词" items={point.keyTerms ?? []} />}
        {(point.prerequisites?.length ?? 0) > 0 && (
          <ReferenceSection
            title="前置知识"
            references={point.prerequisites ?? []}
            allPoints={allPoints}
            onOpenPoint={onOpenPoint}
          />
        )}
        {(point.related?.length ?? 0) > 0 && (
          <ReferenceSection
            title="相关知识"
            references={point.related ?? []}
            allPoints={allPoints}
            onOpenPoint={onOpenPoint}
          />
        )}
        {(point.aliases?.length ?? 0) > 0 && <TagSection title="别名与关联称呼" items={point.aliases ?? []} muted />}
      </div>

      {point.formula && (
        <section id="section-formula" className="course-reader__section course-reader__section--formula course-reader__anchored-section">
          <h2>关键公式</h2>
          <div className="course-reader__formula-surface">
            <RichText content={normalizeFormulaMarkdown(point.formula)} />
          </div>
        </section>
      )}

      <ListSection id="section-principles" title="基本原理" items={point.principles} />
      <ListSection id="section-applications" title="典型应用" items={point.applications} cards />
      <ListSection id="section-comparisons" title="相关对比" items={point.comparisons} />

      {(point.intuition || point.history) && (
        <section id="section-story" className="course-reader__section course-reader__anchored-section">
          <h2>讲解线索</h2>
          <div className="course-reader__story-grid">
            {point.intuition && (
              <article>
                <span>直觉解释</span>
                <RichText content={point.intuition} />
              </article>
            )}
            {point.history && (
              <article>
                <span>发展脉络</span>
                <RichText content={point.history} />
              </article>
            )}
          </div>
        </section>
      )}

      <ListSection id="section-misconceptions" title="常见误区" items={point.misconceptions} warning />

      {(pros.length > 0 || cons.length > 0) && (
        <section id="section-pros-cons" className="course-reader__section course-reader__anchored-section">
          <h2>优势与局限</h2>
          <div className="course-reader__pros-cons">
            {pros.length > 0 && <ListSection title="优势" items={pros} tone="positive" nested />}
            {cons.length > 0 && <ListSection title="局限" items={cons} tone="negative" nested />}
          </div>
        </section>
      )}

      {(point.qa?.length ?? 0) > 0 && (
        <section id="section-qa" className="course-reader__section course-reader__anchored-section">
          <h2>自测问答</h2>
          <p className="course-reader__section-intro">先在心里作答，再展开查看参考答案。</p>
          <div className="course-reader__qa-list">
            {point.qa?.map((item, index) => (
              <details key={`${item.q}-${index}`}>
                <summary>
                  <span>Q{index + 1}</span>
                  <strong>{item.q}</strong>
                  <ChevronDown aria-hidden="true" size={16} />
                </summary>
                <div className="course-reader__qa-answer">
                  <span>参考答案</span>
                  <RichText content={item.a} />
                </div>
              </details>
            ))}
          </div>
        </section>
      )}

      {point.ideologicalElement && (
        <TextSection id="section-coda" title="延伸思考" content={point.ideologicalElement} />
      )}

      <PointNavigation
        clusterTitle={cluster?.title ?? course.title}
        previous={previous}
        next={next}
        position={positionInCluster}
        total={clusterTotal}
        onOpenPoint={onOpenPoint}
        footer
      />
    </article>
  );
}

function PointNavigation({
  clusterTitle,
  previous,
  next,
  position,
  total,
  onOpenPoint,
  footer = false,
}: {
  clusterTitle: string;
  previous: ForestPoint | null;
  next: ForestPoint | null;
  position: number;
  total: number;
  onOpenPoint: (point: ForestPoint) => void;
  footer?: boolean;
}) {
  return (
    <nav className={`course-reader__point-nav ${footer ? "course-reader__point-nav--footer" : ""}`} aria-label={footer ? "继续学习" : "知识点推进"}>
      <button type="button" disabled={!previous} onClick={() => previous && onOpenPoint(previous)}>
        <ChevronLeft aria-hidden="true" size={17} />
        <span><small>上一个</small><strong>{previous?.title ?? "已是本簇第一点"}</strong></span>
      </button>
      <span>{clusterTitle} · {Math.max(position, 1)}/{total || 1}</span>
      <button type="button" disabled={!next} onClick={() => next && onOpenPoint(next)}>
        <span><small>下一个</small><strong>{next?.title ?? "已是本簇最后一点"}</strong></span>
        <ChevronRight aria-hidden="true" size={17} />
      </button>
    </nav>
  );
}

function CourseAnimationFrame({
  courseId,
  animationType,
  pointTitle,
  suggestion,
  onAvailabilityChange,
}: {
  courseId: string;
  animationType: string;
  pointTitle: string;
  suggestion?: string;
  onAvailabilityChange: (availability: AnimationAvailability) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<"checking" | "loading" | "ready" | "unavailable" | "error">("checking");
  const [height, setHeight] = useState(560);
  const [attempt, setAttempt] = useState(0);
  const courseApi = `/api/courses/${encodeURIComponent(courseId)}`;

  useEffect(() => {
    const controller = new AbortController();
    setStatus("checking");
    setHeight(560);
    onAvailabilityChange("checking");
    void fetch(`${courseApi}/animations/manifest`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 404) {
          setStatus("unavailable");
          onAvailabilityChange("unavailable");
          return;
        }
        if (!response.ok) throw new Error(`动画清单请求失败（${response.status}）`);
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !Array.isArray(payload.animations)) throw new Error("动画清单格式无效");
        const available = payload.animations.some(
          (item) => isRecord(item) && item.type === animationType,
        );
        setStatus(available ? "loading" : "unavailable");
        onAvailabilityChange(available ? "available" : "unavailable");
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setStatus("error");
        onAvailabilityChange("unavailable");
      });
    return () => controller.abort();
  }, [animationType, attempt, courseApi, onAvailabilityChange]);

  useEffect(() => {
    const receiveRuntimeMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== frameRef.current?.contentWindow || !isRecord(event.data)) return;
      if (event.data.channel !== "course-studio-animation-v1") return;
      if (event.data.kind === "resize" && typeof event.data.height === "number" && Number.isFinite(event.data.height)) {
        setHeight(Math.min(1200, Math.max(320, Math.ceil(event.data.height) + 4)));
        setStatus("ready");
        onAvailabilityChange("available");
      } else if (event.data.kind === "error") {
        setStatus("error");
        onAvailabilityChange("unavailable");
      }
    };
    window.addEventListener("message", receiveRuntimeMessage);
    return () => window.removeEventListener("message", receiveRuntimeMessage);
  }, [onAvailabilityChange]);

  useEffect(() => {
    if (status !== "loading") return;
    const timer = window.setTimeout(() => {
      setStatus("error");
      onAvailabilityChange("unavailable");
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [onAvailabilityChange, status]);

  if (status === "unavailable") return null;
  if (status === "checking") {
    return (
      <section id="section-animation" className="course-reader__animation course-reader__animation--loading course-reader__anchored-section" aria-busy="true">
        <PlayCircle aria-hidden="true" size={18} />
        <span>正在检查交互演示…</span>
      </section>
    );
  }
  if (status === "error") {
    return (
      <section id="section-animation" className="course-reader__animation course-reader__animation--error course-reader__anchored-section" role="status">
        <AlertTriangle aria-hidden="true" size={18} />
        <div>
          <strong>交互演示暂时无法加载</strong>
          <span>正文与图示说明仍可正常阅读。</span>
        </div>
        <button type="button" onClick={() => setAttempt((current) => current + 1)}>
          <RefreshCw aria-hidden="true" size={14} />
          重试
        </button>
      </section>
    );
  }

  const source = `${courseApi}/animations/player?type=${encodeURIComponent(animationType)}&attempt=${attempt}`;
  return (
    <figure id="section-animation" className={`course-reader__animation course-reader__anchored-section ${status === "loading" ? "is-runtime-loading" : ""}`} aria-label={`${pointTitle}交互演示`}>
      <div className="course-reader__animation-head">
        <span><PlayCircle aria-hidden="true" size={15} />交互演示</span>
        {status === "loading" && <small><Loader2 aria-hidden="true" size={13} />正在启动</small>}
        {status === "ready" && <small><CheckCircle2 aria-hidden="true" size={13} />可以操作</small>}
      </div>
      <iframe
        ref={frameRef}
        src={source}
        title={`${pointTitle}教学动画`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        style={{ height }}
      />
      {suggestion && <figcaption><RichText content={suggestion} /></figcaption>}
    </figure>
  );
}

function VisualGuide({ point, notes }: { point: CoursePointDetail; notes: string[] }) {
  const visualColor = typeof point.visual?.color === "string" && /^#[0-9a-f]{6}$/i.test(point.visual.color)
    ? point.visual.color
    : undefined;
  const style = visualColor ? { "--course-visual-accent": visualColor } as CSSProperties : undefined;
  return (
    <section id="section-visual-guide" className="course-reader__visual-guide course-reader__anchored-section" style={style}>
      <div className="course-reader__visual-guide-head">
        <span><Sparkles aria-hidden="true" size={15} />图示说明</span>
        {point.visual?.type && <small>{formatVisualType(point.visual.type)}</small>}
      </div>
      <div className="course-reader__visual-guide-body">
        {notes.map((note, index) => <RichText key={`${note}-${index}`} content={note} />)}
      </div>
    </section>
  );
}

function RichText({ content, className = "" }: { content: string; className?: string }) {
  return (
    <MarkdownContent
      content={normalizeCourseMarkdown(content)}
      className={`course-reader__richtext ${className}`}
    />
  );
}

function TagSection({ title, items, muted = false }: { title: string; items: string[]; muted?: boolean }) {
  return (
    <section className={`course-reader__tag-section ${muted ? "is-muted" : ""}`}>
      <h2>{title}</h2>
      <div>{items.map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}</div>
    </section>
  );
}

function ReferenceSection({
  title,
  references,
  allPoints,
  onOpenPoint,
}: {
  title: string;
  references: string[];
  allPoints: ForestPoint[];
  onOpenPoint: (point: ForestPoint) => void;
}) {
  const resolveReference = (reference: string) => allPoints.find(
    (candidate) => candidate.id === reference || candidate.title === reference,
  ) ?? null;
  return (
    <section className="course-reader__tag-section course-reader__tag-section--references">
      <h2>{title}</h2>
      <div>
        {references.map((reference, index) => {
          const target = resolveReference(reference);
          return target ? (
            <button type="button" key={`${reference}-${index}`} onClick={() => onOpenPoint(target)}>
              {target.title}<ChevronRight aria-hidden="true" size={12} />
            </button>
          ) : (
            <span className="is-unresolved" key={`${reference}-${index}`} title="当前课程中没有可跳转的对应知识点">
              {reference}
            </span>
          );
        })}
      </div>
    </section>
  );
}

function ListSection({
  id,
  title,
  items,
  cards = false,
  warning = false,
  tone,
  nested = false,
}: {
  id?: string;
  title: string;
  items: string[] | undefined;
  cards?: boolean;
  warning?: boolean;
  tone?: "positive" | "negative";
  nested?: boolean;
}) {
  if (!items || items.length === 0) return null;
  const className = [
    "course-reader__section",
    id ? "course-reader__anchored-section" : "",
    cards ? "course-reader__section--cards" : "",
    warning ? "course-reader__section--warning" : "",
    tone ? `course-reader__section--${tone}` : "",
    nested ? "course-reader__section--nested" : "",
  ].filter(Boolean).join(" ");
  return (
    <section id={id} className={className}>
      {nested ? <h3>{title}</h3> : <h2>{title}</h2>}
      <ul>
        {items.map((item, index) => <li key={`${item}-${index}`}><RichText content={item} /></li>)}
      </ul>
    </section>
  );
}

function TextSection({ id, title, content }: { id: string; title: string; content: string }) {
  return (
    <section id={id} className="course-reader__section course-reader__section--coda course-reader__anchored-section">
      <h2>{title}</h2>
      <RichText content={content} />
    </section>
  );
}

function normalizeCourseMarkdown(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/([^\n])\n(?=(?:\d+\.|[-*])\s+)/g, "$1\n\n")
    .replace(/([^\n])\n(?=```)/g, "$1\n\n")
    .trim();
}

function normalizeFormulaMarkdown(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").replace(/\\\\\s*\n/g, "\n").trim();
  if (normalized.includes("$")) return normalized;
  return normalized
    .split(/\n+/)
    .map((line) => {
      const content = line.trim().replace(/\\\\$/, "");
      if (!content) return "";
      return /\\[a-zA-Z]+|[_^{}]/.test(content) ? `$$\n${content}\n$$` : content;
    })
    .filter(Boolean)
    .join("\n\n");
}

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/g, "").replace(/[。；;，,]/g, "").toLowerCase();
}

function formatPointKind(kind: string): string {
  const labels: Record<string, string> = {
    concept: "概念",
    method: "方法",
    theorem: "定理",
    skill: "技能",
    tool: "工具",
    practice: "实践",
  };
  return labels[kind] ?? kind;
}

function formatPointRole(role: string): string {
  const labels: Record<string, string> = {
    trunk: "主干知识",
    branch: "分支知识",
    leaf: "拓展知识",
  };
  return labels[role] ?? role;
}

function formatVisualType(type: string): string {
  const labels: Record<string, string> = {
    "concept-card": "概念卡片",
    foundation: "基础图示",
    comparison: "对比图示",
    process: "流程图示",
  };
  return labels[type] ?? type;
}

function readerLayoutMode(width: number): ReaderLayoutMode {
  if (width <= 640) return "narrow";
  if (width <= 1120) return "compact";
  return "wide";
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
