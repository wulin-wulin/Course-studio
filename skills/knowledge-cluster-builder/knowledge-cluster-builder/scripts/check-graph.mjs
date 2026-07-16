#!/usr/bin/env node
// check-graph.mjs — clustered-graph/2.0 综合校验器（零依赖 Node ESM）
//
// 用法:  node check-graph.mjs <clustered-graph.json> [--json]
// 退出码: 0 通过 | 1 校验失败 | 2 用法/读取错误
//
// 校验分两类，都需要加载整张图后做交叉检查（JSON Schema 只能查单文件结构、查不了这些）：
//   A. 引用完整性（与 DAG 无关的「外键」约束）：
//      - schema_version 正确
//      - 簇 / 点 id 的 kebab-case 规范与唯一性
//      - clusterIds 非空、去重、每个都命中已声明的簇（首个为主簇）；role 合法
//      - prerequisites / related 引用无悬空、无自环
//   B. 图性质（真正的 DAG）：
//      - prerequisites 有向图无环（DFS 三色检测，定位环路径）
//      - 通过后按 Kahn 拓扑排序输出学习顺序
//
// 注意：clusterIds 是簇归属（外键），不是图的边，与「有向无环」无关，属于 A 类；
//      DAG 仅由 prerequisites 有向边构成。二者放在同一校验器只是因为都要先加载整张图。
//
// 每个问题都是一条结构化 finding，绑定到出错的具体节点与字段，便于 agent 二次修改：
//   { code, pointId?/pointIndex?, clusterId?/clusterIndex?, field?, value?, cycle?, message, fix }
// 默认打印人类可读报告；加 --json 输出机器可读的 { ok, counts, findings } 供程序解析。

import { readFileSync } from 'node:fs';

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROLES = ['trunk', 'branch', 'leaf'];

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const file = args.find((a) => !a.startsWith('--'));

// 悬空引用若本身就不是合法 id，多半是把中文标题/别名当成了引用值——在 fix 里点破根因。
function danglingFix(ref, field) {
  const base = `把该值改成本图中存在的点 id，或从 ${field} 中移除`;
  return KEBAB.test(ref) ? base : `${base}（注意：该值非 kebab-case，疑似误用了中文标题/别名而非点 id）`;
}

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

if (!file) die(2, '用法: node check-graph.mjs <clustered-graph.json> [--json]');

let data;
try {
  data = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  die(2, `无法读取或解析 ${file}: ${e.message}`);
}

const findings = [];
const add = (f) => findings.push(f);

// —— 定位串（文本模式用）——
function locate(f) {
  if (f.pointId) return `点 ${f.pointId}`;
  if (f.clusterId) return `簇 ${f.clusterId}`;
  if (Number.isInteger(f.pointIndex)) return `points[${f.pointIndex}]`;
  if (Number.isInteger(f.clusterIndex)) return `clusters[${f.clusterIndex}]`;
  if (f.cycle) return `环 ${f.cycle.join('→')}`;
  return '(顶层)';
}

function report() {
  if (asJson) {
    console.log(JSON.stringify({ ok: false, counts: { errors: findings.length }, findings }, null, 2));
  } else {
    console.error(`\n❌ 校验失败，共 ${findings.length} 个问题：\n`);
    findings.forEach((f, i) => {
      const field = f.field ? ` · ${f.field}` : '';
      console.error(`  ${i + 1}. [${f.code}] ${locate(f)}${field} — ${f.message}`);
      if (f.fix) console.error(`     修复: ${f.fix}`);
    });
    console.error('');
  }
  process.exit(1);
}

// —— 0. 顶层结构 ——
if (data.schema_version !== 'clustered-graph/2.0') {
  add({ code: 'bad-schema-version', field: 'schema_version', value: data.schema_version,
    message: `schema_version 应为 "clustered-graph/2.0"`, fix: '把 schema_version 设为 "clustered-graph/2.0"' });
}
if (!Array.isArray(data.clusters)) {
  add({ code: 'clusters-not-array', field: 'clusters', message: 'clusters 缺失或不是数组', fix: '提供 clusters 数组' });
}
if (!Array.isArray(data.points)) {
  add({ code: 'points-not-array', field: 'points', message: 'points 缺失或不是数组', fix: '提供 points 数组' });
}
if (findings.length) report(); // 结构不完整时无法继续

const clusters = data.clusters;
const points = data.points;

