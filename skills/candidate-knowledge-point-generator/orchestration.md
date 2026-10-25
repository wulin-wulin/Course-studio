# 子智能体编排规范

## 目标

在不牺牲全局一致性的前提下，把详情和动画实现拆成可并行、文件所有权互斥的任务。并行只用于独立文件；索引、清单、注册表和全量校验始终串行。

## 阶段门

严格按以下顺序推进：

```text
范围与证据
  → 规划 index
  → index 校验
  → points 任务
  → points 全局复核
  → index 同步
  → 动画请求归并
  → 动画组件任务
  → 动画注册构建
  → 全量校验
```

上一个阶段未通过时，不启动下一个阶段。不要让子智能体在缺少全量 ID 注册表时猜测前置关系。

## 文件所有权

### 主智能体独占

```text
src/data/course.json
src/data/index.json
src/data/courseKnowledge.ts
src/components/AnimationBlock.tsx
src/components/AnimationBlock.css
generation/manifest.json
generation/animation-manifest.json
```

### 详情任务独占

每个知识点由一个且仅一个任务拥有：

```text
src/data/points/<point-id>.json
generation/animation-requests/<point-id>.json
```

一个小批次任务可以拥有 3–5 组上述文件，但不同任务的 ID 集合必须互斥。
文件一旦分配给详情任务，主智能体不得用 `edit`/`write` 代替该任务修改它；需要返工时继续交给
原 worker，或先结束旧所有权再创建拥有同一组文件的单一 repair task。

### 动画任务独占

每个动画机制由一个且仅一个任务拥有：

```text
src/animations/<Component>.tsx
src/animations/<Component>.css
```

动画任务不得修改 points、动画清单、类型文件、注册组件或其他动画的文件。

## 自适应拆分

### 一任务一点

满足任一条件时单独分配：

- `importance >= 0.85`；
- `difficulty` 为 `进阶`；
- 需要严谨公式、证明、复杂流程或多步推导；
- 预计有 3 个以上直接前置；
- 是高出度基础点，错误会传播到大量后续内容；
- 很可能需要机制动画；
- 名称、边界或事实归属仍有争议。

### 3–5 点小批次

仅当所有点都满足以下条件时合批：

- 基础或中等难度；
- 定义和边界稳定；
- 正文不依赖长推导；
- 共享相近的直接前置或比较语境；
- 合批有助于避免重复，而不是仅因索引相邻。

一个任务最多 5 点。不得把整门课程交给一个详情子智能体。

## 并发策略

- 先生成全部任务清单和文件所有权映射，再启动并发。
- 第一波必须是合计 3–5 个知识点的 canary；只有这一波全部通过草稿校验，才扩大并发。
- canary 通过后，内容详情 worker 默认以 10 个互斥任务一波并发；只有平台明确限流或任务失败时才降为更小波次，并记录降级原因。动画任务仍须遵守首个 canary 通过后逐任务验收的规则。
- 同一依赖邻域可并行写详情，因为前置 ID 已冻结；不得根据尚未完成的正文发明新 ID。
- 每个任务返回后，主智能体立即调用 `validate-point-drafts`；失败时先让原任务按精确错误
  就地修复。当前一波全部通过后，才启动下一波。
- 子智能体失败不影响其他互斥任务；只重试失败任务。

## 详情任务输入

每个详情任务都必须获得以下完整上下文：

1. `course.json`；
2. manifest 中的受众、深度、范围、排除项和学习成果；
3. 自己负责的完整索引项；
4. 全量合法 prerequisite ID 与 `id → title` 注册表；
5. 为本任务筛出的建议前置候选；
6. 与负责知识点直接相关的来源记录；
7. 完整的索引项 JSON，不得由主智能体手写省略字段的摘要；
8. 教材模式下，从受信 `generation/manifest.json` 原样复制的本任务各点
   `manifest.pointEvidence` 完整单项 JSON，尤其是完整、有序的 `sourceSpans`；
9. session-local 的 [SKILL.md](SKILL.md)、[data-contract.md](data-contract.md)、
   [animation-contract.md](animation-contract.md)、`schemas/point.schema.json` 和
   `schemas/animation-request.schema.json` 的明确路径；教材模式还要提供
   `schemas/textbook-content.schema.json`；
10. 本任务可写文件的绝对或相对路径；
11. 禁止修改的共享文件列表。

