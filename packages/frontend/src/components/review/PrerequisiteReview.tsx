import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  GitBranch,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type {
  DependencyReviewOperation,
  ReviewEdge,
  ReviewResource,
} from "@/features/reviews/types";
import { relatedPairKey } from "@/features/reviews/types";

type PrerequisiteReviewProps = {
  review: ReviewResource;
  disabled: boolean;
  readOnly: boolean;
  submitting: boolean;
  submitError: string;
  onSubmit: (operations: DependencyReviewOperation[]) => void;
};

type AddedEdge = ReviewEdge;

export function PrerequisiteReview({
  review,
  disabled,
  readOnly,
  submitting,
  submitError,
  onSubmit,
}: PrerequisiteReviewProps) {
  const [removedReasons, setRemovedReasons] = useState<Record<string, string>>({});
  const [addedEdges, setAddedEdges] = useState<AddedEdge[]>([]);
  const [prerequisiteId, setPrerequisiteId] = useState("");
  const [dependentId, setDependentId] = useState("");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState("");
  const [submitValidationError, setSubmitValidationError] = useState("");
  const [query, setQuery] = useState("");

  const pointsById = useMemo(
    () => new Map(review.points.map((point) => [point.id, point])),
    [review.points],
  );
  const originalKeys = useMemo(
    () => new Set(review.edges.map((edge) => edgeKey(edge.dependentId, edge.prerequisiteId))),
    [review.edges],
  );
  const restrictedRelatedKeys = useMemo(
    () => new Set(review.related_pairs.map((pair) => relatedPairKey(pair.firstId, pair.secondId))),
    [review.related_pairs],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleEdges = useMemo(() => {
    if (!normalizedQuery) return review.edges;
    return review.edges.filter((edge) => edgeSearchText(edge, pointsById).includes(normalizedQuery));
  }, [normalizedQuery, pointsById, review.edges]);
  const visibleAddedEdges = useMemo(() => {
    if (!normalizedQuery) return addedEdges;
    return addedEdges.filter((edge) => edgeSearchText(edge, pointsById).includes(normalizedQuery));
  }, [addedEdges, normalizedQuery, pointsById]);

  const finalEdges = useMemo(() => [
    ...review.edges.filter((edge) => !(edgeKey(edge.dependentId, edge.prerequisiteId) in removedReasons)),
    ...addedEdges,
  ], [addedEdges, removedReasons, review.edges]);
  const removedCount = Object.keys(removedReasons).length;
  const missingRemovalReason = Object.values(removedReasons).some((value) => !value.trim());
  const selectedRelatedConflict = Boolean(
    prerequisiteId
    && dependentId
    && restrictedRelatedKeys.has(relatedPairKey(prerequisiteId, dependentId)),
  );
  const displayedFormError = selectedRelatedConflict
    ? "这两个知识点已有 related 关系；当前审核只能修改 prerequisites，不能同时保留两种关系"
    : formError;
  const operations: DependencyReviewOperation[] = [
    ...review.edges.flatMap((edge): DependencyReviewOperation[] => {
      const key = edgeKey(edge.dependentId, edge.prerequisiteId);
      if (!(key in removedReasons)) return [];
      return [{
        op: "remove",
        dependent_id: edge.dependentId,
        prerequisite_id: edge.prerequisiteId,
        reason: removedReasons[key]?.trim() ?? "",
      }];
    }),
    ...addedEdges.map((edge): DependencyReviewOperation => ({
      op: "add",
      dependent_id: edge.dependentId,
      prerequisite_id: edge.prerequisiteId,
      reason: edge.reason.trim(),
    })),
  ];

  const markRemoved = (edge: ReviewEdge) => {
    if (disabled) return;
    const key = edgeKey(edge.dependentId, edge.prerequisiteId);
    setRemovedReasons((current) => ({ ...current, [key]: "" }));
    setSubmitValidationError("");
  };

  const restoreEdge = (edge: ReviewEdge) => {
    const key = edgeKey(edge.dependentId, edge.prerequisiteId);
    setRemovedReasons((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setSubmitValidationError("");
  };

  const addEdge = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    const trimmedReason = reason.trim();
    if (!prerequisiteId || !dependentId) {
      setFormError("请选择先修知识点和后续知识点");
      return;
    }
    if (prerequisiteId === dependentId) {
      setFormError("知识点不能依赖自身");
      return;
    }
    if (restrictedRelatedKeys.has(relatedPairKey(prerequisiteId, dependentId))) {
      setFormError("这两个知识点已有 related 关系；当前审核只能修改 prerequisites，不能同时保留两种关系");
      return;
    }
    if (!trimmedReason || trimmedReason.length > 500) {
      setFormError("变更原因需为 1 至 500 个字符");
      return;
    }
    const key = edgeKey(dependentId, prerequisiteId);
    if (originalKeys.has(key) || addedEdges.some((edge) => edgeKey(edge.dependentId, edge.prerequisiteId) === key)) {
      setFormError("这条先修关系已经存在");
      return;
    }
    const candidate = [...finalEdges, { dependentId, prerequisiteId, reason: trimmedReason }];
    const cycle = findDependencyCycle(review.points.map((point) => point.id), candidate);
    if (cycle) {
      setFormError(`该关系会形成环：${formatCycle(cycle, pointsById)}`);
      return;
    }
    setAddedEdges((current) => [...current, { dependentId, prerequisiteId, reason: trimmedReason }]);
    setPrerequisiteId("");
    setDependentId("");
    setReason("");
    setFormError("");
    setSubmitValidationError("");
  };

  const submit = () => {
    if (disabled) return;
    if (missingRemovalReason) {
      setSubmitValidationError("请为每条移除操作填写原因");
      return;
    }
    const cycle = findDependencyCycle(review.points.map((point) => point.id), finalEdges);
    if (cycle) {
      setSubmitValidationError(`当前关系会形成环：${formatCycle(cycle, pointsById)}`);
      return;
    }
    setSubmitValidationError("");
    onSubmit(operations);
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 pb-28 pt-5 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">完整先修关系</h2>
          <p className="mt-1 text-sm text-text-secondary">
            最终 {finalEdges.length} 条 · 移除 {removedCount} 条 · 新增 {addedEdges.length} 条
          </p>
        </div>
        <label className="relative block w-full sm:w-72">
          <span className="sr-only">搜索先修关系</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索知识点名称或 ID"
            className="h-10 w-full rounded-md border border-border bg-surface pl-9 pr-9 text-sm outline-none transition-colors placeholder:text-text-secondary/65 focus:border-primary focus:ring-2 focus:ring-primary/15"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-text-secondary hover:bg-cream-dark hover:text-text-primary"
              title="清除搜索"
              aria-label="清除搜索"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </label>
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs text-text-secondary">
        <span className="font-medium text-primary">先修知识点</span>
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="font-medium text-text-primary">后续知识点</span>
      </div>

      <section aria-label="现有先修关系" className="mt-3 space-y-2">
        {visibleEdges.map((edge) => {
          const key = edgeKey(edge.dependentId, edge.prerequisiteId);
          const removed = key in removedReasons;
          return (
            <article
              key={key}
              className={`rounded-lg border bg-surface p-3.5 transition-colors sm:p-4 ${
                removed ? "border-error/25 bg-error/5" : "border-border"
              }`}
            >
              <div className="flex items-start gap-3">
                <GitBranch className={`mt-1 h-4 w-4 shrink-0 ${removed ? "text-error" : "text-primary"}`} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <EdgeDirection edge={edge} pointsById={pointsById} removed={removed} />
                  {edge.reason && !removed && (
                    <p className="mt-2 text-xs leading-5 text-text-secondary">{edge.reason}</p>
                  )}
                  {removed && (
                    <label className="mt-3 grid gap-1.5 text-xs font-medium text-error">
                      移除原因
                      <textarea
                        value={removedReasons[key] ?? ""}
                        onChange={(event) => {
                          const nextReason = event.target.value;
                          setRemovedReasons((current) => ({ ...current, [key]: nextReason }));
                          setSubmitValidationError("");
                        }}
                        disabled={disabled}
                        maxLength={500}
                        rows={2}
                        required
                        aria-label="移除原因"
                        aria-invalid={!removedReasons[key]?.trim()}
                        className="min-h-16 resize-y rounded-md border border-error/25 bg-surface px-3 py-2 text-sm font-normal leading-5 text-text-primary outline-none focus:border-error focus:ring-2 focus:ring-error/10 disabled:bg-cream-dark"
                        placeholder="说明为什么移除这条先修关系"
                      />
                      <span className="text-right text-[10px] font-normal text-text-secondary">
                        {(removedReasons[key] ?? "").length}/500
                      </span>
                    </label>
                  )}
                </div>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => removed ? restoreEdge(edge) : markRemoved(edge)}
                    disabled={disabled}
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                      removed
                        ? "border-primary/25 bg-primary-light text-primary hover:bg-primary/15"
                        : "border-border text-text-secondary hover:border-error/30 hover:bg-error/5 hover:text-error"
                    }`}
                    title={removed ? "恢复先修关系" : "移除先修关系"}
                    aria-label={`${removed ? "恢复" : "移除"}先修关系：${edgeLabel(edge, pointsById)}`}
                  >
                    {removed ? <RotateCcw className="h-4 w-4" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
                  </button>
                )}
              </div>
            </article>
          );
        })}

        {visibleAddedEdges.map((edge) => (
          <article key={`added:${edgeKey(edge.dependentId, edge.prerequisiteId)}`} className="rounded-lg border border-primary/30 bg-primary-light/45 p-3.5 sm:p-4">
            <div className="flex items-start gap-3">
              <Plus className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <EdgeDirection edge={edge} pointsById={pointsById} />
                <p className="mt-2 text-xs leading-5 text-text-secondary">{edge.reason}</p>
              </div>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => setAddedEdges((current) => current.filter((item) => edgeKey(item.dependentId, item.prerequisiteId) !== edgeKey(edge.dependentId, edge.prerequisiteId)))}
                  disabled={disabled}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-text-secondary hover:bg-error/10 hover:text-error disabled:cursor-not-allowed disabled:opacity-45"
                  title="取消新增关系"
                  aria-label={`取消新增先修关系：${edgeLabel(edge, pointsById)}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          </article>
        ))}

        {visibleEdges.length === 0 && visibleAddedEdges.length === 0 && (
          <div className="grid min-h-32 place-items-center rounded-lg border border-dashed border-border bg-surface text-sm text-text-secondary">
            {query ? "没有匹配的先修关系" : "当前没有先修关系"}
          </div>
        )}
      </section>

      {review.broken_cycle_edges.length > 0 && (
        <details className="mt-6 rounded-lg border border-warning/30 bg-amber-50/60 px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold text-amber-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
            生成阶段已移除 {review.broken_cycle_edges.length} 条成环关系
          </summary>
          <div className="mt-3 space-y-2 border-t border-warning/20 pt-3">
            {review.broken_cycle_edges.map((edge, index) => (
              <div key={`${edgeKey(edge.dependentId, edge.prerequisiteId)}:${index}`} className="text-xs text-text-secondary">
                <EdgeDirection edge={edge} pointsById={pointsById} removed />
                {edge.reason && <p className="mt-1 leading-5">{edge.reason}</p>}
              </div>
            ))}
          </div>
        </details>
      )}

      {!readOnly && (
        <section aria-labelledby="add-edge-heading" className="mt-7 border-t border-border pt-5">
          <h2 id="add-edge-heading" className="text-sm font-semibold text-text-primary">新增先修关系</h2>
          <form onSubmit={addEdge} className="mt-3 grid gap-3">
            <div className="grid items-end gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
              <label className="grid min-w-0 gap-1.5 text-xs font-medium text-text-secondary">
                先修知识点
                <select
                  value={prerequisiteId}
                  onChange={(event) => {
                    setPrerequisiteId(event.target.value);
                    setFormError("");
                  }}
                  disabled={disabled}
                  aria-invalid={selectedRelatedConflict}
                  aria-describedby={displayedFormError ? "add-edge-error" : undefined}
                  className="h-10 min-w-0 rounded-md border border-border bg-surface px-3 text-sm font-normal text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:bg-cream-dark"
                >
                  <option value="">选择先修知识点</option>
                  {review.points.map((point) => <option key={point.id} value={point.id}>{point.title} ({point.id})</option>)}
                </select>
              </label>
              <ArrowRight className="mb-3 hidden h-4 w-4 text-primary md:block" aria-label="先修于" />
              <label className="grid min-w-0 gap-1.5 text-xs font-medium text-text-secondary">
                后续知识点
                <select
                  value={dependentId}
                  onChange={(event) => {
                    setDependentId(event.target.value);
                    setFormError("");
                  }}
                  disabled={disabled}
                  aria-invalid={selectedRelatedConflict}
                  aria-describedby={displayedFormError ? "add-edge-error" : undefined}
                  className="h-10 min-w-0 rounded-md border border-border bg-surface px-3 text-sm font-normal text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:bg-cream-dark"
                >
                  <option value="">选择后续知识点</option>
                  {review.points.map((point) => <option key={point.id} value={point.id}>{point.title} ({point.id})</option>)}
                </select>
              </label>
            </div>
            <label className="grid gap-1.5 text-xs font-medium text-text-secondary">
              新增原因
              <textarea
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  setFormError("");
                }}
                disabled={disabled}
                maxLength={500}
                rows={2}
                required
                aria-label="新增原因"
                aria-invalid={Boolean(displayedFormError)}
                aria-describedby={displayedFormError ? "add-edge-error" : undefined}
                className="min-h-16 resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm font-normal leading-5 text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:bg-cream-dark"
                placeholder="说明新增这条先修关系的依据"
              />
              <span className="text-right text-[10px] font-normal text-text-secondary">{reason.length}/500</span>
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                {displayedFormError && (
                  <p id="add-edge-error" className="flex items-center gap-1.5 text-xs text-error" role="alert">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                    {displayedFormError}
                  </p>
                )}
              </div>
              <button
                type="submit"
                disabled={disabled || !prerequisiteId || !dependentId || !reason.trim() || selectedRelatedConflict}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-primary/30 bg-surface px-4 text-sm font-semibold text-primary hover:bg-primary-light disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                添加关系
              </button>
            </div>
          </form>
        </section>
      )}

      <div className="sticky bottom-0 z-20 -mx-4 mt-7 border-t border-border bg-surface/95 px-4 py-3 shadow-[0_-4px_16px_rgba(0,0,0,0.05)] backdrop-blur-sm sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-text-secondary" aria-live="polite">
            {readOnly
              ? "该审核已完成"
              : operations.length === 0
                ? `确认当前 ${review.edges.length} 条先修关系`
                : `将提交 ${operations.length} 项变更`}
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={disabled || readOnly || missingRemovalReason}
            className="inline-flex h-10 min-w-40 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-white shadow-sm hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-45"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
            {submitting ? "正在提交" : "确认并继续生成"}
          </button>
          {(submitValidationError || submitError) && (
            <p className="w-full text-right text-xs text-error" role="alert">{submitValidationError || submitError}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function EdgeDirection({
  edge,
  pointsById,
  removed = false,
}: {
  edge: ReviewEdge;
  pointsById: Map<string, ReviewResource["points"][number]>;
  removed?: boolean;
}) {
  const prerequisite = pointsById.get(edge.prerequisiteId);
  const dependent = pointsById.get(edge.dependentId);
  return (
    <div className={`grid min-w-0 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] ${removed ? "opacity-65" : ""}`}>
      <PointReference title={prerequisite?.title ?? edge.prerequisiteId} id={edge.prerequisiteId} removed={removed} />
      <ArrowRight className="h-4 w-4 shrink-0 text-primary max-sm:rotate-90" aria-hidden="true" />
      <PointReference title={dependent?.title ?? edge.dependentId} id={edge.dependentId} removed={removed} />
    </div>
  );
}

function PointReference({ title, id, removed }: { title: string; id: string; removed: boolean }) {
  return (
    <div className={`min-w-0 ${removed ? "line-through" : ""}`}>
      <p className="truncate text-sm font-semibold text-text-primary">{title}</p>
      <code className="block truncate text-[10px] text-text-secondary">{id}</code>
    </div>
  );
}

function edgeKey(dependentId: string, prerequisiteId: string) {
  return `${dependentId}\u0000${prerequisiteId}`;
}

function edgeLabel(edge: ReviewEdge, pointsById: Map<string, ReviewResource["points"][number]>) {
  const prerequisite = pointsById.get(edge.prerequisiteId)?.title ?? edge.prerequisiteId;
  const dependent = pointsById.get(edge.dependentId)?.title ?? edge.dependentId;
  return `${prerequisite} 到 ${dependent}`;
}

function edgeSearchText(edge: ReviewEdge, pointsById: Map<string, ReviewResource["points"][number]>) {
  return [
    edge.prerequisiteId,
    edge.dependentId,
    pointsById.get(edge.prerequisiteId)?.title,
    pointsById.get(edge.dependentId)?.title,
  ].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
}

function formatCycle(cycle: string[], pointsById: Map<string, ReviewResource["points"][number]>) {
  return [...cycle].reverse().map((id) => pointsById.get(id)?.title ?? id).join(" → ");
}

export function findDependencyCycle(pointIds: string[], edges: ReviewEdge[]) {
  const adjacency = new Map(pointIds.map((pointId) => [pointId, [] as string[]]));
  for (const edge of edges) adjacency.get(edge.dependentId)?.push(edge.prerequisiteId);
  const state = new Map<string, number>();
  const stack: string[] = [];
  const positions = new Map<string, number>();

  const visit = (pointId: string): string[] | null => {
    state.set(pointId, 1);
    positions.set(pointId, stack.length);
    stack.push(pointId);
    for (const prerequisite of adjacency.get(pointId) ?? []) {
      if ((state.get(prerequisite) ?? 0) === 0) {
        const cycle = visit(prerequisite);
        if (cycle) return cycle;
      } else if (state.get(prerequisite) === 1) {
        const start = positions.get(prerequisite) ?? 0;
        return [...stack.slice(start), prerequisite];
      }
    }
    stack.pop();
    positions.delete(pointId);
    state.set(pointId, 2);
    return null;
  };

  for (const pointId of pointIds) {
    if ((state.get(pointId) ?? 0) === 0) {
      const cycle = visit(pointId);
      if (cycle) return cycle;
    }
  }
  return null;
}
