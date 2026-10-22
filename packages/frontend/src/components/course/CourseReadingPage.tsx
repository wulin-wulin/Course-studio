import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  ForestSourceSpan,
  TextbookContentBlock,
  TextbookContentBlockKind,
  TextbookLearningAsset,
  TextbookLearningDepth,
  TextbookLearningDesign,
  TextbookLearningModule,
  TextbookPointContentV2,
} from "@/course/forest/types";
import { buildCourseDirectory, normalizeForestIndex } from "@/course/forest/forestAdapter";
import {
  normalizeTextbookMarkdown,
  normalizeTextbookContentV2,
  normalizeTextbookLearningAssets,
  normalizeTextbookLearningDesign,
  splitTextbookExerciseReference,
  textbookContentBlockKindLabel,
  textbookSourceHeading,
  textbookSourceLocator,
  textbookSourceTechnicalDetails,
} from "@/course/forest/textbookContent";
import { MarkdownContent } from "../chat/MarkdownContent";
import { QuantizationLab, type QuantizationLabPreset } from "./QuantizationLab";
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

type ContentBlockReference = {
  id: string;
  label: string;
  domId?: string;
};

type AnimationAvailability = "checking" | "available" | "unavailable";
type ReaderLayoutMode = "wide" | "compact" | "narrow";
type TextbookReaderView = "learning" | "comparison" | "audit";
type TextbookReadingDepthMode = "core" | "full";

type IndexedTextbookBlock = {
  block: TextbookContentBlock;
  sourceIndex: number;
};

type TextbookReadingModule = {
  id: string;
  title: string;
  role?: string;
  description?: string;
  explicit: boolean;
  blocks: IndexedTextbookBlock[];
};

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
  const [expandedDirectoryClusterId, setExpandedDirectoryClusterId] = useState<string | null>(null);
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
  const courseDirectoryGroups = useMemo(
    () => index ? buildCourseDirectory(index) : [],
    [index],
  );
  const orderedCoursePoints = useMemo(
    () => courseDirectoryGroups.flatMap((group) => group.points),
    [courseDirectoryGroups],
  );
  const clusterPoints = useMemo(
    () => orderedCoursePoints.filter((item) => item.clusterId === activeCluster?.id),
    [activeCluster?.id, orderedCoursePoints],
  );
  const usesCourseSequence = Boolean(index?.sequences);
  const navigationPoints = usesCourseSequence ? orderedCoursePoints : clusterPoints;

  useEffect(() => {
    if (!usesCourseSequence || !activeCluster?.id) return;
    setExpandedDirectoryClusterId(activeCluster.id);
  }, [activeCluster?.id, usesCourseSequence]);
  const pointPosition = useMemo(() => {
    const current = navigationPoints.findIndex((item) => item.id === pointId);
    return {
      previous: current > 0 ? navigationPoints[current - 1] ?? null : null,
      next: current >= 0 && current < navigationPoints.length - 1 ? navigationPoints[current + 1] ?? null : null,
      current: current + 1,
    };
  }, [navigationPoints, pointId]);

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
              positionInCluster={pointPosition.current}
              clusterTotal={navigationPoints.length}
              usesCourseSequence={usesCourseSequence}
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
        aria-label={usesCourseSequence ? "课程学习目录" : "当前知识簇目录"}
        role={isDockOverlayOpen ? "dialog" : undefined}
        aria-modal={isDockOverlayOpen ? true : undefined}
      >
        {isDockOpen ? (
          <>
            <div className="course-reader__dock-head">
              <div>
                <span>{usesCourseSequence ? "完整课程目录" : "本知识簇"}</span>
                <strong>{usesCourseSequence ? course.title : activeCluster?.title ?? "章节目录"}</strong>
                <small>
                  {usesCourseSequence
                    ? `${courseDirectoryGroups.length} 个知识簇 · ${orderedCoursePoints.length} 个知识点`
                    : `${clusterPoints.length} 个知识点`}
                </small>
              </div>
              <button
                ref={dockCloseButtonRef}
                type="button"
                onClick={() => setDock(false)}
                aria-label={usesCourseSequence ? "收起课程目录" : "收起本知识簇目录"}
                aria-controls="course-cluster-directory"
                aria-expanded="true"
                title={usesCourseSequence ? "收起课程目录" : "收起本知识簇目录"}
              >
                <PanelRightClose aria-hidden="true" size={17} />
              </button>
            </div>

            {usesCourseSequence ? (
              <ol ref={dockListRef} className="course-reader__dock-list course-reader__dock-list--course">
                {courseDirectoryGroups.map((group, groupIndex) => {
                  const isExpanded = expandedDirectoryClusterId === group.cluster.id;
                  return (
                    <li key={group.cluster.id} className="course-reader__dock-cluster">
                      <button
                        type="button"
                        className={`course-reader__dock-cluster-toggle${group.cluster.id === activeCluster?.id ? " is-current-cluster" : ""}`}
                        aria-expanded={isExpanded}
                        aria-controls={`course-directory-${groupIndex}`}
                        onClick={() => setExpandedDirectoryClusterId(isExpanded ? null : group.cluster.id)}
                      >
                        <i style={{ backgroundColor: group.cluster.accent }} aria-hidden="true" />
                        <span>
                          <small>知识簇 {String(groupIndex + 1).padStart(2, "0")}</small>
                          <strong>{group.cluster.title}</strong>
                        </span>
                        <em>{group.points.length}</em>
                        <ChevronDown aria-hidden="true" size={14} />
                      </button>
                      {isExpanded && (
                        <ol id={`course-directory-${groupIndex}`}>
                          {group.points.map((item, itemIndex) => (
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
                                {item.origin === "llm-extension" && <small>模型扩展</small>}
                              </button>
                            </li>
                          ))}
                        </ol>
                      )}
                    </li>
                  );
                })}
              </ol>
            ) : (
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
            )}

            <div className="course-reader__dock-foot">
              <button type="button" onClick={onBackToForest}>
                <ChevronLeft aria-hidden="true" size={15} />
                {usesCourseSequence ? "返回知识森林" : "切换知识簇"}
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
            aria-label={usesCourseSequence ? "展开课程目录" : "展开本知识簇目录"}
            aria-controls="course-cluster-directory"
            aria-expanded="false"
            title={usesCourseSequence ? "展开课程目录" : "展开本知识簇目录"}
          >
            <PanelRightOpen aria-hidden="true" size={17} />
            <span>目录</span>
          </button>
        )}
      </aside>
    </section>
  );
}

