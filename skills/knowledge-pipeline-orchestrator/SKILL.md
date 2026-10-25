---
name: knowledge-pipeline-orchestrator
description: 端到端编排 v2 课程知识流水线：生成完整课程内容与教学动画，通过 G2 知识点和 G6 知识图谱两次结构化用户审核，再发布支持多簇归属与可审计关系的课程。用于完整生成、恢复、校验或干跑课程内容与知识图谱流水线。
---

# v2 知识流水线编排

串联课程内容生成与知识聚类两个子 Skill，保持阶段可恢复、两次结构化审核不可绕过、跨阶段修改可审计。受信脚本一律通过 `course_pipeline` 工具的固定 action 执行；不得直接调用 Bash、拼接脚本路径或让模型自报校验成功。

## 路径与模式

先确定稳定的 `<course-id>`。当前会话使用固定路径：

```text
pipeline/<course-id>/
├── course-content/
├── clustered-graph.json
└── textbook-outline.json  # 仅教材模式（PDF 或 Markdown）
```

确定一种模式：

- `full`：从课程名或领域名依次完成全部门禁。
- `textbook`：从后端绑定的两层教材结构开始，章节归属在 G1 冻结并贯穿 G6。
- `resume`：从现有产物和审核回执定位最早未通过阶段，不重建已通过阶段。
- `validate`：只调用固定校验 action，不改写课程内容。
- `dry-run`：只返回本文规定的固定状态对象。

旧 `candidate-points/1.0` 和 `clustered-graph/1.0` 不能作为 v2 恢复输入。除非用户明确要求迁移，否则从 G1 生成到新目录。

## 载入子 Skill

进入相应阶段前完整读取：

1. 内容阶段：`candidate-knowledge-point-generator/SKILL.md`、`data-contract.md`、`orchestration.md`、`animation-contract.md`。
2. 图阶段：`knowledge-cluster-builder/knowledge-cluster-builder/SKILL.md`、关系启发式、Schema。
3. 教材模式：在上述 Skill 之前读取 `textbook-outline-generator/SKILL.md`。

同名打包内容 Skill 与 canonical 副本有任何差异时，以 `duplicate-skill-drift` 阻断。

## `course_pipeline` 调用规则

只传两个结构化参数：

```json
{"action":"<fixed-action>","courseId":"<course-id>"}
```

`courseId` 必须是小写 kebab-case。不得把路径、命令、Shell 运算符或额外参数放进工具调用。子智能体没有该工具权限。

## 门禁状态机

严格按顺序推进。失败时保留产物、定点修复并重跑，不得跳过。

### G0_SCOPE

- 确认课程、受众、深度、范围、排除项和学习成果。
- 只有会显著改变知识点集合的关键歧义才询问用户。
- 调用 `init` 创建安全占位和目录。

### G1_INDEX

- 普通课程只生成 `course.json`、`generation/manifest.json` 和完整 `index.json`。
- 绑定 `material.json/full.md` 的教材课程只由模型生成 `course.json`、完整 `index.json` 和
  `textbook-outline.json`；随后调用 `sync-textbook-manifest`，由受信脚本生成完整 manifest。
  不得用 `write` 手工展开 sources、pointEvidence 或 sourceSpans。
- 冻结 index 的 `id`、`title` 和数组顺序；`pointEvidence` 必须同序。
- 不生成详情、动画实现、知识簇、关系或布局字段。
- 调用 `validate-index`，失败则修复后重跑。
- 教材模式必须先用 `textbook-outline.json` 决定完整点集，依次调用
  `sync-textbook-manifest`、`validate-textbook-outline`、`validate-index`；不得从内容反向聚类出教材结构。
- 教材模式在 G1 只确定解析结果提供的章节包含关系和教材点顺序；不得在这一阶段生成或使用 `prerequisites`、`related` 或 cluster 关系来重构教材树。

### G2_IDENTITY_REVIEW

- 汇总 `core / boundary / needs-review`、低置信度项和 `reviewQueue`。
- 调用 `review-knowledge-points`。工具仅在 G1 校验通过后创建 `knowledge-points/G2_IDENTITY_REVIEW` 结构化审核请求。
- 返回 `pending` 后立即停止本轮。不得用普通 `question`、聊天文字或模型写入的请求标记替代审核。
- 只有后端签发且与当前有序 `id/title` 哈希一致的回执才允许 G3。增删、合并、重命名或换序都会使回执失效。

### G3_CONTENT

