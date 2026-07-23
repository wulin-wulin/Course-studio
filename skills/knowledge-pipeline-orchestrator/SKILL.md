---
name: knowledge-pipeline-orchestrator
description: 端到端编排 v2 课程知识流水线：从课程名或领域名生成完整课程内容中间包及教学动画，执行知识点清单、动画和 prerequisite 依赖人工审核，再构建支持多簇归属与可审计先修优化的 clustered-graph/2.0，并验证内容透传、点集一致性和 DAG。用于完整生成、恢复、校验或干跑课程内容与知识图谱流水线；输入旧 candidate-points/1.0 或 clustered-graph/1.0 时也用它识别不兼容并要求迁移。
---

# v2 知识流水线编排

串联课程内容生成与知识聚类两个子 Skill，保持阶段可恢复、人工门禁不可绕过、跨阶段修改可审计。最终产物仍是 CKDS 发布前中间数据，不包含森林布局。

## 路径与模式

先确定稳定的 `<course-id>`，再从当前 Course Studio 会话根目录解析固定路径：

```text
<session-root>/pipeline/<course-id>/    PIPELINE_ROOT
├── course-content/                     CONTENT_ROOT，上游独占目录
└── clustered-graph.json                GRAPH_FILE，下游图
```

不得把 `GRAPH_FILE` 写进 `CONTENT_ROOT`；上游内容包要求目录自包含且无契约外文件。审核工具、回执校验和发布工具都以该固定布局解析课程；用户提供其他位置的已有 v2 内容包时，必须先将它导入到该布局，不得直接以任意路径进入 `resume`。

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

子 Skill 的正式规则高于示例。本 Skill 只规定交接、门禁和跨阶段不变量，不降低子 Skill 的内容或动画质量要求。子 Skill 的直接脚本命令只用于独立调试；Course Studio 会话中必须调用结构化 `course_pipeline` 工具，只传固定 `action` 和小写 kebab-case `courseId`，不得调用 Bash 或直接执行脚本。

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

```text
course_pipeline {"action":"validate-index","courseId":"<course-id>"}
```

- `review-knowledge-points` 动作会在写审核 request marker 前再次运行流水线的 G1 index 校验。校验失败时不得创建 marker 或声称已进入 G2。

### G2_IDENTITY_REVIEW

- 无论 `reviewQueue` 是否为空，都必须把完整知识点清单交给 Course Studio 审核页，不得只汇报有争议的少数项。
- 本门只允许用户**保留、添加或删除**知识点。禁止提供或代替用户执行重命名、合并、拆分、重排；需要不同身份时只能明确删除旧点并添加新点。
- 先汇总 `core / boundary / needs-review`、低置信度项和 `reviewQueue`，再运行：

```text
course_pipeline {"action":"review-knowledge-points","courseId":"<course-id>"}
```

- 命令返回 `status: "pending"` 时，说明审核检查点已经持久化：简短告知用户到知识点审核页处理，然后**结束当前 turn**。不要再调用通用 `question`，不要启动详情 worker，也不要进入 G3。
- 审核页只能提交 `add` / `delete` 操作。后端会机械更新 index、manifest、pointCount 与 reviewQueue，并生成模型不可写的审批回执。
- 下一 turn 必须重跑 G1 index 校验和上述命令；只有返回 `status: "approved"`，且回执绑定当前 `id/title/顺序` 哈希时，才冻结身份并进入 G3。
- 用户明确要求 `model-only` 或全自动也不能跳过完整清单审核；`insufficient-evidence` 可作为警告展示，但不得伪造来源或提高置信度。
- `resume` 不得根据聊天文本或模型记忆猜测历史批准，只认当前工作区中由后端写入且哈希仍有效的审核回执。

### G3_CONTENT

- 调用 `init-points` 前必须已有有效的 G2 知识点审核回执；工具会在回执缺失或身份哈希过期时拒绝创建详情任务。
- 按内容 Skill 的文件所有权和自适应拆分规则生成每个 `points/<id>.json` 与同名动画请求。
- 子智能体只写自己拥有的详情和请求；共享 index、manifest、清单与注册文件保持串行。
- 全局复核正文区分度、事实、前置引用与 DAG 后执行：