任务提示必须明确要求子智能体先加载 `candidate-knowledge-point-generator` Skill，再完整读取
上述合同/Schema（教材模式包含第五份内容块 Schema）；只给文件路径或转述部分字段都不算
完成合同注入。子智能体没有
`course_pipeline` 权限，正式校验由主智能体在每个任务返回后执行。

教材 Markdown 模式还必须为每个任务提供点级证据包，而不是只给标题：

- `origin` 与教材锚点；所有非教材点（`llm-extension` 或 `user`）必须提供同章教材
  `anchor_point_id`；
- 该点完整的 `manifest.pointEvidence` 单项 JSON；其中 `sourceSpans` 是 worker 唯一可写入
  provenance 的 span 清单。教材原有点必须按受信 manifest 的既定顺序完整覆盖全部 section 及
  正文行，所有非教材点必须使用受信 action 为 `anchor_point_id` 确定的非空证据子集；
- span 对应的正文 section，以及必要的前后相邻 section；
- section 的 heading path、行号、页码、资源引用和摘要哈希；
- 哪些说明来自教材，哪些部分允许模型补充。

manifest 声明 `contentContract: "textbook-content/2.0"` 时，扩展点也必须分配非空教材锚点
span；该 span 对应的教材块只描述锚点上下文，扩展出来的新结论写入模型块。

长教材按 `material.json.chunks` 分批读取。`chunk-*` ID 只用于定位读取批次，不是 canonical
source span；详情任务不得用 chunk ID 替换 manifest 中的 `block-*` section ID，不得自行扫描
整本 Markdown，也不得把其他知识点的大段正文复制进当前上下文。

不要把其他数百个知识点的完整正文塞入任务；全量注册表只提供 ID、标题、摘要和难度。

## 详情任务提示模板

将方括号替换为真实内容：