- 先调用 `init-points`；该 action 会验证 G2 回执，无有效回执时必须阻断。
- 按内容 Skill 的文件所有权和自适应拆分规则，让内容子智能体生成各自的 `points/<id>.json` 和同名动画请求。
- 每个内容任务的提示必须要求子智能体先加载 `candidate-knowledge-point-generator` Skill，
  再完整读取 session-local 的 `data-contract.md`、`animation-contract.md`、
  `schemas/point.schema.json` 和 `schemas/animation-request.schema.json`；教材模式还要读取
  `schemas/textbook-content.schema.json`。必须传完整索引项 JSON，不得用主智能体手写的不完整
  字段摘要代替合同。教材模式还必须从受信 manifest 原样注入对应点的
  `manifest.pointEvidence` 完整单项 JSON；`sourceSpans` 不得省略、摘要或重建。
- 第一波只覆盖合计 3–5 个知识点作为 canary。每个任务返回后立即调用
  `validate-point-drafts`，失败则把完整原始错误（包括 JSON parse error）发回原 worker 就地修复；
  原 worker 无法继续时只能转交拥有同一组互斥文件的 repair task。主智能体不得用 `edit`/`write`
  直接修改 worker 文件；一波全部通过后才启动下一波。
- 子智能体不得修改共享 index、manifest、清单或注册文件。
- 全局复核正文区分度、事实、前置引用与 DAG 后，依次调用：

  1. `validate-points`
  2. `sync-index`
  3. `validate-points`

- 教材模式中，G3 生成的 `prerequisites` 只能作为基于内容的候选语义关系；它们不改变 G1 冻结的章节、顺序、教材点身份或章节归属。
- 教材 Markdown 模式中，每个详情任务必须使用受信 manifest 中该点的 source spans，并读取
  `material.json/full.md` 中对应正文，传入点级证据包；manifest 声明
  `contentContract: "textbook-content/2.0"` 并保存
  `pointEvidence.origin/sourceSpans`。material 的 `chunk-*` ID 只用于分批读取，不能替换 manifest
  中的 `block-*` section ID。point 以有序 `content.blocks` 分开保存教材依据和模型补充；教材块
  的 spans 按块/数组顺序首次出现去重后必须与注入的 `pointEvidence.sourceSpans` 深度相等且
  顺序一致，模型块用 `basedOnBlockIds` 向前引用且不得引入清单外 span。教材点和受控扩展点都必须有
  非空教材锚点以及至少一个模型块；顶层 `sourceSpans/modelEnriched` 从 blocks 派生，不重复持久化。
  不得只根据目录标题自行编写全部正文。
- 内容 worker 写 JSON 后必须用 `read` 回读 point 和 animation request。文件中的 LaTeX 反斜杠
  必须编码成合法 JSON 的 `\\`，例如运行时 `\delta` 写成 `"\\delta"`；可优先使用
  `$...$`/`$$...$$`，但 LaTeX 命令仍须转义。

### G4_ANIMATIONS

- 调用 `init-animation-manifest` 后归并动画请求，只有真实动态机制才进入动画清单。
- 清单确定后调用 `init-animations`，再让动画子智能体按互斥所有权实现 TSX/CSS。
- 每个动画任务必须先加载候选内容 Skill 并完整读取 session-local `animation-contract.md`，同时获得完整
  manifest 单项和绑定知识点正文。第一个动画组件作为 canary；每个任务返回后立即调用
  `validate-animation-drafts`，失败则把原始错误交回同一任务修复。canary 通过后才启动其余组件。
- 串行调用 `build-animation-registry`；清单为空也必须执行。

### G5_CONTENT_READY

- 调用 `validate-all`，修复全部结构、动画源码、注册闭环和内容一致性错误。
- 动画可以在浏览器中观察质量，但本阶段不创建用户审核、不调用 `question`、不生成或要求人工动画凭据。
- 非空动画不得删除。最终发布仍会执行真实生产构建、依赖边界检查与完整性清单生成。

### G6_GRAPH

- 仅在 G5 通过后读取完整内容包并写 `clustered-graph.json`。
- 点集及 index 顺序不变。普通课程沿用现有图装配；声明 `textbook-content/2.0` 的教材课程使用
  `clustered-graph/3.0` 薄图，point 只保存
  `id/title/origin/clusterIds/role/prerequisites/related`，正文留在 canonical point 文件并由发布器读取。
