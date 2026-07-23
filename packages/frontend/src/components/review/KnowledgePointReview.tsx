import { useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type {
  PointReviewOperation,
  ReviewIssue,
  ReviewResource,
} from "@/features/reviews/types";

type KnowledgePointReviewProps = {
  review: ReviewResource;
  disabled: boolean;
  readOnly: boolean;
  submitting: boolean;
  submitError: string;
  onSubmit: (operations: PointReviewOperation[]) => void;
};

type AddedPoint = {
  id: string;
  title: string;
};

const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function KnowledgePointReview({
  review,
  disabled,
  readOnly,
  submitting,
  submitError,
  onSubmit,
}: KnowledgePointReviewProps) {
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set());
  const [addedPoints, setAddedPoints] = useState<AddedPoint[]>([]);
  const [newId, setNewId] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [addError, setAddError] = useState("");
  const [query, setQuery] = useState("");
  const idInputRef = useRef<HTMLInputElement>(null);

  const originalIds = useMemo(() => new Set(review.points.map((point) => point.id)), [review.points]);
  const issuesByPoint = useMemo(() => {
    const grouped = new Map<string, ReviewIssue[]>();
    for (const point of review.points) {
      if (point.issues.length > 0) grouped.set(point.id, [...point.issues]);
    }
    for (const issue of review.review_queue) {
      if (!issue.pointId) continue;
      const current = grouped.get(issue.pointId) ?? [];
      if (!current.some((item) => issueSignature(item) === issueSignature(issue))) {
        grouped.set(issue.pointId, [...current, issue]);
      }
    }
    return grouped;
  }, [review.points, review.review_queue]);
  const unassignedIssues = useMemo(
    () => review.review_queue.filter((issue) => !issue.pointId),
    [review.review_queue],
  );

  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visiblePoints = useMemo(() => {
    if (!normalizedQuery) return review.points;
    return review.points.filter((point) => [point.title, point.id, ...point.keyTerms]
      .some((value) => value.toLocaleLowerCase("zh-CN").includes(normalizedQuery)));
  }, [normalizedQuery, review.points]);

  const retainedCount = review.points.length - deletedIds.size + addedPoints.length;
  const operations: PointReviewOperation[] = [
    ...review.points.flatMap((point): PointReviewOperation[] => (
      deletedIds.has(point.id) ? [{ op: "delete", point_id: point.id }] : []
    )),
    ...addedPoints.map((point): PointReviewOperation => ({ op: "add", point })),
  ];

  const toggleDeleted = (pointId: string) => {
    if (disabled) return;
    setDeletedIds((current) => {
      const next = new Set(current);
      if (next.has(pointId)) next.delete(pointId);
      else next.add(pointId);
      return next;
    });
  };

  const addPoint = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    const id = newId.trim();
    const title = newTitle.trim();
    if (!KEBAB_ID.test(id)) {
      setAddError("知识点 ID 需使用小写英文、数字和连字符");
      idInputRef.current?.focus();
      return;
    }
    if (!title || title.length > 160) {
      setAddError("知识点名称需为 1 至 160 个字符");
      return;
    }
    if (originalIds.has(id) || addedPoints.some((point) => point.id === id)) {
      setAddError("该知识点 ID 已存在");
      idInputRef.current?.focus();
      return;
    }
    setAddedPoints((current) => [...current, { id, title }]);
    setNewId("");
    setNewTitle("");
    setAddError("");
    window.requestAnimationFrame(() => idInputRef.current?.focus());
  };

  const submit = () => {
    if (disabled) return;
    if (retainedCount < 1) return;
    onSubmit(operations);
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 pb-28 pt-5 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">完整知识点清单</h2>
          <p className="mt-1 text-sm text-text-secondary">
            保留 {retainedCount} 个 · 删除 {deletedIds.size} 个 · 新增 {addedPoints.length} 个
          </p>
        </div>
        <label className="relative block w-full sm:w-72">
          <span className="sr-only">搜索知识点</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称、ID 或关键词"
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

      {unassignedIssues.length > 0 && (
        <section aria-labelledby="unassigned-review-heading" className="mt-4 rounded-lg border border-warning/35 bg-amber-50/60 px-4 py-3">
          <h2 id="unassigned-review-heading" className="flex items-center gap-2 text-sm font-semibold text-amber-800">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            还有 {unassignedIssues.length} 项范围问题
          </h2>
          <div className="mt-2 divide-y divide-warning/20">
            {unassignedIssues.map((issue, index) => (
              <div key={`${issueSignature(issue)}-${index}`} className="py-2 text-xs leading-5 text-text-secondary">
                <span className="font-medium text-text-primary">{issue.term || issueLabel(issue.issue)}</span>
                {issue.reason && <span> · {issue.reason}</span>}
                {issue.suggestedAction && <span className="block">建议：{issue.suggestedAction}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="mt-4 space-y-2" aria-live="polite">
        {visiblePoints.map((point, index) => {
          const deleted = deletedIds.has(point.id);
          const issues = issuesByPoint.get(point.id) ?? [];
          return (
            <article
              key={point.id}
              className={`rounded-lg border bg-surface transition-colors ${
                deleted ? "border-error/25 bg-error/5" : issues.length > 0 ? "border-warning/35" : "border-border"
              }`}
            >
              <div className="flex items-start gap-3 p-3.5 sm:p-4">
                <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md text-xs font-semibold ${
                  deleted ? "bg-error/10 text-error" : "bg-primary-light text-primary"
                }`} aria-hidden="true">
                  {deleted ? <X className="h-3.5 w-3.5" /> : index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h3 className={`text-sm font-semibold ${deleted ? "text-text-secondary line-through" : "text-text-primary"}`}>
                      {point.title}
                    </h3>
                    <code className="break-all text-[11px] text-text-secondary">{point.id}</code>
                    <PointMetadata point={point} />
                  </div>
                  {point.shortSummary && (
                    <p className={`mt-1.5 text-xs leading-5 ${deleted ? "text-text-secondary/65" : "text-text-secondary"}`}>
                      {point.shortSummary}
                    </p>
                  )}
                  {issues.length > 0 && !deleted && (
                    <div className="mt-3 border-l-2 border-warning/55 pl-3">
                      {issues.map((issue, issueIndex) => (
                        <div key={`${issueSignature(issue)}-${issueIndex}`} className="py-0.5 text-xs leading-5 text-text-secondary">
                          <span className="font-medium text-amber-700">{issueLabel(issue.issue)}</span>
                          {issue.reason && <span> · {issue.reason}</span>}
                          {issue.suggestedAction && <span className="block text-text-secondary/85">建议：{issue.suggestedAction}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => toggleDeleted(point.id)}
                    disabled={disabled}
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                      deleted
                        ? "border-primary/25 bg-primary-light text-primary hover:bg-primary/15"
                        : "border-border text-text-secondary hover:border-error/30 hover:bg-error/5 hover:text-error"
                    }`}
                    title={deleted ? "恢复知识点" : "删除知识点"}
                    aria-label={`${deleted ? "恢复" : "删除"}知识点：${point.title}`}
                  >
                    {deleted ? <RotateCcw className="h-4 w-4" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
                  </button>
                )}
              </div>
            </article>
          );
        })}

        {visiblePoints.length === 0 && (
          <div className="grid min-h-32 place-items-center rounded-lg border border-dashed border-border bg-surface text-sm text-text-secondary">
            没有匹配的知识点
          </div>
        )}
      </div>

      {addedPoints.length > 0 && (
        <section aria-labelledby="added-points-heading" className="mt-7">
          <div className="mb-3 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden="true" />
            <h2 id="added-points-heading" className="text-sm font-semibold text-text-primary">待新增知识点</h2>
          </div>
          <div className="space-y-2">
            {addedPoints.map((point) => (
              <div key={point.id} className="flex items-center gap-3 rounded-lg border border-primary/25 bg-primary-light/45 px-4 py-3">
                <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-text-primary">{point.title}</p>
                  <code className="block break-all text-[11px] text-text-secondary">{point.id}</code>
                </div>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => setAddedPoints((current) => current.filter((item) => item.id !== point.id))}
                    disabled={disabled}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-text-secondary hover:bg-error/10 hover:text-error disabled:cursor-not-allowed disabled:opacity-45"
                    title="移除新增知识点"
                    aria-label={`移除新增知识点：${point.title}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {!readOnly && (
        <section aria-labelledby="add-point-heading" className="mt-7 border-t border-border pt-5">
          <h2 id="add-point-heading" className="text-sm font-semibold text-text-primary">新增知识点</h2>
          <form onSubmit={addPoint} className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] sm:items-start">
            <label className="grid gap-1.5 text-xs font-medium text-text-secondary">
              知识点 ID
              <input
                ref={idInputRef}
                value={newId}
                onChange={(event) => {
                  setNewId(event.target.value);
                  setAddError("");
                }}
                disabled={disabled}
                maxLength={100}
                placeholder="gradient-descent"
                aria-describedby={addError ? "add-point-error" : undefined}
                aria-invalid={Boolean(addError)}
                className="h-10 rounded-md border border-border bg-surface px-3 font-mono text-sm font-normal text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:bg-cream-dark"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-text-secondary">
              知识点名称
              <input
                value={newTitle}
                onChange={(event) => {
                  setNewTitle(event.target.value);
                  setAddError("");
                }}
                disabled={disabled}
                maxLength={160}
                placeholder="梯度下降"
                aria-describedby={addError ? "add-point-error" : undefined}
                aria-invalid={Boolean(addError)}
                className="h-10 rounded-md border border-border bg-surface px-3 text-sm font-normal text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:bg-cream-dark"
              />
            </label>
            <button
              type="submit"
              disabled={disabled || !newId.trim() || !newTitle.trim()}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-primary/30 bg-surface px-4 text-sm font-semibold text-primary hover:bg-primary-light disabled:cursor-not-allowed disabled:opacity-45 sm:mt-[22px]"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              添加
            </button>
          </form>
          {addError && (
            <p id="add-point-error" className="mt-2 flex items-center gap-1.5 text-xs text-error" role="alert">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              {addError}
            </p>
          )}
        </section>
      )}

      <div className="sticky bottom-0 z-20 -mx-4 mt-7 border-t border-border bg-surface/95 px-4 py-3 shadow-[0_-4px_16px_rgba(0,0,0,0.05)] backdrop-blur-sm sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-text-secondary" aria-live="polite">
            {readOnly
              ? "该审核已完成"
              : operations.length === 0
                ? `确认当前 ${review.points.length} 个知识点`
                : `将提交 ${operations.length} 项变更`}
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={disabled || readOnly || retainedCount < 1}
            className="inline-flex h-10 min-w-40 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-white shadow-sm hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-45"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
            {submitting ? "正在提交" : "确认并继续生成"}
          </button>
          {retainedCount < 1 && (
            <p className="w-full text-right text-xs text-error" role="alert">至少需要保留或新增一个知识点</p>
          )}
          {submitError && <p className="w-full text-right text-xs text-error" role="alert">{submitError}</p>}
        </div>
      </div>
    </div>
  );
}

function PointMetadata({ point }: { point: ReviewResource["points"][number] }) {
  const labels = [
    point.kind ? kindLabel(point.kind) : null,
    point.scopeStatus ? scopeLabel(point.scopeStatus) : null,
    typeof point.confidence === "number" ? `置信度 ${Math.round(point.confidence * 100)}%` : null,
    point.difficulty || null,
  ].filter((value): value is string => Boolean(value));
  if (labels.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1 text-[10px] text-text-secondary">
      {labels.map((label, index) => <span key={`${label}:${index}`} className="rounded bg-cream-dark px-1.5 py-0.5">{label}</span>)}
    </span>
  );
}

function issueSignature(issue: ReviewIssue) {
  return [issue.pointId, issue.issue, issue.term, issue.reason, issue.suggestedAction].join("\u0000");
}

function issueLabel(value?: string) {
  const labels: Record<string, string> = {
    "scope-ambiguity": "范围待确认",
    granularity: "粒度待确认",
    synonym: "同义项待确认",
    naming: "命名待确认",
    "insufficient-evidence": "证据不足",
  };
  return value ? labels[value] ?? value : "待复核";
}

function kindLabel(value: string) {
  const labels: Record<string, string> = {
    concept: "概念",
    method: "方法",
    theorem: "定理",
    model: "模型",
    algorithm: "算法",
    task: "任务",
    metric: "指标",
    phenomenon: "现象",
  };
  return labels[value] ?? value;
}

function scopeLabel(value: string) {
  const labels: Record<string, string> = {
    core: "核心范围",
    boundary: "边界范围",
    "needs-review": "待复核",
  };
  return labels[value] ?? value;
}
