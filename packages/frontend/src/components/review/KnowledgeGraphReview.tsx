import { useMemo, useState, type FormEvent } from "react";
import {
  ArrowRight,
  CheckCircle2,
  GitBranch,
  Layers3,
  Link2,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import {
  findDependencyCycle,
  type DependencyEdge,
  type GraphReviewOperation,
  type ReviewResource,
} from "@/features/reviews/types";

type Props = {
  review: ReviewResource;
  disabled: boolean;
  readOnly: boolean;
  submitting: boolean;
  submitError: string;
  onSubmit: (operations: GraphReviewOperation[]) => void;
};

type AddedPrerequisite = DependencyEdge & { reason: string };

export function KnowledgeGraphReview({
  review,
  disabled,
  readOnly,
  submitting,
  submitError,
  onSubmit,
}: Props) {
  const [query, setQuery] = useState("");
  const [clusterChanges, setClusterChanges] = useState<Record<string, string[]>>({});
  const [removedReasons, setRemovedReasons] = useState<Record<string, string>>({});
  const [addedPrerequisites, setAddedPrerequisites] = useState<AddedPrerequisite[]>([]);
  const [pointId, setPointId] = useState("");
  const [prerequisiteId, setPrerequisiteId] = useState("");
  const [reason, setReason] = useState("");
  const [validationError, setValidationError] = useState("");
  const pointsById = useMemo(
    () => new Map(review.points.map((point) => [point.id, point])),
    [review.points],
  );
  const originalEdges = useMemo(
    () =>
      review.points.flatMap((point) =>
        point.prerequisites.map((prerequisiteId) => ({
          pointId: point.id,
          prerequisiteId,
        })),
      ),
    [review.points],
  );
  const originalEdgeKeys = useMemo(
    () => new Set(originalEdges.map((edge) => edgeKey(edge))),
    [originalEdges],
  );
  const relatedPairKeys = useMemo(
    () =>
      new Set(
        review.points.flatMap((point) =>
          point.related.map((relatedId) => pairKey(point.id, relatedId)),
        ),
      ),
    [review.points],
  );
  const finalEdges = useMemo(
    () => [
      ...originalEdges.filter((edge) => !(edgeKey(edge) in removedReasons)),
      ...addedPrerequisites,
    ],
    [addedPrerequisites, originalEdges, removedReasons],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visiblePoints = useMemo(
    () =>
      normalizedQuery
        ? review.points.filter((point) =>
            [point.id, point.title, ...point.clusterIds].some((value) =>
              value.toLocaleLowerCase("zh-CN").includes(normalizedQuery),
            ),
          )
        : review.points,
    [normalizedQuery, review.points],
  );
  const clusterOperations: GraphReviewOperation[] = review.points.flatMap((point) => {
    const next = clusterChanges[point.id];
    if (!next || sameStringSet(next, point.clusterIds)) return [];
    return [{ op: "set-clusters", point_id: point.id, cluster_ids: next }];
  });
  const prerequisiteOperations: GraphReviewOperation[] = [
    ...originalEdges.flatMap((edge): GraphReviewOperation[] => {
      const key = edgeKey(edge);
      if (!(key in removedReasons)) return [];
      return [{
        op: "remove-prerequisite",
        point_id: edge.pointId,
        prerequisite_id: edge.prerequisiteId,
        reason: removedReasons[key]?.trim() ?? "",
      }];
    }),
    ...addedPrerequisites.map((edge): GraphReviewOperation => ({
      op: "add-prerequisite",
      point_id: edge.pointId,
      prerequisite_id: edge.prerequisiteId,
      reason: edge.reason,
    })),
  ];
  const operations = [...clusterOperations, ...prerequisiteOperations];
  const missingCluster = Object.values(clusterChanges).some(
    (clusterIds) => clusterIds.length === 0,
  );
  const missingReason = Object.values(removedReasons).some(
    (value) => !value.trim(),
  );

  const toggleCluster = (targetPointId: string, clusterId: string) => {
    if (disabled) return;
    const point = pointsById.get(targetPointId);
    if (!point) return;
    setClusterChanges((current) => {
      const existing = current[targetPointId] ?? point.clusterIds;
      const next = existing.includes(clusterId)
        ? existing.filter((item) => item !== clusterId)
        : [...existing, clusterId];
      return { ...current, [targetPointId]: next };
    });
    setValidationError("");
  };

  const addPrerequisite = (event: FormEvent) => {
    event.preventDefault();
    const trimmedReason = reason.trim();
    if (!pointId || !prerequisiteId) {
      setValidationError("请选择依赖知识点和先修知识点");
      return;
    }
    if (pointId === prerequisiteId) {
      setValidationError("知识点不能依赖自身");
      return;
    }
    if (relatedPairKeys.has(pairKey(pointId, prerequisiteId))) {
      setValidationError(
        "这两个知识点已有只读 related 关系，不能同时添加 prerequisite",
      );
      return;
    }
    if (!trimmedReason || trimmedReason.length > 500) {
      setValidationError("新增原因需为 1 至 500 个字符");
      return;
    }
    const edge = { pointId, prerequisiteId };
    const key = edgeKey(edge);
    if (
      originalEdgeKeys.has(key) ||
      addedPrerequisites.some((item) => edgeKey(item) === key)
    ) {
      setValidationError("这条先修关系已经存在");
      return;
    }
    const cycle = findDependencyCycle(
      review.points.map((point) => point.id),
      [...finalEdges, edge],
    );
    if (cycle) {
      setValidationError(`这条关系会成环：${formatCycle(cycle, pointsById)}`);
      return;
    }
    setAddedPrerequisites((current) => [
      ...current,
      { ...edge, reason: trimmedReason },
    ]);
    setPointId("");
    setPrerequisiteId("");
    setReason("");
    setValidationError("");
  };

  const submit = () => {
    if (missingCluster) {
      setValidationError("每个知识点至少需要归属一个知识簇");
      return;
    }
    if (missingReason) {
      setValidationError("请为每条移除的先修关系填写原因");
      return;
    }
    const cycle = findDependencyCycle(
      review.points.map((point) => point.id),
      finalEdges,
    );
    if (cycle) {
      setValidationError(`当前先修关系存在环：${formatCycle(cycle, pointsById)}`);
      return;
    }
    setValidationError("");
    onSubmit(operations);
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 pb-28 pt-5 sm:px-6 lg:px-8">
      <section>
        <div className="flex items-center gap-2">
          <Layers3 className="h-4 w-4 text-primary" />
          <h2 className="text-lg font-semibold text-text-primary">知识簇</h2>
          <span className="text-xs text-text-secondary">
            支持一个知识点归属多个知识簇
          </span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {review.clusters.map((cluster) => {
            const count = review.points.filter((point) =>
              (clusterChanges[point.id] ?? point.clusterIds).includes(cluster.id),
            ).length;
            return (
              <article
                key={cluster.id}
                className="rounded-lg border border-border bg-surface p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <strong className="truncate text-sm text-text-primary">
                    {cluster.title}
                  </strong>
                  <span className="rounded bg-primary-light px-1.5 py-0.5 text-[10px] text-primary">
                    {count} 点
                  </span>
                </div>
                <code className="mt-1 block text-[10px] text-text-secondary">
                  {cluster.id}
                </code>
                {cluster.description && (
                  <p className="mt-2 line-clamp-2 text-xs leading-5 text-text-secondary">
                    {cluster.description}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section className="mt-7 border-t border-border pt-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">知识点图谱</h2>
            <p className="mt-1 text-sm text-text-secondary">
              同页核对知识簇、先修关系和只读 related 关系
            </p>
          </div>
          <label className="relative block w-full sm:w-72">
            <span className="sr-only">搜索知识点</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索知识点、ID 或知识簇"
              className="h-10 w-full rounded-md border border-border bg-surface pl-9 pr-3 text-sm outline-none focus:border-primary"
            />
          </label>
        </div>

        <div className="mt-4 space-y-3">
          {visiblePoints.map((point) => {
            const selectedClusters = clusterChanges[point.id] ?? point.clusterIds;
            const pointEdges = originalEdges.filter((edge) => edge.pointId === point.id);
            const addedEdges = addedPrerequisites.filter(
              (edge) => edge.pointId === point.id,
            );
            return (
              <article
                key={point.id}
                className="rounded-xl border border-border bg-surface p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary">
                      {point.title}
                    </h3>
                    <code className="text-[10px] text-text-secondary">{point.id}</code>
                  </div>
                  {point.role && (
                    <span className="rounded bg-cream-dark px-2 py-1 text-[10px] text-text-secondary">
                      {point.role}
                    </span>
                  )}
                </div>

                <fieldset className="mt-3">
                  <legend className="text-[11px] font-semibold text-text-secondary">
                    知识簇归属
                  </legend>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {review.clusters.map((cluster) => {
                      const checked = selectedClusters.includes(cluster.id);
                      return (
                        <label
                          key={cluster.id}
                          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${
                            checked
                              ? "border-primary/30 bg-primary-light text-primary"
                              : "border-border text-text-secondary"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled || readOnly}
                            onChange={() => toggleCluster(point.id, cluster.id)}
                            className="h-3 w-3 accent-primary"
                          />
                          {cluster.title}
                        </label>
                      );
                    })}
                  </div>
                  {selectedClusters.length === 0 && (
                    <p className="mt-1 text-[11px] text-error">
                      至少选择一个知识簇
                    </p>
                  )}
                </fieldset>

                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div>
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold text-text-secondary">
                      <GitBranch className="h-3.5 w-3.5 text-primary" />
                      prerequisites
                    </p>
                    <div className="mt-2 space-y-1.5">
                      {pointEdges.map((edge) => {
                        const key = edgeKey(edge);
                        const removed = key in removedReasons;
                        const prerequisite = pointsById.get(edge.prerequisiteId);
                        return (
                          <div
                            key={key}
                            className={`rounded-md border p-2.5 ${
                              removed
                                ? "border-error/25 bg-error/5"
                                : "border-border bg-cream/45"
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={`min-w-0 flex-1 truncate text-xs ${
                                  removed ? "line-through text-text-secondary" : ""
                                }`}
                              >
                                {prerequisite?.title ?? edge.prerequisiteId}
                              </span>
                              {!readOnly && (
                                <button
                                  type="button"
                                  disabled={disabled}
                                  onClick={() =>
                                    setRemovedReasons((current) => {
                                      if (!(key in current)) return { ...current, [key]: "" };
                                      const next = { ...current };
                                      delete next[key];
                                      return next;
                                    })
                                  }
                                  className="text-text-secondary hover:text-error disabled:opacity-45"
                                  aria-label={`${removed ? "恢复" : "移除"}先修关系`}
                                >
                                  {removed ? <RotateCcw className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                                </button>
                              )}
                            </div>
                            {removed && (
                              <input
                                value={removedReasons[key] ?? ""}
                                onChange={(event) =>
                                  setRemovedReasons((current) => ({
                                    ...current,
                                    [key]: event.target.value,
                                  }))
                                }
                                disabled={disabled}
                                maxLength={500}
                                placeholder="填写移除原因"
                                className="mt-2 h-8 w-full rounded border border-error/25 bg-surface px-2 text-xs outline-none"
                              />
                            )}
                          </div>
                        );
                      })}
                      {addedEdges.map((edge) => (
                        <div
                          key={`added:${edgeKey(edge)}`}
                          className="flex items-start gap-2 rounded-md border border-primary/25 bg-primary-light/45 p-2.5"
                        >
                          <Plus className="mt-0.5 h-3.5 w-3.5 text-primary" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs">
                              {pointsById.get(edge.prerequisiteId)?.title ??
                                edge.prerequisiteId}
                            </p>
                            <p className="mt-1 text-[10px] text-text-secondary">
                              {edge.reason}
                            </p>
                          </div>
                          {!readOnly && (
                            <button
                              type="button"
                              onClick={() =>
                                setAddedPrerequisites((current) =>
                                  current.filter((item) => edgeKey(item) !== edgeKey(edge)),
                                )
                              }
                              className="text-text-secondary hover:text-error"
                              aria-label="取消新增先修关系"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      ))}
                      {pointEdges.length === 0 && addedEdges.length === 0 && (
                        <p className="text-xs text-text-secondary">没有先修知识点</p>
                      )}
                    </div>
                  </div>

                  <div>
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold text-text-secondary">
                      <Link2 className="h-3.5 w-3.5" />
                      related（只读）
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {point.related.map((relatedId) => (
                        <span
                          key={relatedId}
                          className="rounded-full border border-border bg-cream px-2.5 py-1 text-[11px] text-text-secondary"
                        >
                          {pointsById.get(relatedId)?.title ?? relatedId}
                        </span>
                      ))}
                      {point.related.length === 0 && (
                        <span className="text-xs text-text-secondary">没有 related 关系</span>
                      )}
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {!readOnly && (
        <section className="mt-7 border-t border-border pt-5">
          <h2 className="text-sm font-semibold text-text-primary">新增先修关系</h2>
          <form onSubmit={addPrerequisite} className="mt-3 grid gap-3">
            <div className="grid items-end gap-2 md:grid-cols-[1fr_auto_1fr]">
              <label className="grid gap-1.5 text-xs text-text-secondary">
                先修知识点
                <select
                  value={prerequisiteId}
                  onChange={(event) => {
                    setPrerequisiteId(event.target.value);
                    setValidationError("");
                  }}
                  disabled={disabled}
                  className="h-10 min-w-0 rounded-md border border-border bg-surface px-3 text-sm"
                >
                  <option value="">请选择</option>
                  {review.points.map((point) => (
                    <option key={point.id} value={point.id}>
                      {point.title} ({point.id})
                    </option>
                  ))}
                </select>
              </label>
              <ArrowRight className="mb-3 hidden h-4 w-4 text-primary md:block" />
              <label className="grid gap-1.5 text-xs text-text-secondary">
                依赖方知识点
                <select
                  value={pointId}
                  onChange={(event) => {
                    setPointId(event.target.value);
                    setValidationError("");
                  }}
                  disabled={disabled}
                  className="h-10 min-w-0 rounded-md border border-border bg-surface px-3 text-sm"
                >
                  <option value="">请选择</option>
                  {review.points.map((point) => (
                    <option key={point.id} value={point.id}>
                      {point.title} ({point.id})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="grid gap-1.5 text-xs text-text-secondary">
              新增原因
              <textarea
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  setValidationError("");
                }}
                disabled={disabled}
                maxLength={500}
                rows={2}
                placeholder="说明这条先修关系的教学依据"
                className="resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm"
              />
            </label>
            <button
              type="submit"
              disabled={disabled || !pointId || !prerequisiteId || !reason.trim()}
              className="ml-auto inline-flex h-10 items-center gap-2 rounded-md border border-primary/30 px-4 text-sm font-semibold text-primary hover:bg-primary-light disabled:opacity-45"
            >
              <Plus className="h-4 w-4" />
              添加关系
            </button>
          </form>
        </section>
      )}

      <footer className="sticky bottom-0 z-20 -mx-4 mt-7 border-t border-border bg-surface/95 px-4 py-3 shadow-[0_-4px_16px_rgba(0,0,0,0.05)] backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-text-secondary">
            {readOnly
              ? "该审核已完成"
              : operations.length === 0
                ? "不修改，一键通过当前知识图谱"
                : `将提交 ${operations.length} 项变更`}
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={disabled || readOnly || missingCluster || missingReason}
            className="inline-flex h-10 min-w-44 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-45"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {submitting
              ? "正在提交"
              : operations.length === 0
                ? "一键通过并继续"
                : "确认变更并继续"}
          </button>
          {(validationError || submitError) && (
            <p className="w-full text-right text-xs text-error" role="alert">
              {validationError || submitError}
            </p>
          )}
        </div>
      </footer>
    </div>
  );
}

function edgeKey(edge: DependencyEdge) {
  return `${edge.pointId}\u0000${edge.prerequisiteId}`;
}

function sameStringSet(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
}

function pairKey(firstId: string, secondId: string) {
  return firstId < secondId
    ? `${firstId}\u0000${secondId}`
    : `${secondId}\u0000${firstId}`;
}

function formatCycle(
  cycle: string[],
  pointsById: Map<string, ReviewResource["points"][number]>,
) {
  return [...cycle]
    .reverse()
    .map((id) => pointsById.get(id)?.title ?? id)
    .join(" → ");
}