```text
你负责课程 [课程名] 的以下知识点详情：
[索引项 JSON]

受众与范围：
[范围契约]

全量知识点注册表：
[id/title/shortSummary/difficulty 列表]

可核对来源：
[来源记录]

教材点级证据（仅教材 Markdown 模式）：
[manifest.pointEvidence 完整单项 JSON，包含 origin/sourceSpans]
[sourceSpans 对应正文与相邻上下文]

只允许写：
[points 文件路径]
[animation request 文件路径]

开始写文件前必须依次完成：
1. 加载 `candidate-knowledge-point-generator` Skill。
2. 完整读取下列 session-local 文件：
   - [data-contract.md 的路径]
   - [animation-contract.md 的路径]
   - [point.schema.json 的路径]
   - [textbook-content.schema.json 的路径，仅教材模式]
   - [animation-request.schema.json 的路径]

Schema 快速核对（不能替代读取原文件）：
- 普通课程 v1 的 `keyTerms`、`principles`、`applications`、`misconceptions` 都是非空字符串数组，
  `qa` 是至少两项的 `{ "q": string, "a": string }[]`；
- 教材 v2 不写旧正文栏目，改用 `content.schema_version="textbook-content/2.0"` 和有序 blocks；
- 教材 v2 先写 outcome-first 的 `learningDesign`，默认 `adaptationLevel: "balanced"`；每个 block
  用 `moduleId/depth` 接入教学模块，有明确学习目的的交互内容写入带 grounding 和 fallback 的
  `learningAssets`；
- 教材块必须带 `quote|paraphrase` 与非空 spans，模型块必须用 `basedOnBlockIds` 向前引用并
  追溯到教材块；
- 模型块按依据就近插入：单锚点补充紧跟锚点，多锚点补充放在最后一个被引用块之后；不得把所有
  模型块集中堆在全部教材块末尾；
- 教材块中的 spans 按块顺序和数组顺序首次出现去重后，必须与上方
  `manifest.pointEvidence.sourceSpans` 深度相等且顺序一致；不得自行生成或改用 `chunk-*` ID；
- JSON 文件中的 LaTeX 反斜杠必须写成合法的 `\\`，例如运行时 `\delta` 写作 `"\\delta"`；
  可优先用 `$...$`/`$$...$$`，但命令中的反斜杠仍要转义；
- `difficulty` 只能是 `基础`、`中等`、`进阶`；
- 动画请求 `needed: true` 时，`mechanism` 恰好包含 `inputs/changingState/transitionRule/terminalState/replayMode`，并包含 `suggestion`；
- 动画请求 `needed: false` 时不得出现 `mechanism` 或 `suggestion`。

任务：
1. 为每个索引项生成一个完整 points JSON。
2. id、title 必须与索引完全一致；不得创建新知识点 ID。
3. prerequisites 只能从全量注册表选择，并保持最小必要集合。
4. 必填内容必须具体、可教学、非模板化；可选事实字段只在适用且可核实时生成。
5. point 初稿写 animationType: "none"。
6. 为每个 point 生成一个动画请求；只有真实动态机制才写 needed: true。
7. 写完后必须用 `read` 回读自己拥有的 point 和 animation request，检查 JSON 结构与 LaTeX
   反斜杠的物理转义；未回读不得结束。
8. 教材模式下按 `textbook-content/2.0` 写 blocks：教材块保留精确 spans，模型块显式引用
   前面的教材上下文并按依据就近插入，不得集中堆到正文末尾。教材块 span 的有序去重并集必须精确等于注入的完整
   `manifest.pointEvidence.sourceSpans`；模型块不得引入清单外 span。不要把未读正文交给模型块
   补齐引用。不要在 point 顶层重复写 sourceSpans/modelEnriched；校验器会派生并与 pointEvidence
   的证据计划核对。不得把模型补充伪装成教材原文。
9. 教材模式先按学习目标设计 outcomes、misconceptions、modules 与 completion，再组织 blocks。
   默认 balanced，允许重排教学顺序、压缩重复、增加类比/案例/练习/动画/桥接；faithful 保留教材
   术语和主要顺序，只做去重、澄清与必要检查；teaching-first 可围绕任务重建叙事、合并或拆分讲解。
   三档都不能改变教材事实、定义、公式、数值、边界和完整覆盖。不要使用固定 token 百分比。学习资产必须声明
   `anchorBlockId/outcomeRefs/learningPurpose/grounding/fallback`，引用不得悬空。
   modules 按通用学习骨架和知识类型动态选择，通常为 4–7 个；概念型突出边界与正反例，定量型突出
   变量/单位/假设/推导/参数实验，流程型突出条件/分支/错误恢复，比较型突出统一维度与取舍，诊断型
   突出症状到修复的证据链，案例型突出决策、结果、反思与迁移。不要在正文重复顶部 outcomes。
   estimatedMinutes 必须包含阅读、公式/表格、互动和练习的总用时。若填写
   `completion.nextPointId`，只能使用冻结 index 中的直接下一点；末点省略。

禁止修改 index、manifest、动画清单、注册文件和任何未授权路径。

你返回后，主智能体会立即执行：
`course_pipeline {"action":"validate-point-drafts","courseId":"[course-id]"}`。
只有输出明确报告草稿校验通过、已校验知识点数和待生成数，任务才算验收；失败时主智能体会把
完整原始校验错误（包括任何 JSON parse error）发回本任务，你必须只修复自己拥有的文件并重新
等待验收；主智能体不会直接编辑这些文件。

最终只报告：写入文件、使用的前置 ID、动画请求结论、仍有疑问的事实。
```

## 逐任务验收

每个详情任务返回后，主智能体必须立即调用：

```text
course_pipeline {"action":"validate-point-drafts","courseId":"<course-id>"}
```

该动作跳过尚未开始的 `{}` 占位，只对已经开始的 point/request 成对执行正式 Schema 和
一致性校验，并报告已校验数与待生成数。校验失败时，把完整错误和原文件所有权发回同一任务，
修复并重新校验；主智能体不得直接 `edit`/`write` 详情文件，任何 JSON parse error 也必须原样
交回有该文件所有权的 worker。不得等整门课程完成后一次性汇总错误。草稿校验通过后，主智能体还至少检查：

- 两个预期文件都已生成；
- 文件内部 ID 与文件名、冻结索引一致；
- 没有 cluster/layout 或生成审查字段；
- 必填数组达到下限且没有重复；
- `prerequisites` 全部存在、无自引用；
- 动画请求 `pointId` 一致；
- `needed: true` 时五项机制信息完整；
- 正文不是标题替换式模板。

结构错误可直接重试；事实边界错误应附上证据和明确修订要求。

## 失败与重试

1. 第一次失败：把精确校验错误和原任务文件所有权发回同一子智能体。
2. 第二次失败：缩小为一任务一点，并要求只修复列出的错误。
3. 仍失败：结束原任务后创建一任务一点的 repair task，并转交同一文件所有权和全部原始错误；
   主智能体不得直接编辑文件，也不得让两个任务同时拥有同一路径。