```text
course_pipeline {"action":"validate-points","courseId":"<course-id>"}
course_pipeline {"action":"sync-index","courseId":"<course-id>"}
course_pipeline {"action":"validate-points","courseId":"<course-id>"}
```

### G4_ANIMATIONS

- 归并全部动画请求，只有真实动态机制才进入 `animation-manifest.json`。
- 按唯一机制生成互斥所有权的 TSX/CSS 组件，不以装饰运动冒充教学动画。
- 串行构建注册层；即使动画清单为空也必须运行：

```text
course_pipeline {"action":"build-animation-registry","courseId":"<course-id>"}
```

### G5_CONTENT_READY

执行：

```text
course_pipeline {"action":"validate-all","courseId":"<course-id>"}
```

- 脚本测试属于 Course Studio 部署验证，不是课程生成会话的运行时命令；不得为运行它们扩大当前 Bash 权限。
- 输出项目存在可用 TypeScript 构建命令时也必须运行。
- 若动画类型非空，必须按 `animation-contract.md` 实际操作重播、重新生成、状态推进、低动态和响应式布局。结构检查不能替代人工/浏览器验收；无法完成时门禁保持阻断。
- 动画清单为空时，人工动画验收标记为 `not-required`，不能伪造已操作结论。

### G6_GRAPH

- 仅在 G5 通过后使用图 Skill，读取完整 `CONTENT_ROOT`，写出 `GRAPH_FILE`。
- 点集及 index 顺序保持不变；所有 v2 内容字段原样透传。
- 先写只含 `id/prerequisites/clusterIds/role/related` 的关系草稿，再运行图 Skill 的 `assemble-graph-points.mjs` 从上游机械装配完整 point 对象和 `subject`；脚本会自动覆盖模型误写的正文，禁止让模型手工复制、概括或精简正文。
- `prerequisites` 默认透传。每条补漏、去冗余或纠向都必须与 `generation.refinedPrerequisiteEdges` 一一对应。
- 新增 `clusterIds / role / related`；多簇归属保持克制，首个 `clusterIds` 为主簇。
- `related` 与任一方向的 `prerequisites` 互斥；优化后仍须为 DAG。

必须依次运行：

```text
course_pipeline {"action":"assemble-graph","courseId":"<course-id>"}
course_pipeline {"action":"assemble-graph-check","courseId":"<course-id>"}
course_pipeline {"action":"check-graph","courseId":"<course-id>"}
```

任一命令失败时停留在 G6 定点修复，不得进入发布。

### G6_PREREQUISITE_REVIEW

- G6 的三项图校验全部通过后，必须让用户审核最终 `prerequisites`。第一版审核范围只包含先修边，不允许在审核页修改 `clusterIds`、`role`、`related`、标题或正文。
- 运行：

```text
course_pipeline {"action":"review-prerequisites","courseId":"<course-id>"}
```

- 命令会先验证 G2 身份回执。返回 `status: "pending"` 时，简短告知用户到依赖关系审核页处理，然后**结束当前 turn**；不要调用通用 `question`，不要进入 G7 或尝试发布。
- 上述动作在写审核 request marker 前必须通过 `check-pipeline.mjs "$CONTENT_ROOT" "$GRAPH_FILE" --phase all --pre-review prerequisites`。该检查覆盖完整内容、图谱与当前 G2 回执；任一失败都不得创建 marker 或声称已进入依赖审核。
- 审核页只提交带原因的 prerequisite `add` / `remove`。后端拒绝悬空、自环、重复、与 `related` 冲突或成环的变更，并机械重建 `refinedPrerequisiteEdges` 审计记录。
- 下一 turn 必须重跑 G6 校验和上述命令。只有返回 `status: "approved"`，且回执同时绑定当前知识点身份哈希、最终 prerequisite 边集哈希与边审计哈希时，才能进入 G7。边审计哈希的规范输入按 `generation.refinedPrerequisiteEdges` 当前顺序保留各项，并把每项规范为字段值去除首尾空白的 `{op,from,to,reason}`；不得排序或丢弃审核重放记录。

### G7_RELEASE_READY

依次执行：