type ReadingArticleProps = {
  point: CoursePointDetail;
  cluster: ForestCluster | null;
  course: CourseMeta;
  allPoints: ForestPoint[];
  previous: ForestPoint | null;
  next: ForestPoint | null;
  positionInCluster: number;
  clusterTotal: number;
  usesCourseSequence: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  scrollRootRef: RefObject<HTMLDivElement | null>;
  onOpenPoint: (point: ForestPoint) => void;
};

function ReadingArticle(props: ReadingArticleProps) {
  const textbookContent = useMemo(
    () => normalizeTextbookContentV2(props.point.content),
    [props.point.content],
  );
  return textbookContent
    ? <TextbookReadingArticle {...props} content={textbookContent} />
    : <LegacyReadingArticle {...props} />;
}

function mergeLearningDesign(
  pointDesign: TextbookLearningDesign | null,
  contentDesign: TextbookLearningDesign | null,
): TextbookLearningDesign | null {
  if (!pointDesign && !contentDesign) return null;
  const merged = { ...pointDesign, ...contentDesign };
  const pointModules = pointDesign?.modules ?? [];
  const contentModules = contentDesign?.modules ?? [];
  if (pointModules.length > 0 || contentModules.length > 0) {
    const modules = new Map<string, TextbookLearningModule>();
    for (const module of [...pointModules, ...contentModules]) modules.set(module.id, module);
    merged.modules = [...modules.values()];
  }
  return merged;
}

function buildTextbookReadingModules(
  blocks: TextbookContentBlock[],
  definitions: TextbookLearningModule[],
): TextbookReadingModule[] {
  const definitionById = new Map(definitions.map((module) => [module.id, module]));
  const hasAssignments = blocks.some((block) => Boolean(block.moduleId));
  if (!hasAssignments) {
    return blocks.map((block, sourceIndex) => ({
      id: block.id,
      title: learningBlockTitle(block),
      explicit: false,
      blocks: [{ block, sourceIndex }],
    }));
  }

  const occurrences = new Map<string, number>();
  const modules: TextbookReadingModule[] = [];
  for (const [sourceIndex, block] of blocks.entries()) {
    const baseId = block.moduleId ?? `unassigned-${block.id}`;
    const previous = modules.at(-1);
    if (previous?.id === baseId || previous?.id.startsWith(`${baseId}--segment-`)) {
      previous.blocks.push({ block, sourceIndex });
      continue;
    }
    const occurrence = (occurrences.get(baseId) ?? 0) + 1;
    occurrences.set(baseId, occurrence);
    const definition = block.moduleId ? definitionById.get(block.moduleId) : undefined;
    modules.push({
      id: occurrence === 1 ? baseId : `${baseId}--segment-${occurrence}`,
      title: definition?.title ?? learningBlockTitle(block),
      ...(definition?.role ? { role: definition.role } : {}),
      ...(definition?.description ? { description: definition.description } : {}),
      explicit: Boolean(block.moduleId),
      blocks: [{ block, sourceIndex }],
    });
  }
  return modules;
}

function placeLearningAssets(assets: TextbookLearningAsset[], blocks: TextbookContentBlock[]) {
  const blockIds = new Set(blocks.map((block) => block.id));
  const byAnchor = new Map<string, TextbookLearningAsset[]>();
  const unanchored: TextbookLearningAsset[] = [];
  for (const asset of assets) {
    if (!blockIds.has(asset.anchorBlockId)) {
      unanchored.push(asset);
      continue;
    }
    const anchored = byAnchor.get(asset.anchorBlockId) ?? [];
    anchored.push(asset);
    byAnchor.set(asset.anchorBlockId, anchored);
  }
  return { byAnchor, unanchored };
}

