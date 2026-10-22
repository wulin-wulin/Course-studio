---
name: knowledge-cluster-builder
description: 接收已校验的课程内容包，为冻结的知识点集合补充知识簇、层级角色、前置依赖、横向关系与阅读顺序。textbook-content/2.0 必须输出不复制正文的 clustered-graph/3.0 薄关系图；旧内容包继续输出 clustered-graph/2.0。
---

# 知识簇与关系图构建

## 职责边界

本阶段只负责关系：

- 定义 `clusters`，并为每点设置 `clusterIds`；首个簇是主簇。
- 设置 `role`：`trunk / branch / leaf`。
- 透传或按审计记录调整 `prerequisites`，最终必须是 DAG。
- 设置无向语义关联 `related`。
- 教材模式保留显式章节顺序和章内知识点顺序 `sequences`。

本阶段不得增删知识点、改写冻结的 `id/title/origin`、重写知识点正文，或生成
`pos / scale / polygon / labelPos` 等布局字段。

## 输入

从 `course-content` 读取：

| 路径 | 用途 |
|---|---|
| `src/data/index.json` | 冻结的知识点集合与顺序 |
| `src/data/points/<id>.json` | canonical 知识点正文及上游 `prerequisites` |
| `generation/manifest.json` | `subject`、证据模式、`kind` 与内容契约 |
| `src/data/course.json` | 课程 ID 与课程元数据 |

开始前通过 `course_pipeline validate-all` 校验内容包。图阶段可以阅读 canonical point
帮助判断关系，但不能把 `content` 或旧正文栏目复制到 3.0 图里。

## 输出版本

### 教材内容 2.0：clustered-graph/3.0

当 `manifest.generation.contentContract === "textbook-content/2.0"` 时，必须输出
`clustered-graph/3.0`。每个 `points[]` 对象只能包含：

```json
{
  "id": "finite-state",
  "title": "有限状态",
  "origin": "textbook",
  "clusterIds": ["chapter-one"],
  "role": "trunk",
  "prerequisites": [],
  "related": ["state-transition"]
}
```

`content`、`sourceSpans`、`modelEnriched`、摘要、术语和动画信息全部留在
`src/data/points/<id>.json`。发布器会从 canonical point 加载正文并合并图关系；
兼容接口需要的顶层 `sourceSpans/modelEnriched` 在发布边界从 `content.blocks` 派生。

### 旧内容包：clustered-graph/2.0

没有 `textbook-content/2.0` 契约的旧课程继续使用 2.0 完整点图。此路径仅用于向后兼容，
不得把新教材课程降级为 2.0。

## 教材模式的确定性约束

如果流水线存在已校验的 `textbook-outline.json`：

1. 每个教材章节生成同 ID、同标题、同顺序的主簇。
2. 每个知识点首个 `clusterIds` 固定为 outline 中的章节 ID。
3. 可以增加有独立教学价值的次要簇，但不得改变主章节归属。
4. 教材原点和模型扩展点均保持 G1 冻结的 `id/title/origin` 与顺序。
5. 章节顺序和章内点顺序写入 `sequences`；它们不等于 `prerequisites`。
6. 章节结构与语义主题冲突时记录复核说明，不得重分章来“修正”教材。

## 关系构建

### 知识簇

- 普通主题模式依据 `kind`、`keyTerms`、`shortSummary` 与内容语义分簇。
- 大多数点只属于一个簇；确有跨主题教学价值时再追加次要簇。
- `clusters[].order` 表示推荐展示顺序，不能据此自动制造前置依赖。
- 每个有主成员的簇至少有一个 `trunk`。

### 前置依赖

- `A.prerequisites = [B]` 表示学习 A 前应先掌握 B。
- 优先沿用上游边；每次增加或删除都写入
  `generation.refinedPrerequisiteEdges`。
- 为破环删除的边还要写入 `generation.brokenCycleEdges`。
- 规则与审计格式见 [references/relation-heuristics.md](references/relation-heuristics.md)。

### related 与 role

- `related` 只表达非前置的横向联系，不能与同一对点的 prerequisite 重复。
- `related` 必须双向声明；若 `A.related` 包含 B，则 `B.related` 必须包含 A。
- `trunk` 是簇内骨架，`branch` 承接或分化主干，`leaf` 是应用或末端专题。
- 仍被其他点依赖的点不能标为 `leaf`。

## 装配与门禁

先写关系草稿。教材 3.0 草稿点可以只写 `id/prerequisites/clusterIds/role/related`；
`assemble-graph` 会按 index 顺序从 canonical point 机械恢复 `title/origin`，并阻止正文进入图谱。
旧 2.0 草稿按原流程机械装配完整上游点。

完成草稿后依次调用：

1. `course_pipeline assemble-graph`
2. `course_pipeline assemble-graph-check`
3. `course_pipeline check-graph`
4. 教材模式再调用 `course_pipeline validate-textbook-graph`
5. `course_pipeline review-knowledge-graph`

`assemble-graph-check` 或 `check-graph` 未通过时不得进入 G6 审核。没有有效的
`knowledge-graph/G6_GRAPH_REVIEW` 回执时不得发布。

## clustered-graph/3.0 顶层示例

```json
{
  "schema_version": "clustered-graph/3.0",
  "subject": {},
  "generation": {
    "generatedAt": "2026-10-22",
    "sourceCourseId": "state-machines",
    "pointCount": 2,
    "clusterCount": 1,
    "brokenCycleEdges": [],
    "refinedPrerequisiteEdges": []
  },
  "clusters": [
    {
      "id": "chapter-one",
      "title": "第一章",
      "subtitle": "基础结构",
      "description": "建立本章的概念与方法基础。",
      "order": 0
    }
  ],
  "sequences": {
    "cluster": [],
    "point": [{ "fromId": "finite-state", "toId": "state-transition" }]
  },
  "points": [
    {
      "id": "finite-state",
      "title": "有限状态",
      "origin": "textbook",
      "clusterIds": ["chapter-one"],
      "role": "trunk",
      "prerequisites": [],
      "related": ["state-transition"]
    },
    {
      "id": "state-transition",
      "title": "状态转移",
      "origin": "textbook",
      "clusterIds": ["chapter-one"],
      "role": "branch",
      "prerequisites": [],
      "related": ["finite-state"]
    }
  ]
}
```

## 完成检查

- [ ] 图的点集和顺序与 index 完全一致。
- [ ] `subject` 从 manifest 原样恢复。
- [ ] 3.0 point 只有七个规定字段，未复制 `content/sourceSpans/modelEnriched`。
- [ ] 每点至少一个有效 `clusterIds`，首个是主簇。
- [ ] prerequisites 无悬空、自环、重复和环；所有改动有审计记录。
- [ ] related 双向一致，且无悬空、自环和 prerequisite 类型冲突。
- [ ] sequences 无悬空、自环、重复和有向环。
- [ ] generation 的点数、簇数与实际数组一致。
- [ ] 装配、图校验、教材结构校验和 G6 审核均已通过。