4. 发现索引本身错误：暂停受影响任务，由主智能体串行修订索引和 manifest，再重新生成任务清单。

不得用忽略校验、删除问题字段或把引用改为空数组来掩盖错误。

## 全局 points 复核

逐任务校验不能替代全局复核。全部详情完成后检查：

- 标题、英文名、缩写和别名的重复；
- 普通点的 `coreIdea` 或教材点的 blocks 是否能清楚区分；
- 摘要、难度和重要性是否使用统一尺度；
- 前置关系是否为真正的学习依赖；
- 是否存在环、孤立的高级点或缺失的基础点；
- 高频模板句、空泛应用、虚构历史和伪精确年份；
- 公式符号是否定义、JSON 和 LaTeX 是否正确转义；
- 所有点是否都提交了动画请求。

只有全局复核完成后才同步 index。

## 动画请求归并

主智能体可以让单独的规划子智能体只读分析全部请求并返回清单提案；`generation/animation-manifest.json` 仍由主智能体审查后串行写入，文件所有权不转移。

归并步骤：

1. 删除不能回答“哪个状态按什么规则改变”的请求。
2. 按输入、状态、转移规则和终态进行机制匹配。
3. 同一机制合并为一个类型，并为每个知识点原样保留请求中的专属 suggestion。
4. 机制不同则拆分，即使主题名称相似。
5. 检查每个 `needed: true` 点恰好绑定一次。
6. 使用有语义的 lowerCamelCase 类型名和 PascalCase 组件名。

动画规划器不能写组件源码。

## 动画任务提示模板

```text
你负责实现一个教学动画机制：
[animation manifest 单项 JSON]

引用它的知识点摘要：
[绑定知识点的 title 与 v1 coreIdea/principles 或 v2 相关 content.blocks]

只允许写：
src/animations/[Component].tsx
src/animations/[Component].css

开始写文件前必须依次完成：
1. 加载 `candidate-knowledge-point-generator` Skill。
2. 完整读取 [animation-contract.md 的绝对路径]；只给路径或转述摘要不算读取合同。

要求：
1. 准确展示输入、关键中间状态、更新规则和终态/循环边界。
2. 提供重播；涉及随机性时使用可复现 seed，并区分重播与重新生成。
3. 使用响应式 SVG/React/CSS，提供 aria-label、role="img" 和 <title>。
4. 支持 prefers-reduced-motion，静态终态仍可读。
5. 清理全部定时器、动画帧、监听器、观察器和图形资源。
6. CSS 类使用组件命名空间，不修改全局元素选择器。
7. 不修改注册表、类型文件、points、manifest 或其他动画。

完成后说明输入、变化状态、规则、终态和可自动复现的质量检查方式。

你返回后，主智能体会立即执行：
`course_pipeline {"action":"validate-animation-drafts","courseId":"[course-id]"}`。
失败时主智能体会把原始校验错误发回本任务；你必须只修改自己拥有的 TSX/CSS 并等待重验。
```

## 动画任务源码检查

- 组件和同名 CSS 均存在；
- 组件默认导出且根视图含 `animation-stage`；
- SVG 有 `role="img"` 和 `<title>`，根视图有准确中文 `aria-label`；
- 标签能解释变化规则，颜色不是唯一信息通道；
- CSS 有组件命名空间和低动态降级；
- 重播回到同一初始条件；重新生成才改变随机样本；
- effect 清理覆盖所有副作用；
- 机制与清单中所有绑定点都一致。

第一个动画组件必须作为 canary，返回后立即执行 `validate-animation-drafts`；只有它通过后才启动其余组件。
后续每个任务也在返回后立即校验，失败则交回原任务修复。该 action 跳过成对的 `{}` 占位，但拒绝只完成
TSX/CSS 一侧，并对已开始组件执行完整源码契约检查。所有动画任务通过后，才由主智能体通过
`course_pipeline` 固定 action 构建注册层。本检查不创建人工审核凭据。

## 最终串行步骤

```text
course_pipeline: validate-point-drafts（每个详情任务返回后；只验收草稿）
course_pipeline: validate-points
course_pipeline: sync-index
write animation-manifest
animation component tasks
course_pipeline: validate-animation-drafts（每个动画任务返回后；首个组件为 canary）
course_pipeline: build-animation-registry
course_pipeline: validate-all
course_pipeline: publish（G6 图谱审核通过后，内部执行生产构建）
```

任何串行步骤失败时，停止发布并修复根因；不要在失败状态下继续添加更多内容。
