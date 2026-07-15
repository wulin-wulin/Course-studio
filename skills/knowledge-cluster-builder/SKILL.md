---
name: knowledge-cluster-builder
description: 把扁平候选知识点池聚类成知识簇，并为每个点标注层级角色（主干/分支/叶子）、构建前置依赖（有向、保证无环 DAG）与横向关联（无向），输出供可视化与发布阶段使用的中间知识图谱 JSON。用于将候选知识点分组、判断学习先后依赖、建立知识点之间的关系，且上游已产出扁平候选池、尚未进入布局或发布阶段时。
---

# 知识点聚类与关系构建

## 目标与边界

输入一份扁平候选知识点池，输出带**簇归属、层级角色、前置依赖和横向关联**的知识图谱中间产物。

本阶段只回答“这些点如何分组与连接”：

- **只做关系，不改内容**：`shortSummary / difficulty / importance / keyTerms / kind / aliases` 原样透传，不重写、不扩写 `coreIdea / principles / applications`。
- **不增删知识点**：候选池即点集。若发现明显缺漏或冗余，写入运行报告的建议，不擅自增删。
- **不做布局**：不生成 `pos / scale / polygon / labelPos`，那是发布阶段的职责。
- **不回答“哪些点入选”**：那是上游候选点生成阶段的职责。

输出是发布前的中间产物，不可直接当作 `index.json` 或 `points/*.json` 发布。

## 输入解释

唯一必填输入是一份符合 `candidate-points/1.0` 的候选点池（通常是上游 `candidate-knowledge-point-generator` 产出的 `candidate-points.json`）。

- `subject` 原样透传到输出，保持课程/领域范围可追溯。
- `scopeStatus` 为 `boundary` 或 `needs-review` 的点仍纳入聚类与关系构建，但建立关系时更保守（宁可少连，不可错连）。
- 每个候选点的 `id` 已是规范 kebab-case，**关系字段只能引用这些既有 id**，不得引用标题、别名或不存在的点。

若候选池本身不合法（缺字段、id 非 kebab-case、id 重复），先报告问题并停止，不要在脏输入上强行建图。

## 工作流

### 1. 载入与校验输入

解析候选池，确认 `schema_version` 为 `candidate-points/1.0`，`id` 全部唯一且为 kebab-case。建立 `id → candidate` 索引，后续所有关系引用都必须落在这个 id 集合内。

### 2. 聚类分簇

把语义相近、构成同一学习主题的点归入同一簇。

- 依据 `kind`、`keyTerms`、`shortSummary` 的语义相近度聚类，而非字面词匹配。
- **簇数量由候选池规模与主题结构决定，不用固定数字。** 经验区间：每簇 5–20 个点较利于可视化；过大的簇应按子主题再分，单点簇应考虑并入邻近簇。
- 每个点**恰好归属一个簇**（`clusterId` 唯一）。
- 为每个簇生成 `id`（kebab-case）、`title`、`subtitle`（一句话说明该簇讲什么）、`description`，并按建议学习/展示先后设置整型 `order`。
- 簇 `id` 必须泛化到当前课程本身，不要套用其他领域的固定簇名。

### 3. 标注层级角色 role

在每个簇内部，按知识点在依赖结构中的位置与 `importance` 标注角色（判定细则见 [references/relation-heuristics.md](references/relation-heuristics.md)）：

- `trunk`（主干）：簇内的基础/枢纽概念，簇内几乎无前置、被较多点依赖，`importance` 高、`difficulty` 偏低。
- `leaf`（叶子）：末端具体点，依赖他人、几乎不被其他点依赖。
- `branch`（分支）：介于两者之间的过渡概念。

每个非空簇应至少有一个 `trunk`。

### 4. 构建前置依赖 prerequisites（有向）

`prerequisites` 表示**学习前置**：点 A 的 `prerequisites` 含 B，当且仅当“不先掌握 B 就无法学会 A”。

- 判定是必需的**先修关系**，不是“相关”“同簇”“同主题”。同簇不等于有依赖。
- 用 `kind` 作先验：`algorithm`/`method` 通常依赖其定义所在的 `concept`/`model`；`theorem` 依赖其涉及的 `concept`；`metric` 依赖被度量的 `task`/`model`。细则见 references。
- 依赖可以跨簇。倾向记录**直接前置**，不必把所有间接祖先都列出（间接依赖由拓扑传递即可）。
- 引用值必须是候选池中存在的点 `id`，**禁止中文标题、禁止悬空、禁止自环**。

### 5. 构建横向关联 related（无向）

`related` 表示**相关但非必需前置**的点：对比概念、并列方法、互补主题、易混淆项。

- 与 `prerequisites` 互斥：一对点若已是前置关系，就不再放进 `related`。
- 语义上无向；建议成对声明（A 的 related 含 B，则 B 的 related 含 A），但脚本不强制对称。

