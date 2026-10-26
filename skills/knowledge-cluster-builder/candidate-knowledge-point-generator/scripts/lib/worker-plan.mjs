// worker 波次调度的共享规则：prepare-*-tasks 写计划，草稿校验报告按同一并发数提示队首占位。

export const DEFAULT_WORKER_CONCURRENCY = 10;
export const MAX_WORKER_CONCURRENCY = 32;

// 计划文件中单行 ID 列表的字符预算；read 工具单行上限 2000 字符，留足缩进和余量。
const PLAN_LINE_BUDGET = 960;

export function resolveWorkerConcurrency(env = process.env) {
  const raw = env?.COURSE_WORKER_CONCURRENCY;
  if (raw === undefined || raw === '') {
    return { concurrency: DEFAULT_WORKER_CONCURRENCY, warning: null };
  }
  const text = String(raw).trim();
  if (/^[0-9]+$/.test(text)) {
    const value = Number(text);
    if (value >= 1 && value <= MAX_WORKER_CONCURRENCY) {
      return { concurrency: value, warning: null };
    }
  }
  return {
    concurrency: DEFAULT_WORKER_CONCURRENCY,
    warning: `COURSE_WORKER_CONCURRENCY=${JSON.stringify(String(raw))} 不是 1–${MAX_WORKER_CONCURRENCY} 的整数，已回退为 ${DEFAULT_WORKER_CONCURRENCY}`,
  };
}

// canary 单独成波；其余任务按原顺序每 concurrency 个一波。
export function planWorkerWaves(ids, concurrency, canarySize) {
  const canary = ids.slice(0, Math.min(canarySize, ids.length));
  const waves = [];
  for (let start = canary.length; start < ids.length; start += concurrency) {
    waves.push(ids.slice(start, start + concurrency));
  }
  return { canary, waves };
}

// 把 ID 列表按字符预算切成若干行；通常一波恰好一行。
function idLines(ids) {
  const lines = [];
  let current = [];
  let width = 0;
  for (const id of ids) {
    const token = JSON.stringify(id);
    if (current.length > 0 && width + token.length + 2 > PLAN_LINE_BUDGET) {
      lines.push(current.join(', '));
      current = [];
      width = 0;
    }
    current.push(token);
    width += token.length + 2;
  }
  if (current.length > 0) lines.push(current.join(', '));
  return lines;
}

function serializeIdArray(ids, indent) {
  const lines = idLines(ids);
  if (lines.length <= 1) return `[${lines[0] ?? ''}]`;
  return `[\n${lines.map((line) => `${indent}  ${line}`).join(',\n')}\n${indent}]`;
}

// 计划手工拼接成“每波一行”：逐 ID 换行时 N 个点约占 N 行，大课程会超出 read 的 2000 行上限。
export function serializeWorkerPlan(plan) {
  const waves = plan.waves.length === 0
    ? '[]'
    : `[\n${plan.waves.map((wave) => `    ${serializeIdArray(wave, '    ')}`).join(',\n')}\n  ]`;
  return [
    '{',
    `  "schema_version": ${JSON.stringify(plan.schema_version)},`,
    `  "courseId": ${JSON.stringify(plan.courseId)},`,
    `  "kind": ${JSON.stringify(plan.kind)},`,
    `  "concurrency": ${JSON.stringify(plan.concurrency)},`,
    `  "canary": ${serializeIdArray(plan.canary, '  ')},`,
    `  "waves": ${waves},`,
    `  "started": ${serializeIdArray(plan.started, '  ')},`,
    `  "taskDir": ${JSON.stringify(plan.taskDir)}`,
    '}',
    '',
  ].join('\n');
}

// 草稿校验报告的队首提示：新任务按计划顺序派发，因此本轮已派发却仍为 {} 占位的项必然排在
// 待生成队列最前面；列出前 k 个即可覆盖一条消息内全部可能静默未写入的任务。
export function formatPendingQueueHead(label, pendingIds, concurrency) {
  if (pendingIds.length === 0) return null;
  const head = pendingIds.slice(0, concurrency);
  return (
    `${label}待生成队首（按计划顺序前 ${head.length} 个）：${head.join(', ')}；`
    + '其中若有本轮已派发的任务，说明 worker 没有写入文件，按失败处理'
  );
}