function LearningDesignOverview({
  design,
  prerequisites,
  allPoints,
  showEditorialPolicy,
}: {
  design: TextbookLearningDesign;
  prerequisites: string[];
  allPoints: ForestPoint[];
  showEditorialPolicy: boolean;
}) {
  const outcomes = design.outcomes ?? [];
  const prerequisiteLabels = prerequisites.map((reference) => (
    allPoints.find((candidate) => candidate.id === reference || candidate.title === reference)?.title ?? reference
  ));
  const editorialPolicy = showEditorialPolicy ? design.editorialPolicy : undefined;
  if (outcomes.length === 0 && prerequisites.length === 0 && !editorialPolicy) return null;
  const hasLessonNotes = prerequisites.length > 0 || Boolean(editorialPolicy);
  return (
    <section
      className={`course-reader__learning-overview ${hasLessonNotes ? "" : "is-outcomes-only"}`.trim()}
      aria-label="本节学习设计"
    >
      {outcomes.length > 0 && (
        <div className="course-reader__learning-outcomes">
          <strong><CheckCircle2 aria-hidden="true" size={15} />学完你将能够</strong>
          <ul>
            {outcomes.map((outcome, index) => <li key={outcome.id ?? `${outcome.text}-${index}`}>{outcome.text}</li>)}
          </ul>
        </div>
      )}
      {hasLessonNotes && (
        <div className="course-reader__lesson-notes">
          {prerequisites.length > 0 && (
            <p><strong>开始前</strong><span>{prerequisiteLabels.join("、")}</span></p>
          )}
          {editorialPolicy && (
            <p><strong>编排说明</strong><span>{editorialPolicy}</span></p>
          )}
        </div>
      )}
    </section>
  );
}

function LearningCompletionCard({
  design,
  blocks,
  allPoints,
  onOpenPoint,
}: {
  design: TextbookLearningDesign;
  blocks: TextbookContentBlock[];
  allPoints: ForestPoint[];
  onOpenPoint: (point: ForestPoint) => void;
}) {
  const completion = design.completion;
  if (!completion) return null;
  const outcomeRefs = new Set(completion.outcomeRefs ?? []);
  const outcomes = (design.outcomes ?? []).filter((outcome) => (
    outcomeRefs.size === 0 || (outcome.id ? outcomeRefs.has(outcome.id) : false)
  ));
  const exercise = completion.exerciseBlockId
    ? blocks.find((block) => block.id === completion.exerciseBlockId)
    : undefined;
  const nextPoint = completion.nextPointId
    ? allPoints.find((candidate) => candidate.id === completion.nextPointId)
    : undefined;
  if (
    outcomes.length === 0
    && !completion.method
    && (completion.successCriteria?.length ?? 0) === 0
    && !exercise
    && !nextPoint
  ) return null;

  return (
    <section className="course-reader__completion" aria-label="本节达成检查">
      <header>
        <span><CheckCircle2 aria-hidden="true" size={15} />达成检查</span>
        <h2>把本节知识变成可用能力</h2>
      </header>
      {completion.method && <RichText content={completion.method} />}
      {outcomes.length > 0 && (
        <ul className="course-reader__completion-outcomes">
          {outcomes.map((outcome, index) => (
            <li key={outcome.id ?? `${outcome.text}-${index}`}>{outcome.text}</li>
          ))}
        </ul>
      )}
      {(completion.successCriteria?.length ?? 0) > 0 && (
        <div className="course-reader__completion-criteria">
          <strong>完成标准</strong>
          <ul>
            {completion.successCriteria?.map((criterion, index) => (
              <li key={`${criterion}-${index}`}>{criterion}</li>
            ))}
          </ul>
        </div>
      )}
      {(exercise || nextPoint) && (
        <footer>
          {exercise && <span>完成“{learningBlockTitle(exercise)}”后，再检查上述目标。</span>}
          {nextPoint && (
            <button type="button" onClick={() => onOpenPoint(nextPoint)}>
              继续学习：{nextPoint.title}<ChevronRight aria-hidden="true" size={15} />
            </button>
          )}
        </footer>
      )}
    </section>
  );
}