### 6. 保证无环（DAG）

`prerequisites` 全图必须无环。构建完成后自检：

- 若检出环（例如 A 依赖 B、B 又依赖 A），按“保留更基础 → 更进阶方向”打破：比较两端的 `importance`（高者更基础）与 `difficulty`（低者更基础），移除指向更基础点的那条反向边。
- 每移除一条边，在 `generation.brokenCycleEdges` 追加 `{ from, to, reason }` 记录，保证可审计。
- 打破后重新检测，直到无环。

### 7. 规范化与自检

- 所有 `prerequisites`/`related` 去重、去自环、只保留合法 id。
- 运行校验脚本：

```bash
node scripts/check-dag.mjs <你的输出>.json
```

脚本通过（退出码 0）才算合格；它会检查簇引用、悬空引用、自环、id 规范并**断言 prerequisites 无环**，通过后打印拓扑排序的学习顺序和每簇 trunk/branch/leaf 统计。

失败时（退出码 1）加 `--json` 拿到结构化问题清单，据此闭环二次修改：

```bash
node scripts/check-dag.mjs <你的输出>.json --json
```

每条 finding 精确定位到出错处：`pointId`（配 `pointIndex`，直接对应 `points[]` 中的节点）、`field`（出问题的字段，如 `prerequisites`）、`value`（问题值）、`code`（错误类型）、`fix`（建议动作）；环用 `cycle` 数组列出环上所有节点。按每条 finding 修改对应节点的对应字段，改完重跑，直到 `ok: true`。

### 8. 写出结果

按下方输出契约写出单个 UTF-8 标准 JSON，并通过 [clustered-graph.schema.json](clustered-graph.schema.json) 校验。

## 输出契约

默认写出 `clustered-graph.json`，无注释、无尾随逗号：

```json
{
  "schema_version": "clustered-graph/1.0",
  "subject": { "id": "data-structures", "input": "数据结构", "normalizedTitle": "数据结构", "inputType": "course", "language": "zh-CN", "audience": "计算机相关专业本科生", "depth": "一学期核心课程", "scope": "覆盖数据结构的表示、操作、复杂度与典型算法。", "exclusions": ["特定编程语言容器库的 API"] },
  "generation": {
    "generatedAt": "2026-01-01",
    "sourceSchema": "candidate-points/1.0",
    "candidateCount": 2,
    "clusterCount": 1,
    "brokenCycleEdges": []
  },
  "clusters": [
    { "id": "linear-structures", "title": "线性结构", "subtitle": "按顺序组织的基础数据结构", "description": "数组、链表、栈与队列等线性表示。", "order": 1 }
  ],
  "points": [
    {
      "id": "array", "title": "数组", "clusterId": "linear-structures", "role": "trunk",
      "prerequisites": [], "related": ["linked-list"],
      "kind": "concept", "shortSummary": "在连续内存中按下标随机访问的定长线性数据结构。",
      "difficulty": "基础", "importance": 0.9, "keyTerms": ["下标", "连续内存"], "aliases": ["Array"]
    },
    {
      "id": "linked-list", "title": "链表", "clusterId": "linear-structures", "role": "branch",
      "prerequisites": ["array"], "related": ["array"],
      "kind": "concept", "shortSummary": "由节点及其链接关系构成、支持动态插入删除的线性数据结构。",
      "difficulty": "基础", "importance": 0.85, "keyTerms": ["节点", "链接"], "aliases": ["Linked List"]
    }
  ]
}
```

字段口径：`id/title/clusterId/prerequisites` 与下游可视化/构建阶段既有字段对齐；`role` 与 `related` 是本阶段新增。簇的 `accent/soft/dark` 配色为可选，可留待发布阶段生成。

除 JSON 外，只报告：簇数量、点数量、依赖边数、被打破的环边数，以及建议人工复核的关系或聚类分歧。

## 发布前检查

- [ ] 输出通过 `clustered-graph.schema.json` 校验。
- [ ] `node scripts/check-dag.mjs` 退出码为 0。
- [ ] 每个点的 `clusterId` 命中已声明的簇；每个点恰好属于一个簇。
- [ ] 所有 `prerequisites`/`related` 元素都是候选池中存在的点 `id`（无中文标题、无悬空、无自环）。
- [ ] `prerequisites` 全图无环；被打破的环边已记入 `brokenCycleEdges`。
- [ ] `prerequisites` 是学习必需前置，未把“同簇”或“相关”误当依赖。
- [ ] 每个非空簇至少有一个 `trunk`；标为 `leaf` 的点没有被其他点依赖。
- [ ] 候选点的内容字段原样透传，未被改写；未生成布局字段。
- [ ] `candidateCount` 等于 `points` 长度，`clusterCount` 等于 `clusters` 长度。