// —— A1. 簇 id：规范 + 唯一 ——
const clusterIds = new Set();
clusters.forEach((c, i) => {
  if (!c || typeof c.id !== 'string') {
    add({ code: 'cluster-missing-id', clusterIndex: i, field: 'id', message: '簇缺少字符串 id', fix: '为该簇补充唯一 kebab-case id' });
    return;
  }
  if (!KEBAB.test(c.id)) {
    add({ code: 'cluster-bad-id', clusterId: c.id, clusterIndex: i, field: 'id', value: c.id,
      message: `簇 id 非 kebab-case: ${c.id}`, fix: '改为小写 ASCII kebab-case id' });
  }
  if (clusterIds.has(c.id)) {
    add({ code: 'cluster-duplicate-id', clusterId: c.id, clusterIndex: i, field: 'id', value: c.id,
      message: `簇 id 重复: ${c.id}`, fix: '重命名为唯一 id' });
  }
  clusterIds.add(c.id);
});

// —— A2. 点 id：规范 + 唯一 ——
const pointIds = new Set();
points.forEach((p, i) => {
  if (!p || typeof p.id !== 'string') {
    add({ code: 'point-missing-id', pointIndex: i, field: 'id', message: '知识点缺少字符串 id', fix: '为该点补充唯一 kebab-case id' });
    return;
  }
  if (!KEBAB.test(p.id)) {
    add({ code: 'point-bad-id', pointId: p.id, pointIndex: i, field: 'id', value: p.id,
      message: `点 id 非 kebab-case（疑似写成了中文标题）: ${p.id}`, fix: '改为小写 ASCII kebab-case id' });
  }
  if (pointIds.has(p.id)) {
    add({ code: 'point-duplicate-id', pointId: p.id, pointIndex: i, field: 'id', value: p.id,
      message: `点 id 重复: ${p.id}`, fix: '重命名为唯一 id' });
  }
  pointIds.add(p.id);
});

// —— A3. 簇归属 clusterIds、role、悬空引用、自环 ——
points.forEach((p, i) => {
  if (!p || typeof p.id !== 'string') return;
  const cids = Array.isArray(p.clusterIds) ? p.clusterIds : null;
  if (!cids || cids.length === 0) {
    add({ code: 'empty-cluster-ids', pointId: p.id, pointIndex: i, field: 'clusterIds', value: p.clusterIds,
      message: 'clusterIds 缺失或为空（每个点至少归属一个簇，首个为主簇）',
      fix: '提供至少一个命中簇的 clusterId，把最核心归属放在首位作为主簇' });
  } else {
    const seen = new Set();
    cids.forEach((cid) => {
      if (seen.has(cid)) {
        add({ code: 'duplicate-cluster-ref', pointId: p.id, pointIndex: i, field: 'clusterIds', value: cid,
          message: `clusterIds 重复: ${cid}`, fix: '移除重复的簇 id' });
      }
      seen.add(cid);
      if (!clusterIds.has(cid)) {
        add({ code: 'bad-cluster-ref', pointId: p.id, pointIndex: i, field: 'clusterIds', value: cid,
          message: `clusterIds 含不存在的簇: ${cid}`, fix: '改为 clusters 中已声明的簇 id，或从 clusterIds 移除' });
      }
    });
  }
  if (!ROLES.includes(p.role)) {
    add({ code: 'bad-role', pointId: p.id, pointIndex: i, field: 'role', value: p.role,
      message: `role 非法: ${JSON.stringify(p.role)}`, fix: '设为 trunk、branch 或 leaf 之一' });
  }
  for (const pre of Array.isArray(p.prerequisites) ? p.prerequisites : []) {
    if (pre === p.id) {
      add({ code: 'self-loop-prerequisite', pointId: p.id, pointIndex: i, field: 'prerequisites', value: pre,
        message: 'prerequisites 依赖自己（自环）', fix: '从 prerequisites 移除该点自身的 id' });
    } else if (!pointIds.has(pre)) {
      add({ code: 'dangling-prerequisite', pointId: p.id, pointIndex: i, field: 'prerequisites', value: pre,
        message: `前置依赖悬空（图中无此点）: ${pre}`, fix: danglingFix(pre, 'prerequisites') });
    }
  }
  for (const r of Array.isArray(p.related) ? p.related : []) {
    if (r === p.id) {
      add({ code: 'self-loop-related', pointId: p.id, pointIndex: i, field: 'related', value: r,
        message: 'related 指向自己', fix: '从 related 移除该点自身的 id' });
    } else if (!pointIds.has(r)) {
      add({ code: 'dangling-related', pointId: p.id, pointIndex: i, field: 'related', value: r,
        message: `横向关联悬空（图中无此点）: ${r}`, fix: danglingFix(r, 'related') });
    }
  }
});

