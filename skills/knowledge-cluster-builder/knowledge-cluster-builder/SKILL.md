---
name: knowledge-cluster-builder
description: 接收上游 v2 课程内容中间包（course.json + index.json + points/*.json + generation/manifest.json），为每个知识点补充簇归属（clusterIds，支持一点多簇、首个为主簇）、层级角色（trunk/branch/leaf）与横向关联（related），并透传/优化上游已产出的 prerequisites（保持无环 DAG），输出 clustered-graph/2.0 中间产物。用于把已生成完整内容的知识点聚类分簇、判断学习先后依赖、建立知识点关系，且尚未进入森林布局或 CKDS 发布阶段时。
---

# 知识点聚类与关系构建（适配上游 v2）

## 目标与边界

输入上游 v2 生成的**课程内容中间包**，输出在其之上补齐**簇归属、层级角色、横向关联**并透传/优化 `prerequisites` 的知识图谱。上游（`candidate-knowledge-point-generator` v2）已产出完整知识点内容和保证无环的 `prerequisites`，并**有意把知识簇和布局推迟给本阶段**。

本阶段职责与不做的事：

- **核心是聚类**：生成 `clusters` 定义 + 为每个点标注 `clusterIds`（支持一点归属多簇）。这是上游明确留给本阶段的空缺。
- **透传 + 优化 prerequisites**：默认沿用上游依赖，按需做补漏/去冗余/纠向的优化，每处改动记录审计（见 [references/relation-heuristics.md](references/relation-heuristics.md)）。不重建。
- **补 role 与 related**：上游禁止这两类字段，由本阶段新增。
- **不改写内容**：`coreIdea / principles / applications / qa / …` 原样透传，不重写不扩写。
- **不做布局**：不生成 `pos / scale / polygon / labelPos`，那是 CKDS 发布阶段的职责。
- **不增删知识点**：点集来自上游。发现缺漏/冗余写入报告，不擅自增删。

输出是发布前的中间产物，不可直接当作 CKDS `index.json` 发布。

## 输入解释

输入是一个 v2 中间包目录，本 skill 读取：

| 来源 | 读取内容 |
|---|---|
| `src/data/points/<id>.json` | 完整知识点内容 + `prerequisites`（已是 DAG） |
| `src/data/index.json` | 点列表与冻结顺序（`course-content-index/1.0`） |
| `src/data/course.json` | `courseId`、标题 |
| `generation/manifest.json` | `subject`（含 `outcomes`，透传到输出）；`pointEvidence[].kind`（原子类型，作聚类与关系先验） |

`kind` 只存在于 manifest 的 `pointEvidence`，不在 point 详情里——聚类和依赖判定要用 `kind` 时从这里取。若输入中间包本身不合法（缺文件、id 冲突、prerequisites 有环/悬空），先报告并停止，不在脏输入上建图。

## 工作流

### 1. 载入并核对输入

加载四类来源，建立 `id → point` 索引。确认 `points/*.json` 与 `index.json` 的 id 集合一致、`prerequisites` 只引用已存在 id。建议先跑上游校验器确认输入干净：

```bash
node <上游 skill>/scripts/validate_output.mjs --root <中间包目录> --phase all
```

### 2. 聚类分簇（核心）

把语义相近、构成同一学习主题的点归入同一簇。

- 依据 `kind`（来自 manifest）+ `keyTerms` + `shortSummary` 的语义相近度聚类，而非字面词匹配。
- 簇数量由点集规模与主题结构决定，不用固定数字；每簇 5–20 个点较利于可视化。
- 为每个簇生成 `id`（kebab-case）、`title`、`subtitle`、`description`，并按建议学习/展示先后排 `order`（整型）。
- 簇 `id` 必须泛化到当前课程本身，不套用其他领域的固定簇名。

### 3. 标注簇归属 clusterIds（支持一点多簇）

为每个点写 `clusterIds` 数组：

- **默认单簇**：多数点只属于一个簇，`clusterIds` 只含主簇。
- **仅当一个点在多个簇都有独立教学价值时才多簇**（判定见 references）——宁可单簇，避免多簇泛滥让森林可视化糊成一团。
- **首个元素为主簇**（primary）：该点最核心的归属，供后续森林布局/着色使用。其余为附加归属。

### 4. 标注层级角色 role

在每个点的**主簇**内部，按其在 `prerequisites` 中的拓扑位置 + `importance` 标注 `trunk` / `branch` / `leaf`（细则见 references）。每个非空主簇应至少有一个 `trunk`。

### 5. 透传并优化 prerequisites

默认原样透传上游 `prerequisites`。允许三类主动优化（详见 references）：**补漏**（上游遗漏的必需前置）、**去冗余**（可由传递关系推出的间接边）、**纠向**（明显反向的依赖）。

- 每处改动记入 `generation.refinedPrerequisiteEdges`：`{ op: "add"|"remove", from, to, reason }`。
- 不确定的关系保持上游原样，宁可不动。
- 引用值必须是点 id，禁止中文标题、悬空、自环。

### 6. 补横向关联 related（无向）

为相关但非必需前置的点对建立 `related`（对比、并列、互补、易混淆）。与 `prerequisites` 互斥；建议成对声明。

### 7. 保证无环并自检

优化后 `prerequisites` 仍须无环。若优化引入环，按 references 的规则打破并记入 `generation.brokenCycleEdges`。然后运行综合校验器：

```bash
node scripts/check-graph.mjs <你的输出>.json
```

它做两类校验——**对象与引用完整性**（point 必需字段齐全且没有契约外字段、clusterIds 命中簇、prerequisites/related 无悬空、无自环、id 规范；注意 clusterIds 是外键、与 DAG 无关）与**图性质**（prerequisites 无环 + 拓扑排序）。通过（退出 0）才算合格。

失败时加 `--json` 拿结构化问题清单，按每条 finding 的 `pointId + field + value + fix` 定位修改，改完重跑直到 `ok: true`：

```bash
node scripts/check-graph.mjs <你的输出>.json --json
```

### 8. 增量叠加输出

先生成关系草稿：顶层写 `subject`（透传 manifest）、`generation`、`clusters`、`points`；草稿的每个 point 只需写 `id / clusterIds / role / related`，主动优化前置边时再写 `prerequisites`。**禁止靠模型复制、概括或手工重写正文。** 然后必须由脚本按冻结 index 顺序读取 `points/<id>.json`，机械补齐全部 v2 内容字段：

```bash
node scripts/assemble-graph-points.mjs <CONTENT_ROOT> <GRAPH_FILE>
node scripts/assemble-graph-points.mjs <CONTENT_ROOT> <GRAPH_FILE> --check
node scripts/check-graph.mjs <GRAPH_FILE>
```

装配脚本会自动补齐草稿中省略的正文，并用上游 point 文件与 manifest 覆盖草稿里任何被模型改写/精简的正文和 `subject`；若增删知识点、遗漏关系字段或包含契约外字段，则立即失败。只有三条命令都通过，才可把结果视为 `clustered-graph/2.0`。最终对象在上游字段之外只能追加 `clusterIds / role / related`，`prerequisites` 只能按审计记录优化。

## 输出契约

写出单个 UTF-8 标准 JSON `clustered-graph.json`（`clustered-graph/2.0`）：

```json
{
  "schema_version": "clustered-graph/2.0",
  "subject": { "id": "…", "input": "…", "normalizedTitle": "…", "inputType": "course", "language": "zh-CN", "audience": "…", "depth": "…", "scope": "…", "exclusions": ["…"], "outcomes": ["…"] },
  "generation": {
    "generatedAt": "2026-07-16",
    "sourceCourseId": "software-engineering-pilot",
    "pointCount": 10,
    "clusterCount": 3,
    "brokenCycleEdges": [],
    "refinedPrerequisiteEdges": [
      { "op": "add", "from": "continuous-integration", "to": "software-testing", "reason": "CI 的质量门禁以测试为必需前置，上游遗漏" }
    ]
  },
  "clusters": [
    { "id": "requirements", "title": "需求工程", "subtitle": "识别并规范化利益相关者诉求", "description": "从需求获取到可验证的需求规格。", "order": 1 }
  ],
  "points": [
    {
      "id": "software-testing", "title": "软件测试",
      "shortSummary": "…", "coreIdea": "…", "principles": ["…","…"], "keyTerms": ["…","…"],
      "applications": ["…"], "aliases": ["Software Testing"], "intuition": "…",
      "misconceptions": ["…"], "qa": [{ "q": "…", "a": "…" }], "animationType": "none",
      "difficulty": "基础", "importance": 0.94, "prerequisites": ["requirements-specification"],
      "clusterIds": ["quality-assurance"], "role": "trunk", "related": ["change-impact-analysis"]
    }
  ]
}
```

字段口径：`id/title/clusterIds/role/prerequisites/related` 是关系层；其余为 v2 内容字段的原样透传（含可选 `formula/comparisons/history/yearIntroduced/prosCons/visualType/visualSuggestion/animationSuggestion`）。

除 JSON 外，只报告：簇数量、点数量、多簇点数量、依赖边数、优化边数、被打破的环边数，以及建议人工复核的聚类或关系分歧。

## 发布前检查

- [ ] 输出通过 `clustered-graph.schema.json` 校验。
- [ ] `node scripts/check-graph.mjs` 退出码为 0。
- [ ] 每个点 `clusterIds` 非空、去重、每个都命中已声明的簇；首个为主簇。
- [ ] 多簇点确有跨主题的独立教学理由，未滥用多簇。
- [ ] 所有 `prerequisites`/`related` 都是点 id（无中文标题、无悬空、无自环）；`prerequisites` 全图无环。
- [ ] 对上游 prerequisites 的每处改动都记入 `refinedPrerequisiteEdges`；引入的环已记入 `brokenCycleEdges`。
- [ ] 每个非空主簇至少一个 `trunk`；标为 `leaf` 的点未被其他点依赖。
- [ ] v2 内容字段原样透传，未被改写；未生成布局字段。
- [ ] 已运行 `assemble-graph-points.mjs`，其 `--check` 模式退出码为 0；没有手工复制或精简 point 正文。
- [ ] `pointCount` 等于 `points` 长度，`clusterCount` 等于 `clusters` 长度。
