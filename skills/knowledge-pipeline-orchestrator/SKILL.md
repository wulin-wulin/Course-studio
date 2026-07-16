---
name: knowledge-pipeline-orchestrator
description: 端到端编排 v2 课程知识流水线：从课程名或领域名生成完整课程内容中间包及教学动画，执行身份复核和动画人工验收，再构建支持多簇归属与可审计先修优化的 clustered-graph/2.0，并验证内容透传、点集一致性和 DAG。用于完整生成、恢复、校验或干跑课程内容与知识图谱流水线；输入旧 candidate-points/1.0 或 clustered-graph/1.0 时也用它识别不兼容并要求迁移。
---

# v2 知识流水线编排

串联课程内容生成与知识聚类两个子 Skill，保持阶段可恢复、人工门禁不可绕过、跨阶段修改可审计。最终产物仍是 CKDS 发布前中间数据，不包含森林布局。

## 路径与模式

先确定稳定的 `<course-id>`，再解析绝对路径：

```text
<pipeline-root>/                         默认 generated/<course-id>-knowledge-pipeline/
├── course-content/                     CONTENT_ROOT，上游独占目录
└── clustered-graph.json                GRAPH_FILE，下游图
```

不得把 `GRAPH_FILE` 写进 `CONTENT_ROOT`；上游内容包要求目录自包含且无契约外文件。用户显式提供已有 v2 内容包时，可让 `CONTENT_ROOT` 指向该目录，并把 `GRAPH_FILE` 放在其外部。

确定一种模式：

- `full`：从课程名或领域名依次完成全部门禁。
- `resume`：校验现有产物，定位最早未通过或已失效的门禁后继续，不重建已通过阶段。
- `validate`：只校验指定阶段或最终交接，不改写文件。
- `dry-run`：只返回固定状态对象，不读取项目、不调用子 Skill、不写文件。

旧版 `candidate-points/1.0` 和 `clustered-graph/1.0` 不能作为 v2 `resume` 输入。报告不兼容并停止；除非用户明确要求迁移，否则从 G1 重新生成到新目录。

## 载入子 Skill

把本文件所在目录解析为 `<orchestrator-dir>`，再解析两个 canonical 目录：

```text
<content-skill-dir> = ../candidate-knowledge-point-generator
<graph-skill-dir>   = ../knowledge-cluster-builder/knowledge-cluster-builder
```

`knowledge-cluster-builder/candidate-knowledge-point-generator` 是同名打包副本，OpenCode 可能把它注册为候选 Skill 入口。两份目录同时存在时先递归比较：完全一致可加载任一入口，但所有命令统一使用 `<content-skill-dir>`；若有任何差异，以 `duplicate-skill-drift` 阻断，不能混用规则和脚本。

进入相应阶段前完整读取：

1. 内容阶段：`<content-skill-dir>/SKILL.md`、`data-contract.md`、`orchestration.md`、`animation-contract.md`。
2. 图阶段：`<graph-skill-dir>/SKILL.md`、`references/relation-heuristics.md`、Schema 和 `scripts/check-graph.mjs`。

子 Skill 的正式规则高于示例。本 Skill 只规定交接、门禁和跨阶段不变量，不降低子 Skill 的内容或动画质量要求。

## 门禁状态机

严格按顺序推进。任一门禁失败时保留产物、定点修复并重跑，不得跳过。

### G0_SCOPE

- 确认 `course` 或 `domain`、受众、深度、范围、排除项和学习成果。
- 只有会显著改变知识点集合的关键歧义才询问用户；否则记录最常见教育语境假设。
- 确认 `CONTENT_ROOT` 是独占的新目录或合法 v2 包，`GRAPH_FILE` 位于其外部。

### G1_INDEX

- 使用内容 Skill 只生成 `course.json`、`generation/manifest.json` 和全量 `index.json`。
- 冻结 index 中的 `id`、`title` 和数组顺序；manifest 的 `pointEvidence` 必须同序对应。
- 不生成详情、动画实现、知识簇、关系层或布局字段。
- 运行并通过：

```bash
node "<content-skill-dir>/scripts/validate_output.mjs" --root "$CONTENT_ROOT" --phase index
```

### G2_IDENTITY_REVIEW

- 汇总 `core / boundary / needs-review`、低置信度项和 `reviewQueue`。
- `scope-ambiguity / granularity / synonym / naming` 会改变点 ID、标题或身份时必须停止，等待用户决定。
- 用户明确要求 `model-only` 或全自动时，`insufficient-evidence` 可作为非阻断警告继续，但不得伪造来源或提高置信度。
- 决定导致增删、合并或重命名时，只在详情任务启动前串行更新 index 与 manifest，再重跑 G1；不得留下失效 ID。
- `resume` 遇到身份影响项时，只有当前请求或可审计会话中有明确决定才能继续，不能猜测历史批准。

### G3_CONTENT

- 按内容 Skill 的文件所有权和自适应拆分规则生成每个 `points/<id>.json` 与同名动画请求。
- 子智能体只写自己拥有的详情和请求；共享 index、manifest、清单与注册文件保持串行。
- 全局复核正文区分度、事实、前置引用与 DAG 后执行：