// —— B. 环检测（只用「存在的、非自环」的前置边）——
// 有向边 p -> pre 表示「p 依赖 pre」。clusterIds 不构成边，不参与此处。
const graph = new Map();
for (const p of points) {
  if (!p || typeof p.id !== 'string') continue;
  const pres = (Array.isArray(p.prerequisites) ? p.prerequisites : [])
    .filter((x) => pointIds.has(x) && x !== p.id);
  graph.set(p.id, pres);
}

const WHITE = 0, GRAY = 1, BLACK = 2;
const color = new Map([...pointIds].map((id) => [id, WHITE]));
const pathStack = [];
const cycleKeys = new Set();

function visit(u) {
  color.set(u, GRAY);
  pathStack.push(u);
  for (const v of graph.get(u) || []) {
    if (color.get(v) === GRAY) {
      const cyc = pathStack.slice(pathStack.indexOf(v));
      let min = 0;
      for (let i = 1; i < cyc.length; i++) if (cyc[i] < cyc[min]) min = i;
      const norm = [...cyc.slice(min), ...cyc.slice(0, min)];
      const key = norm.join('→');
      if (!cycleKeys.has(key)) {
        cycleKeys.add(key);
        add({ code: 'cycle', field: 'prerequisites', cycle: norm,
          message: `prerequisites 成环: ${norm.join(' → ')} → ${norm[0]}`,
          fix: '按 importance/难度保留「更基础→更进阶」方向，移除反向边，并记入 generation.brokenCycleEdges 或 refinedPrerequisiteEdges' });
      }
    } else if (color.get(v) === WHITE) {
      visit(v);
    }
  }
  color.set(u, BLACK);
  pathStack.pop();
}

for (const id of pointIds) if (color.get(id) === WHITE) visit(id);

if (findings.length) report();

// —— 通过：Kahn 拓扑排序（前置在前，确定性输出）——
const indeg = new Map([...pointIds].map((id) => [id, (graph.get(id) || []).length]));
const dependents = new Map([...pointIds].map((id) => [id, []]));
for (const [p, pres] of graph) for (const pre of pres) dependents.get(pre).push(p);

const queue = [...pointIds].filter((id) => indeg.get(id) === 0).sort();
const order = [];
while (queue.length) {
  const u = queue.shift();
  order.push(u);
  for (const w of [...dependents.get(u)].sort()) {
    indeg.set(w, indeg.get(w) - 1);
    if (indeg.get(w) === 0) { queue.push(w); queue.sort(); }
  }
}

const edgeCount = [...graph.values()].reduce((a, b) => a + b.length, 0);

// 每簇按主簇 clusterIds[0] 归组；多簇点只计入主簇，另行报告其数量。
const byCluster = new Map();
let multiClusterPoints = 0;
for (const p of points) {
  const cids = Array.isArray(p.clusterIds) ? p.clusterIds : [];
  const primary = cids[0];
  if (cids.length > 1) multiClusterPoints++;
  if (!byCluster.has(primary)) byCluster.set(primary, []);
  byCluster.get(primary).push(p);
}
const clusterStats = [...clusters].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((c) => {
  const ps = byCluster.get(c.id) || [];
  const roles = { trunk: 0, branch: 0, leaf: 0 };
  for (const p of ps) if (roles[p.role] !== undefined) roles[p.role]++;
  return { id: c.id, title: c.title, points: ps.length, roles };
});

if (asJson) {
  console.log(JSON.stringify({
    ok: true,
    stats: {
      points: points.length,
      clusters: clusters.length,
      prerequisiteEdges: edgeCount,
      multiClusterPoints,
    },
    learningOrder: order,
    clusters: clusterStats,
  }, null, 2));
  process.exit(0);
}

console.log(`✅ 校验通过：${points.length} 个知识点，${clusters.length} 个簇，${edgeCount} 条前置依赖边，${multiClusterPoints} 个多簇点；无悬空、无自环、无环。`);
console.log('\n学习顺序（prerequisites 拓扑排序，前置在前）：');
console.log('  ' + (order.join(' → ') || '(空)'));
console.log('\n每簇统计（按主簇 clusterIds[0] 归组）[主干 trunk / 分支 branch / 叶子 leaf]：');
for (const c of clusterStats) {
  console.log(`  ${c.id}（${c.title}）: ${c.points} 点  [${c.roles.trunk} / ${c.roles.branch} / ${c.roles.leaf}]`);
}

process.exit(0);