function TextbookReadingArticle({
  point,
  content,
  cluster,
  course,
  allPoints,
  previous,
  next,
  positionInCluster,
  clusterTotal,
  usesCourseSequence,
  headingRef,
  scrollRootRef,
  onOpenPoint,
}: ReadingArticleProps & { content: TextbookPointContentV2 }) {
  const [viewMode, setViewMode] = useState<TextbookReaderView>("learning");
  const [readingDepth, setReadingDepth] = useState<TextbookReadingDepthMode>("full");
  const pointLearningDesign = useMemo(
    () => normalizeTextbookLearningDesign(point.learningDesign),
    [point.learningDesign],
  );
  const learningDesign = useMemo(
    () => mergeLearningDesign(pointLearningDesign, content.learningDesign ?? null),
    [content.learningDesign, pointLearningDesign],
  );
  const learningAssets = useMemo(() => {
    const pointAssets = normalizeTextbookLearningAssets(point.learningAssets);
    const merged = [...(content.learningAssets ?? []), ...pointAssets];
    const ids = new Set<string>();
    return merged.flatMap((asset) => {
      if (ids.has(asset.id)) return [];
      ids.add(asset.id);
      return [asset];
    }).map((asset, index) => (
      !asset.animationType && index === 0 && point.animationType && point.animationType !== "none"
        ? { ...asset, animationType: point.animationType }
        : asset
    ));
  }, [content.learningAssets, point.animationType, point.learningAssets]);
  const showAllDepths = viewMode !== "learning" || readingDepth === "full";
  const visibleLearningAssets = useMemo(
    () => showAllDepths
      ? learningAssets
      : learningAssets.filter((asset) => !asset.depth || asset.depth === "core"),
    [learningAssets, showAllDepths],
  );
  const hasLegacyAnimation = Boolean(point.animationType && point.animationType !== "none");
  const hasInlineAnimation = visibleLearningAssets.some((asset) => Boolean(asset.animationType));
  const hasDeclaredAnimation = hasInlineAnimation || (learningAssets.length === 0 && hasLegacyAnimation);
  const [animationAvailability, setAnimationAvailability] = useState<AnimationAvailability>(
    hasDeclaredAnimation ? "checking" : "unavailable",
  );
  const modules = useMemo(
    () => buildTextbookReadingModules(content.blocks, learningDesign?.modules ?? []),
    [content.blocks, learningDesign?.modules],
  );
  const visibleModules = useMemo(() => {
    if (showAllDepths) return modules;
    return modules.flatMap((module) => {
      const blocks = module.blocks.filter(({ block }) => !block.depth || block.depth === "core");
      return blocks.length > 0 ? [{ ...module, blocks }] : [];
    });
  }, [modules, showAllDepths]);
  const visibleBlocks = useMemo(
    () => visibleModules.flatMap((module) => module.blocks.map(({ block }) => block)),
    [visibleModules],
  );
  const assetPlacement = useMemo(
    () => placeLearningAssets(visibleLearningAssets, content.blocks),
    [content.blocks, visibleLearningAssets],
  );
  const sections = useMemo<ArticleSection[]>(
    () => visibleModules.map((module, moduleIndex) => ({
      id: textbookModuleDomId(module, moduleIndex),
      label: module.title,
    })),
    [visibleModules],
  );
  const [activeSectionId, setActiveSectionId] = useState(sections[0]?.id ?? "");
  const articleTocRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    const container = articleTocRef.current;
    const activeButton = container?.querySelector<HTMLElement>("[data-section-active='true']");
    if (!container || !activeButton) return;
    container.scrollTo({
      left: activeButton.offsetLeft - (container.clientWidth - activeButton.clientWidth) / 2,
      behavior: "smooth",
    });
  }, [activeSectionId]);

  const scrollToSection = (section: ArticleSection) => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const target = document.getElementById(section.id);
    const root = scrollRootRef.current;
    if (!target || !root) return;
    target.tabIndex = -1;
    if (!target.hasAttribute("aria-label")) target.setAttribute("aria-label", section.label);
    root.scrollTo({
      top: Math.max(
        0,
        root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top - 72,
      ),
      behavior: reducedMotion ? "auto" : "smooth",
    });
    setActiveSectionId(section.id);
    window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
  };

  const expressionTags = [
    point.difficulty || null,
    point.kind ? formatPointKind(point.kind) : null,
    viewMode !== "learning" && point.origin ? formatPointOrigin(point.origin) : null,
    animationAvailability === "available" ? "交互演示" : null,
  ].filter((tag): tag is string => Boolean(tag));

  const onAssetAvailabilityChange = useCallback((availability: AnimationAvailability) => {
    setAnimationAvailability((current) => {
      if (availability === "available" || current !== "available") return availability;
      return current;
    });
  }, []);

  return (
    <article className={`course-reader__article course-reader__article--textbook course-reader__article--view-${viewMode}`}>
      <header className="course-reader__heading">
        <div className="course-reader__tags">
          <span>{cluster?.title ?? course.title}</span>
          {point.subtitle && point.subtitle !== cluster?.title && <span>{point.subtitle}</span>}
          {expressionTags.map((tag) => <span key={tag}>{tag}</span>)}
        </div>
        <h1 ref={headingRef} id="course-point-title" tabIndex={-1}>{point.title}</h1>
        {point.shortSummary && <RichText content={point.shortSummary} className="course-reader__summary" />}
        <div className="course-reader__heading-meta" aria-label="知识点学习信息">
          <span>{usesCourseSequence ? "学习路径" : "本簇"}第 {Math.max(positionInCluster, 1)} / {clusterTotal || 1} 点</span>
          {learningDesign?.estimatedMinutes && <span>预计 {learningDesign.estimatedMinutes} 分钟</span>}
          {learningDesign?.adaptationLevel && (
            <span>{formatAdaptationLevel(learningDesign.adaptationLevel)}</span>
          )}
        </div>
      </header>

      {learningDesign && (
        <LearningDesignOverview
          design={learningDesign}
          prerequisites={point.prerequisites ?? []}
          allPoints={allPoints}
          showEditorialPolicy={viewMode !== "learning"}
        />
      )}

      <section className="course-reader__view-controls" aria-label="阅读视图">
        <div>
          <strong>阅读视图</strong>
          <span>{readerViewDescription(viewMode)}</span>
        </div>
        <div className="course-reader__view-actions">
          {viewMode === "learning" && (
            <div className="course-reader__depth-switcher" role="group" aria-label="学习内容深度">
              <span>学习深度</span>
              <div>
                {([
                  ["core", "核心阅读"],
                  ["full", "完整阅读"],
                ] as const).map(([mode, label]) => (
                  <button
                    type="button"
                    key={mode}
                    className={readingDepth === mode ? "is-current" : ""}
                    aria-pressed={readingDepth === mode}
                    onClick={() => setReadingDepth(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="course-reader__view-switcher" role="group" aria-label="切换阅读视图">
            {([
              ["learning", "学习"],
              ["comparison", "教材对照"],
              ["audit", "来源审计"],
            ] as const).map(([mode, label]) => (
              <button
                type="button"
                key={mode}
                className={viewMode === mode ? "is-current" : ""}
                aria-pressed={viewMode === mode}
                onClick={() => setViewMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {sections.length > 1 && (
        <nav className="course-reader__article-toc" aria-label="本文内容目录">
          <span>
            <ListTree aria-hidden="true" size={14} />
            本文内容
            <small>{Math.max(sections.findIndex((section) => section.id === activeSectionId) + 1, 1)}/{sections.length}</small>
          </span>
          <div ref={articleTocRef}>
            {sections.map((section) => (
              <button
                type="button"
                key={section.id}
                className={activeSectionId === section.id ? "is-current" : ""}
                data-section-active={activeSectionId === section.id}
                aria-current={activeSectionId === section.id ? "location" : undefined}
                onClick={() => scrollToSection(section)}
              >
                {section.label}
              </button>
            ))}
          </div>
        </nav>
      )}

      <div className="course-reader__content-modules">
        {visibleModules.map((module, moduleIndex) => {
          const showModuleHeading = module.explicit
            && normalizeComparableText(module.title)
              !== normalizeComparableText(module.blocks[0]?.block.title ?? "");
          return (
            <section
              key={`${module.id}-${moduleIndex}`}
              id={textbookModuleDomId(module, moduleIndex)}
              className={`course-reader__module course-reader__anchored-section ${module.explicit ? "is-designed" : "is-legacy"}`}
            >
              {showModuleHeading && (
                <header className="course-reader__module-head">
                  {module.role && <span>{formatLearningModuleRole(module.role)}</span>}
                  <h2>{module.title}</h2>
                  {module.description && <RichText content={module.description} />}
                </header>
              )}
              <div className="course-reader__module-content">
                {module.blocks.map(({ block, sourceIndex }) => (
                  <Fragment key={block.id}>
                    <TextbookContentBlockSection
                      block={block}
                      sourceIndex={sourceIndex}
                      allBlocks={content.blocks}
                      viewMode={viewMode}
                      nestedHeading={showModuleHeading}
                    />
                    {(assetPlacement.byAnchor.get(block.id) ?? []).map((asset) => (
                      <LearningAssetSection
                        key={asset.id}
                        asset={asset}
                        courseId={course.id}
                        pointTitle={point.title}
                        viewMode={viewMode}
                        onAvailabilityChange={onAssetAvailabilityChange}
                      />
                    ))}
                  </Fragment>
                ))}
              </div>
            </section>
          );
        })}
        {assetPlacement.unanchored.map((asset) => (
          <LearningAssetSection
            key={asset.id}
            asset={asset}
            courseId={course.id}
            pointTitle={point.title}
            viewMode={viewMode}
            onAvailabilityChange={onAssetAvailabilityChange}
          />
        ))}
        {visibleModules.length === 0 && (
          <div className="course-reader__content-empty" role="status">
            {content.blocks.length === 0
              ? "该知识点暂时没有可展示的教材正文，请返回知识森林选择其他知识点或重新生成内容。"
              : "该知识点暂时没有标记为核心的正文，可切换到完整阅读查看全部内容。"}
          </div>
        )}
      </div>

      {learningDesign && (
        <LearningCompletionCard
          design={learningDesign}
          blocks={visibleBlocks}
          allPoints={allPoints}
          onOpenPoint={onOpenPoint}
        />
      )}

      <div className="course-reader__reference-grid course-reader__reference-grid--textbook">
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
      </div>

      {learningAssets.length === 0 && hasLegacyAnimation && point.animationType && (
        <CourseAnimationFrame
          courseId={course.id}
          animationType={point.animationType}
          pointTitle={point.title}
          suggestion={point.animationSuggestion}
          onAvailabilityChange={setAnimationAvailability}
        />
      )}

      <PointNavigation
        clusterTitle={cluster?.title ?? course.title}
        previous={previous}
        next={next}
        position={positionInCluster}
        total={clusterTotal}
        usesCourseSequence={usesCourseSequence}
        onOpenPoint={onOpenPoint}
        footer
      />
    </article>
  );
}

function TextbookContentBlockSection({
  block,
  sourceIndex,
  allBlocks,
  viewMode,
  nestedHeading,
}: {
  block: TextbookContentBlock;
  sourceIndex: number;
  allBlocks: TextbookContentBlock[];
  viewMode: TextbookReaderView;
  nestedHeading: boolean;
}) {
  const isTextbook = block.provenance.origin === "textbook";
  const title = viewMode === "learning"
    ? learningBlockTitle(block)
    : block.title ?? textbookContentBlockKindLabel(block.kind);
  const semanticCard = isSemanticCardKind(block.kind);
  const Heading = nestedHeading ? "h3" : "h2";
  const normalizedMarkdown = normalizeTextbookMarkdown(block.markdown);
  const exerciseContent = block.kind === "exercise"
    ? splitTextbookExerciseReference(normalizedMarkdown)
    : null;
  const sourceSpans = block.provenance.sourceSpans ?? [];
  const basedOnBlocks: ContentBlockReference[] = block.provenance.origin === "model"
    ? block.provenance.basedOnBlockIds.map((id) => {
        const sourceIndex = allBlocks.findIndex((candidate) => candidate.id === id);
        const source = sourceIndex >= 0 ? allBlocks[sourceIndex] : undefined;
        return {
          id,
          label: source?.title ?? (source ? textbookContentBlockKindLabel(source.kind) : `未找到的依据块：${id}`),
          ...(source ? { domId: textbookBlockDomId(source, sourceIndex) } : {}),
        };
      })
    : [];
  return (
    <section
      id={textbookBlockDomId(block, sourceIndex)}
      className={[
        "course-reader__content-block",
        "course-reader__anchored-section",
        semanticCard ? "is-semantic-card" : "is-flow",
        `is-kind-${block.kind}`,
        viewMode !== "learning" ? (isTextbook ? "is-textbook" : "is-model") : "",
      ].filter(Boolean).join(" ")}
      data-content-kind={block.kind}
      data-learning-depth={block.depth}
    >
      <header className="course-reader__content-block-head">
        <div>
          {semanticCard && (
            <span className="course-reader__kind-badge">{textbookContentBlockKindLabel(block.kind)}</span>
          )}
          {block.depth && block.depth !== "core" && (
            <span className="course-reader__depth-badge">{formatLearningDepth(block.depth)}</span>
          )}
          {viewMode !== "learning" && (
            <span className={`course-reader__provenance-badge ${isTextbook ? "is-textbook" : "is-model"}`}>
              {isTextbook ? "教材依据" : "课程补充"}
            </span>
          )}
          {viewMode === "audit" && block.provenance.origin === "textbook" && (
            <span className="course-reader__representation-badge">
              {block.provenance.representation === "quote" ? "教材原文引用" : "教材内容转述"}
            </span>
          )}
          {viewMode === "audit" && !semanticCard && (
            <span className="course-reader__kind-badge">{textbookContentBlockKindLabel(block.kind)}</span>
          )}
        </div>
        <Heading>{title}</Heading>
      </header>
      <RichText
        content={exerciseContent?.prompt ?? normalizedMarkdown}
        className="course-reader__content-block-markdown"
      />
      {exerciseContent?.reference && (
        <details className="course-reader__exercise-reference">
          <summary>
            <span>查看参考思路</span>
            <ChevronDown aria-hidden="true" size={15} />
          </summary>
          <RichText content={exerciseContent.reference} />
        </details>
      )}
      {viewMode !== "learning" && (sourceSpans.length > 0 || basedOnBlocks.length > 0) && (
        <ContentProvenanceDisclosure
          sourceSpans={sourceSpans}
          basedOnBlocks={basedOnBlocks}
          isTextbook={isTextbook}
          showTechnical={viewMode === "audit"}
        />
      )}
    </section>
  );
}

function LearningAssetSection({
  asset,
  courseId,
  pointTitle,
  viewMode,
  onAvailabilityChange,
}: {
  asset: TextbookLearningAsset;
  courseId: string;
  pointTitle: string;
  viewMode: TextbookReaderView;
  onAvailabilityChange: (availability: AnimationAvailability) => void;
}) {
  const sectionId = learningAssetDomId(asset);
  if (asset.type === "quantization-lab") {
    const preset = isRecord(asset.config?.preset)
      ? asset.config?.preset as QuantizationLabPreset
      : undefined;
    return (
      <div id={sectionId} className="course-reader__learning-asset course-reader__anchored-section">
        <QuantizationLab
          asset={{
            ...(asset.title ? { title: asset.title } : {}),
            ...(asset.learningPurpose ? { learningPurpose: asset.learningPurpose } : {}),
            ...(preset ? { config: { preset } } : {}),
          }}
        />
        {viewMode === "audit" && asset.grounding && (
          <p className="course-reader__asset-grounding">
            学习资产依据：{asset.grounding.basedOnBlockIds.join("、")}
          </p>
        )}
      </div>
    );
  }
  if (asset.animationType) {
    return (
      <CourseAnimationFrame
        courseId={courseId}
        animationType={asset.animationType}
        pointTitle={pointTitle}
        sectionId={sectionId}
        heading={asset.title ?? learningAssetTypeLabel(asset.type)}
        suggestion={asset.learningPurpose ?? asset.caption ?? asset.fallback?.markdown}
        onAvailabilityChange={onAvailabilityChange}
      />
    );
  }
  return (
    <section id={sectionId} className="course-reader__learning-asset-card course-reader__anchored-section">
      <header>
        <span><Sparkles aria-hidden="true" size={14} />{learningAssetTypeLabel(asset.type)}</span>
        <h3>{asset.title ?? "学习活动"}</h3>
      </header>
      {asset.learningPurpose && <RichText content={asset.learningPurpose} />}
      {asset.fallback?.markdown && <RichText content={asset.fallback.markdown} />}
      {asset.caption && <RichText content={asset.caption} />}
      {viewMode === "audit" && asset.grounding && (
        <p className="course-reader__asset-grounding">
          学习资产依据：{asset.grounding.basedOnBlockIds.join("、")}
        </p>
      )}
    </section>
  );
}

function ContentProvenanceDisclosure({
  sourceSpans,
  basedOnBlocks,
  isTextbook,
  showTechnical,
}: {
  sourceSpans: ForestSourceSpan[];
  basedOnBlocks: ContentBlockReference[];
  isTextbook: boolean;
  showTechnical: boolean;
}) {
  const sourceCountLabel = [
    sourceSpans.length > 0 ? `${sourceSpans.length} 处教材定位` : "",
    basedOnBlocks.length > 0 ? `${basedOnBlocks.length} 个依据块` : "",
  ].filter(Boolean).join(" · ");

  const jumpToBlock = (domId: string) => {
    const target = document.getElementById(domId);
    if (!target) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.tabIndex = -1;
    target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
  };

  return (
    <details className="course-reader__source-disclosure">
      <summary>
        <span>{isTextbook ? "查看教材来源定位" : "查看模型扩展依据"}</span>
        <small>{sourceCountLabel}</small>
        <ChevronDown aria-hidden="true" size={15} />
      </summary>
      <div>
        {basedOnBlocks.length > 0 && (
          <div className="course-reader__based-on-blocks">
            <strong>扩展内容基于以下教材内容</strong>
            <div>
              {basedOnBlocks.map((source) => source.domId ? (
                <button
                  type="button"
                  key={source.id}
                  onClick={() => jumpToBlock(source.domId!)}
                  title="跳转到对应教材依据"
                >
                  {source.label}
                </button>
              ) : <span key={source.id}>{source.label}</span>)}
            </div>
          </div>
        )}
        {sourceSpans.length > 0 && (
          <ol className="course-reader__source-list">
            {sourceSpans.map((span, index) => (
              <li key={`${span.materialId}-${span.lineStart}-${span.lineEnd}-${index}`}>
                <strong>{textbookSourceHeading(span)}</strong>
                <span>{textbookSourceLocator(span)}</span>
                {showTechnical && <SourceTechnicalDetails span={span} />}
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

function SourceTechnicalDetails({ span }: { span: ForestSourceSpan }) {
  const details = textbookSourceTechnicalDetails(span);
  return (
    <details className="course-reader__source-technical">
      <summary>技术校验信息</summary>
      <dl>
        <div><dt>材料 ID</dt><dd><code>{details.materialId}</code></dd></div>
        <div><dt>原文块</dt><dd><code>{details.blockIds.join("、")}</code></dd></div>
        {details.assetRefs.length > 0 && (
          <div><dt>资源</dt><dd><code>{details.assetRefs.join("、")}</code></dd></div>
        )}
        <div><dt>内容 SHA-256</dt><dd><code>{details.excerptSha256}</code></dd></div>
      </dl>
    </details>
  );
}

function LegacyReadingArticle({
  point,
  cluster,
  course,
  allPoints,
  previous,
  next,
  positionInCluster,
  clusterTotal,
  usesCourseSequence,
  headingRef,
  scrollRootRef,
  onOpenPoint,
}: ReadingArticleProps) {
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
    const root = scrollRootRef.current;
    if (!target || !root) return;
    target.tabIndex = -1;
    if (!target.hasAttribute("aria-label")) target.setAttribute("aria-label", section.label);
    root.scrollTo({
      top: Math.max(
        0,
        root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top - 72,
      ),
      behavior: reducedMotion ? "auto" : "smooth",
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
        usesCourseSequence={usesCourseSequence}
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
          <span>{usesCourseSequence ? "学习路径" : "本簇"}第 {Math.max(positionInCluster, 1)} / {clusterTotal || 1} 点</span>
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
        usesCourseSequence={usesCourseSequence}
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
  usesCourseSequence,
  onOpenPoint,
  footer = false,
}: {
  clusterTitle: string;
  previous: ForestPoint | null;
  next: ForestPoint | null;
  position: number;
  total: number;
  usesCourseSequence: boolean;
  onOpenPoint: (point: ForestPoint) => void;
  footer?: boolean;
}) {
  return (
    <nav className={`course-reader__point-nav ${footer ? "course-reader__point-nav--footer" : ""}`} aria-label={footer ? "继续学习" : "知识点推进"}>
      <button type="button" disabled={!previous} onClick={() => previous && onOpenPoint(previous)}>
        <ChevronLeft aria-hidden="true" size={17} />
        <span>
          <small>上一个</small>
          <strong>{previous?.title ?? (usesCourseSequence ? "已是学习路径起点" : "已是本簇第一点")}</strong>
        </span>
      </button>
      <span>{usesCourseSequence ? "课程学习路径" : clusterTitle} · {Math.max(position, 1)}/{total || 1}</span>
      <button type="button" disabled={!next} onClick={() => next && onOpenPoint(next)}>
        <span>
          <small>下一个</small>
          <strong>{next?.title ?? (usesCourseSequence ? "已是学习路径终点" : "已是本簇最后一点")}</strong>
        </span>
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
  sectionId = "section-animation",
  heading = "交互演示",
  onAvailabilityChange,
}: {
  courseId: string;
  animationType: string;
  pointTitle: string;
  suggestion?: string;
  sectionId?: string;
  heading?: string;
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
        if (import.meta.env.DEV) console.warn("课程动画清单加载失败", reason);
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
        if (import.meta.env.DEV) console.warn("课程动画运行失败", event.data.message);
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
      if (import.meta.env.DEV) console.warn("课程动画启动超时", animationType);
      setStatus("error");
      onAvailabilityChange("unavailable");
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [onAvailabilityChange, status]);

  if (status === "unavailable") return null;
  if (status === "checking") {
    return (
      <section id={sectionId} className="course-reader__animation course-reader__animation--loading course-reader__anchored-section" aria-busy="true">
        <PlayCircle aria-hidden="true" size={18} />
        <span>正在检查{heading}…</span>
      </section>
    );
  }
  if (status === "error") {
    return (
      <section id={sectionId} className="course-reader__animation course-reader__animation--error course-reader__anchored-section" role="status">
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
    <figure id={sectionId} className={`course-reader__animation course-reader__anchored-section ${status === "loading" ? "is-runtime-loading" : ""}`} aria-label={`${pointTitle}${heading}`}>
      <div className="course-reader__animation-head">
        <span><PlayCircle aria-hidden="true" size={15} />{heading}</span>
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

function textbookBlockDomId(block: TextbookContentBlock, sourceIndex: number): string {
  const safeId = block.id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `section-textbook-content-${sourceIndex}-${safeId || "block"}`;
}

function textbookModuleDomId(module: TextbookReadingModule, moduleIndex: number): string {
  const safeId = module.id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `section-learning-module-${moduleIndex}-${safeId || "module"}`;
}

function learningAssetDomId(asset: TextbookLearningAsset): string {
  const safeId = asset.id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `section-learning-asset-${safeId || "asset"}`;
}

function learningBlockTitle(block: TextbookContentBlock): string {
  const title = block.title ?? textbookContentBlockKindLabel(block.kind);
  return title.replace(/^(?:模型补充|教材补充|教材内容)[：:]\s*/u, "") || title;
}

function isSemanticCardKind(kind: TextbookContentBlockKind): boolean {
  return new Set<TextbookContentBlockKind>([
    "definition",
    "example",
    "worked-example",
    "warning",
    "misconception",
    "exercise",
    "summary",
  ]).has(kind);
}

function readerViewDescription(view: TextbookReaderView): string {
  const descriptions: Record<TextbookReaderView, string> = {
    learning: "按教学模块连续阅读",
    comparison: "显示教材依据与课程补充",
    audit: "展开可核验的来源信息",
  };
  return descriptions[view];
}

function formatAdaptationLevel(level: NonNullable<TextbookLearningDesign["adaptationLevel"]>): string {
  const labels: Record<NonNullable<TextbookLearningDesign["adaptationLevel"]>, string> = {
    faithful: "忠实编排",
    balanced: "平衡重编",
    "teaching-first": "教学优先重编",
  };
  return labels[level];
}

function formatLearningDepth(depth: TextbookLearningDepth): string {
  const labels: Record<TextbookLearningDepth, string> = {
    core: "核心",
    support: "拓展理解",
    advanced: "进阶",
  };
  return labels[depth];
}

function formatLearningModuleRole(role: string): string {
  const labels: Record<string, string> = {
    orientation: "问题导入",
    "mental-model": "心智模型",
    explanation: "理解",
    formalization: "正式模型",
    "worked-example": "例题推演",
    application: "应用",
    decision: "设计取舍",
    diagnosis: "诊断与纠错",
    assessment: "练习",
    closure: "总结与衔接",
  };
  return labels[role] ?? role;
}

function learningAssetTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    animation: "动画演示",
    "interactive-simulation": "交互模拟",
    "quantization-lab": "量化互动实验",
    "step-diagram": "分步图解",
    figure: "图示",
    exercise: "互动练习",
  };
  return labels[type] ?? "学习活动";
}

function formatPointOrigin(origin: NonNullable<ForestPoint["origin"]>): string {
  const labels: Record<NonNullable<ForestPoint["origin"]>, string> = {
    textbook: "教材知识点",
    "llm-extension": "模型扩展知识点",
    user: "用户添加知识点",
  };
  return labels[origin];
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
  return normalizeForestIndex(payload);
}

function unwrapPointDetail(payload: unknown): CoursePointDetail | null {
  const candidate = isRecord(payload) && "point" in payload ? payload.point : payload;
  if (!isRecord(candidate) || typeof candidate.id !== "string") return null;
  return candidate as unknown as CoursePointDetail;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