```bash
node "<content-skill-dir>/scripts/validate_output.mjs" --root "$CONTENT_ROOT" --phase points
node "<content-skill-dir>/scripts/sync_index_from_points.mjs" --root "$CONTENT_ROOT"
node "<content-skill-dir>/scripts/validate_output.mjs" --root "$CONTENT_ROOT" --phase points
```

### G4_ANIMATIONS

- 归并全部动画请求，只有真实动态机制才进入 `animation-manifest.json`。
- 按唯一机制生成互斥所有权的 TSX/CSS 组件，不以装饰运动冒充教学动画。
- 串行构建注册层；即使动画清单为空也必须运行：

```bash
node "<content-skill-dir>/scripts/build_animation_registry.mjs" --root "$CONTENT_ROOT"
```

### G5_CONTENT_READY

依次执行：

```bash
node "<content-skill-dir>/scripts/validate_output.mjs" --root "$CONTENT_ROOT" --phase all
node --test "<content-skill-dir>/scripts/"*.test.mjs
```

- 输出项目存在可用 TypeScript 构建命令时也必须运行。
- 若动画类型非空，必须按 `animation-contract.md` 实际操作重播、重新生成、状态推进、低动态和响应式布局。结构检查不能替代人工/浏览器验收；无法完成时门禁保持阻断。
- 动画清单为空时，人工动画验收标记为 `not-required`，不能伪造已操作结论。

### G6_GRAPH

- 仅在 G5 通过后使用图 Skill，读取完整 `CONTENT_ROOT`，写出 `GRAPH_FILE`。
- 点集及 index 顺序保持不变；所有 v2 内容字段原样透传。
- `prerequisites` 默认透传。每条补漏、去冗余或纠向都必须与 `generation.refinedPrerequisiteEdges` 一一对应。
- 新增 `clusterIds / role / related`；多簇归属保持克制，首个 `clusterIds` 为主簇。
- `related` 与任一方向的 `prerequisites` 互斥；优化后仍须为 DAG。

### G7_RELEASE_READY

依次执行：

```bash
node "<graph-skill-dir>/scripts/check-graph.mjs" "$GRAPH_FILE"
node "<orchestrator-dir>/scripts/check-pipeline.mjs" "$CONTENT_ROOT" "$GRAPH_FILE"
```

只有两条命令均退出 0，且 G5 的全量内容校验、脚本测试和必要动画验收已有证据时，才能声明中间产物合格。不得称其为已布局或已发布的 CKDS 森林包。

最终发布工具会把已验收动画源码做目标项目生产构建，生成带 SHA-256 完整性清单的独立 iframe 运行包；构建、依赖边界或资产完整性失败时整次发布原子失败。不得把源码直接接入主前端，也不得为了通过发布而删除非空动画清单。

## 恢复与失效

- 依次运行上游 `index / points / all` 校验来定位最早可复用阶段，不凭文件存在判断成功。
- G1 身份冻结后若 `id/title/order` 改变，G3–G7 全部失效。
- 任一 point 内容、动画绑定或 `prerequisites` 改变，G5–G7 失效；重新同步 index、全量校验并重建或复核图。
- `check-pipeline.mjs` 报内容漂移、点顺序变化或边审计不匹配时，图立即视为过期。
- 不覆盖已通过产物，除非用户明确要求重建；不删除问题点、关系或动画来伪造通过。

## 校验器用法

只校验内容包：

```bash
node "<orchestrator-dir>/scripts/check-pipeline.mjs" "$CONTENT_ROOT" --phase all
```

校验最终交接：

```bash
node "<orchestrator-dir>/scripts/check-pipeline.mjs" "$CONTENT_ROOT" "$GRAPH_FILE" --json
```

校验器复用上游 `validateProject()`，并额外检查 subject/courseId、点集与顺序、全部内容字段透传、关系字段边界、角色约束、关系互斥、先修边差异及其审计记录。

## Dry-run 输出

`dry-run` 是固定机器接口。第一个非空字符必须是 `{`，最后一个非空字符必须是 `}`，不得包含反引号、说明文字或额外键；输出必须与下方对象完全一致：

```json
{"pipelineSkill":"knowledge-pipeline-orchestrator","mode":"dry-run","gates":["G0_SCOPE","G1_INDEX","G2_IDENTITY_REVIEW","G3_CONTENT","G4_ANIMATIONS","G5_CONTENT_READY","G6_GRAPH","G7_RELEASE_READY"],"artifacts":["course-content/","clustered-graph.json"],"blockingPolicy":"stop-on-identity-or-animation-review"}
```

## 最终报告

只报告：运行模式与路径、已通过门禁、index/详情/复核/来源数量、动画请求/类型/组件及人工验收状态、簇与多簇点数量、前置边/优化边/打破环边数量、校验/测试/构建结果、警告和阻断项。不粘贴完整点集、JSON 或动画源码。

## 禁止项

- 不生成或继续使用旧 `candidate-points.json`。
- 不把 `clustered-graph.json` 放进上游独占内容目录。
- 不让图阶段改写正文或未经审计修改 `prerequisites`。
- 不在动画未实际验收时宣称 G5/G7 通过。
- 不生成布局字段，不把中间产物伪装成 CKDS 发布包。