- `prerequisites` 默认透传；每条增删必须与审核记录一一对应。
- 新增 `clusters / clusterIds / role / related`，不生成布局。
- `related` 必须双向声明，只表达横向联系；同一对点只要任一方向存在 prerequisite，就不得再写 related。
- 依次调用 `assemble-graph`、`assemble-graph-check`、`check-graph`。
- 教材模式不执行自由聚类：章节一一成为 cluster，点的首个 `clusterIds` 固定为所属章节。完成上述装配检查后再调用 `validate-textbook-graph`。
- G6 的关系工作是对内容完成后的 `prerequisites`、`related`、`role` 和次要簇做补充、审计和去环；它不能把语义关系反向当作教材树，也不能用聚类结果覆盖已冻结的教材章节结构。
- 图顶层使用 `sequences.cluster/point[{fromId,toId}]` 保存显式阅读顺序。章节相邻顺序写入
  cluster edges，同一章节内的点顺序写入 point edges；该关系独立于 prerequisites/related，
  必须无悬空引用、重复、自环和有向环。

### G6_GRAPH_REVIEW

- 调用 `review-knowledge-graph`。工具会先执行全量图谱预审核校验，再创建 `knowledge-graph/G6_GRAPH_REVIEW` 请求。
- 回执绑定完整簇定义、每点有序 `clusterIds`、`role`、`related`、全部 `prerequisites`，以及 `refinedPrerequisiteEdges`、`brokenCycleEdges` 审计。
- 返回 `pending` 后立即停止本轮。任何被绑定字段变化都会使回执失效，必须重新审核。

### G7_RELEASE_READY

依次调用：

1. `assemble-graph-check`
2. `check-graph`
3. `check-pipeline-all`
4. `publish`

最终 checker 必须确认当前内容/图谱和两份有效结构化回执。发布工具会对动画源码执行真实生产 bundle，生成带 SHA-256 完整性清单的独立 iframe 运行包；源码校验、生产构建、依赖边界或资产完整性任一失败时整次发布原子失败。发布不读取旧 G5 人工动画凭据。

## 恢复与失效

- 依次调用 `validate-index / validate-points / validate-all` 定位可复用阶段，不凭文件存在判断成功。
- G1 身份发生变化时，G2 回执和 G3–G7 全部失效。
- 教材模式的章节、章节顺序或点所属章节变化，视同 G1 身份变化。
- 点正文或动画变化后重新执行 G5–G7。
- 簇定义、`clusterIds / role / related / prerequisites` 或图谱审核记录变化后，G6 图谱回执和 G7 失效。
- `check-pipeline` 报内容漂移、点顺序变化或边审计不匹配时，图立即视为过期。

## 固定校验 action

- `sync-textbook-manifest`：只在绑定 material/full.md 的教材 G1 调用；校验输入后确定性生成
  v2 manifest、教材来源和逐点 source spans，避免模型手写大 JSON。
- `validate-point-drafts`：G3 每个详情任务返回后校验所有已开始的 point/request，跳过尚未开始的 `{}` 占位；不能替代最终 `validate-points`。
- `validate-animation-drafts`：G4 每个动画任务返回后校验已开始的 TSX/CSS，跳过成对 `{}` 占位并拒绝单侧完成；不能替代注册构建后的 `validate-all`。
- `check-content-all`：只校验内容包。
- `check-pipeline-json`：检查图谱交接并返回机器结果。
- `check-pipeline-all` / `check-pipeline-all-json`：执行最终全量门禁。
- `validate-textbook-outline` / `validate-textbook-graph`：分别校验两层教材树与索引、最终章节映射；只在教材模式调用。

最终全量门禁必须显示 `reviewApprovals: 2`。

## Dry-run 输出

输出必须与下方对象完全一致：

```json
{"pipelineSkill":"knowledge-pipeline-orchestrator","mode":"dry-run","gates":["G0_SCOPE","G1_INDEX","G2_IDENTITY_REVIEW","G3_CONTENT","G4_ANIMATIONS","G5_CONTENT_READY","G6_GRAPH","G6_GRAPH_REVIEW","G7_RELEASE_READY"],"artifacts":["course-content/","clustered-graph.json"],"blockingPolicy":"stop-on-identity-or-graph-review"}
```

## 最终报告

只报告运行模式、路径、已通过门禁、两类审核状态、知识点/详情/来源数量、动画类型与组件、簇与关系数量、校验和生产构建结果、警告和阻断项。不粘贴完整 JSON 或动画源码。

## 禁止项

- 不生成或继续使用旧 v1 中间产物。
- 不让图阶段改写正文或未经审计修改先修关系。
- 不让 Agent 直接运行本地脚本。
- 不用普通对话确认代替结构化审核。
- 不为发布删除非空动画清单。
- 不在中间产物中生成森林布局字段。