```text
course_pipeline {"action":"assemble-graph-check","courseId":"<course-id>"}
course_pipeline {"action":"check-graph","courseId":"<course-id>"}
course_pipeline {"action":"check-pipeline-json","courseId":"<course-id>"}
```

只有三条命令均退出 0，`check-pipeline.mjs --json` 明确返回 `ok: true` 且 `counts.reviewApprovals: 2`，G2 与 G6_PREREQUISITE_REVIEW 的审核回执仍有效，且 G5 的全量内容校验、脚本测试和必要动画验收已有证据时，才能声明中间产物合格。不得称其为已布局或已发布的 CKDS 森林包。

最终发布工具会把已验收动画源码做目标项目生产构建，生成带 SHA-256 完整性清单的独立 iframe 运行包；构建、依赖边界或资产完整性失败时整次发布原子失败。不得把源码直接接入主前端，也不得为了通过发布而删除非空动画清单。
发布工具必须先把 `course-content`、`clustered-graph.json` 和后端审批目录复制到同一不可变临时快照，再对该快照执行 G7、动画构建和发布前指纹复核。最终只能发布快照数据；验证期间源工作区发生变化不得混入发布结果，成功或失败后都要清理临时目录。

## 恢复与失效

- 依次运行上游 `index / points / all` 校验来定位最早可复用阶段，不凭文件存在判断成功。
- G1 身份冻结后若 `id/title/order` 改变，G3–G7 全部失效。
- G2 审核后的 `id/title/order` 改变会立即使知识点审核回执失效；必须重新进入完整清单审核。
- 任一 point 内容、动画绑定或 `prerequisites` 改变，G5–G7 全部失效；最终 prerequisite 边集变化还会立即使依赖审核回执失效。
- `check-pipeline.mjs` 报内容漂移、点顺序变化或边审计不匹配时，图立即视为过期。
- 普通聊天消息、模型总结、通用 question 回答或模型可写目录中的文件都不能替代后端审核回执。
- 不覆盖已通过产物，除非用户明确要求重建；不删除问题点、关系或动画来伪造通过。

## 校验器用法

只校验内容包：

```text
course_pipeline {"action":"check-content-all","courseId":"<course-id>"}
```

校验最终交接：

```text
course_pipeline {"action":"check-pipeline-json","courseId":"<course-id>"}
```

校验器复用上游 `validateProject()`，并额外检查 subject/courseId、点集与顺序、全部内容字段透传、关系字段边界、角色约束、关系互斥、先修边差异及其审计记录；带 graph 的最终交接还必须从模型不可写目录读取两份审批回执并复算身份与 prerequisite 边集哈希。

## Dry-run 输出

`dry-run` 是固定机器接口。第一个非空字符必须是 `{`，最后一个非空字符必须是 `}`，不得包含反引号、说明文字或额外键；输出必须与下方对象完全一致：

```json
{"pipelineSkill":"knowledge-pipeline-orchestrator","mode":"dry-run","gates":["G0_SCOPE","G1_INDEX","G2_IDENTITY_REVIEW","G3_CONTENT","G4_ANIMATIONS","G5_CONTENT_READY","G6_GRAPH","G6_PREREQUISITE_REVIEW","G7_RELEASE_READY"],"artifacts":["course-content/","clustered-graph.json"],"blockingPolicy":"stop-on-point-prerequisite-or-animation-review"}
```

## 最终报告

只报告：运行模式与路径、已通过门禁、知识点与依赖审核状态、index/详情/复核/来源数量、动画请求/类型/组件及人工验收状态、簇与多簇点数量、前置边/优化边/打破环边数量、校验/测试/构建结果、警告和阻断项。不粘贴完整点集、JSON 或动画源码。

## 禁止项

- 不生成或继续使用旧 `candidate-points.json`。
- 不把 `clustered-graph.json` 放进上游独占内容目录。
- 不让图阶段改写正文或未经审计修改 `prerequisites`。
- 不用通用 question、聊天文本或模型生成文件代替知识点/依赖审核页与后端回执。
- 不在知识点审核前创建详情任务，不在依赖审核前进入 G7 或发布。
- 不在动画未实际验收时宣称 G5/G7 通过。
- 不生成布局字段，不把中间产物伪装成 CKDS 发布包。
