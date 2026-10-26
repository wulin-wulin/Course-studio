---
name: candidate-knowledge-point-generator
description: 从课程名或领域名生成可审查的课程内容中间包。先建立无知识簇和布局字段的全量 index.json，再由受信 action 为每个知识点生成只读任务包、让子智能体按波次并发生成丰富的 points JSON，归并并实现必要的 React 教学动画，最后同步索引并执行全量校验。用于创建课程知识点内容、扩展候选知识点为完整详情，或为后续 CKDS 聚类与布局阶段准备数据。
---

# 候选知识点与课程内容生成

## 目标

输入一个课程名或领域名，生成 CKDS 发布前的课程内容中间包：

```text
generated/<course-id>-course-content/
├── generation/
│   ├── manifest.json
│   ├── animation-manifest.json
│   └── animation-requests/
│       └── <point-id>.json
└── src/
    ├── animations/
    │   ├── <AnimationComponent>.tsx
    │   └── <AnimationComponent>.css
    ├── components/
    │   ├── AnimationBlock.tsx
    │   └── AnimationBlock.css
    └── data/
        ├── course.json
        ├── courseKnowledge.ts
        ├── index.json
        └── points/
            └── <point-id>.json
```

该产物用于内容生成和审查，不是可直接发布的 CKDS 1.0 森林包。后续阶段再补充知识簇与布局。

## 不变量

1. 先完成全量规划索引，再启动详情子智能体。
2. 全包不得出现 `clusters`、`clusters.json`、`clusterId`、`pos`、`scale`、`polygon`、`labelPos` 或簇配色字段。
3. `index.json` 中的 `id`、`title` 和数组顺序在详情生成期间冻结。
4. 每个知识点恰好对应一个 `points/<id>.json` 和一个 `animation-requests/<id>.json`。
5. 详情中的 `prerequisites` 只引用本课程稳定 ID，且整体构成有向无环图。
6. 每个非 `none` 的 `animationType` 必须有真实组件、样式、类型声明和注册分支。
7. 子智能体只修改自己拥有的文件；共享文件由主智能体或确定性脚本串行生成。
8. `OUTPUT_ROOT` 必须是该中间包独占的目录，不得指向现有应用根目录，也不得含无关文件或符号链接；需要集成时先在独立目录通过校验再复制产物。

完整字段见 [data-contract.md](data-contract.md)，调度规则见 [orchestration.md](orchestration.md)，动画规则见 [animation-contract.md](animation-contract.md)。
详情 worker 与动画 worker 的执行规则分别见 [content-worker-brief.md](content-worker-brief.md) 和
[animation-worker-brief.md](animation-worker-brief.md)。

## 输入解释

唯一必填输入是课程名或领域名。用户提供的受众、深度、语言、范围、排除项和输出目录优先于默认值。

只有名称时：

- 课程名：按一学期主流教学范围和惯常受众解释。
- 领域名：覆盖稳定的基础到中级主干，排除品牌产品、短期热点和证据不足的前沿微主题。
- 输出语言：`zh-CN`，保留常用英文名、缩写和真实别称。
- 输出目录：`generated/<course-id>-course-content/`。

只有当同一名称的不同解释会显著改变知识点集合时，询问一个能消除最大歧义的问题；否则采用教育语境中最常见的解释并记录假设。

## 工作流

### 1. 建立范围契约

在 `generation/manifest.json` 中明确：

1. 目标学习者；
2. 覆盖深度；
3. 纳入边界；
4. 排除边界；
5. 完成课程后应具备的能力。

不要用固定知识点数量代替范围定义。

### 2. 收集可追溯依据

外部检索可用时，至少核对 3 个相互独立的权威来源，并覆盖至少 2 类：

- 官方课程标准、培养方案或专业知识体系；
- 公认教材目录、术语表或索引；
- 高质量大学课程大纲；
- 专业组织标准、权威手册或领域综述。

打开原始页面或文档核对；搜索摘要不能作为唯一依据。记录来源 ID、类型、标题、定位信息和访问日期，不得编造 URL、ISBN、年代或支持关系。

无法检索时将 `evidenceMode` 设为 `model-only`，来源保持为空，知识点置信度不得高于 `0.6`，边界项进入复核队列。

当编排 Skill 提供绑定的教材 `material.json/full.md` 时，使用
`evidenceMode: "textbook-grounded"` 和 `contentContract: "textbook-content/2.0"`，不再执行普通
主题的外部检索流程。点级证据包由 `prepare-content-tasks` 从受信 `generation/manifest.json` 中每个点
完整的 `manifest.pointEvidence` 单项机械生成，写入该点任务包的 `evidence`（`full.md` 路径和有序
`spans[].ref/headingPath/lineStart/lineEnd/assetRefs`）；主智能体不再读取正文构造证据包。worker 按
任务包行号读取对应正文。material 的 `chunk-*` ID 只控制读取批次，不是可写入详情的来源标识；
worker 只能使用任务包 spans 的 ref，不得从 chunk 自行重建 span，也不得用 chunk ID 替换 `block-*`
section ID。
教材原有点必须按 `material.point_sources` 的顺序读取并覆盖全部 section 正文；不能用一个章节标题
或局部摘录代表整个知识点。所有非教材点（`llm-extension` 或 `user`）必须有同章教材
`anchor_point_id`，并只读取该锚点允许的非空相关子集。
详情正文写入有序 `content.blocks`：教材块用 span ref 登记依据并标明 `quote|paraphrase`，模型块通过
`basedOnBlockIds` 指向前面的教材上下文。每个教材点和受控扩展点都必须同时包含教材块和模型
补充块；扩展点也要有非空教材锚点 span。不得只根据标题生成内容，也不得把模型补充伪装成
教材原文。

读取证据后先设计学习成果，再编排正文：为每个点填写 `content.learningDesign` 的 outcomes、
misconceptions、modules 和 completion，然后让 block 的 `moduleId/depth` 服务这些目标。默认采用
`adaptationLevel: "balanced"`：教材约束事实、定义、公式、数值、适用条件、边界和完整覆盖；模型
可重排教学顺序、压缩重复、增加类比、案例、练习、动画和桥接。不得用固定 token 百分比衡量教材
与模型内容；用允许/禁止动作、覆盖检查、冲突检查和 provenance 审计把握重编尺度。

三档控制的是教学重构动作，不是教材/模型文字占比：`faithful` 保留教材术语和主要讲解顺序，只做
去重、澄清与必要检查；`balanced` 围绕成果重排并补足理解、迁移与练习，作为默认档；
`teaching-first` 可按学习任务重建叙事、合并或拆分讲解，并把教材段落放到最有助于理解的位置。
无论哪一档，都必须覆盖完整证据范围，并用 block provenance 区分教材依据和模型补充。

### 3. 生成课程元数据与规划索引

普通课程先写 `src/data/course.json`、`generation/manifest.json` 和 `src/data/index.json`。绑定
`material.json/full.md` 的教材课程只手写 `course.json`、`index.json` 和教材结构；随后由主智能体
调用 `course_pipeline` 的 `sync-textbook-manifest`。教材模式不得让模型手写
`generation/manifest.json` 中的 sources、pointEvidence 或 sourceSpans。

高召回提取所有可独立定义、讲解并考核的知识点：

- 可分别定义和考核的并列项拆分；
- 固定术语或不可分机制不拆分；
- 章节名、作业名、人物、产品和单一案例通常不作为知识点；
- 上下位概念都具有独立教学价值时可以同时保留；
- 只合并真实同义词，不合并相关、近义或易混概念。

大领域分批提取并全局去重。所有范围维度已覆盖，且连续两轮独立查漏各自新增的有效知识点不足当前总数的 5% 时，才视为基本饱和。

规划索引只包含：

```text
id
title
shortSummary
difficulty
importance
keyTerms
```

`id` 使用稳定的 ASCII kebab-case；冲突使用有语义的限定词，禁止随机编号。普通课程为每个索引项在
manifest 的 `pointEvidence` 中按 index 同序记录冻结的 `pointId/title`、原子类型、来源、置信度和
范围状态。教材课程的 pointEvidence 由 `sync-textbook-manifest` 从结构与 material 机械生成，模型
不得重复展开。所有边界、待复核或低置信度点必须关联到 `reviewQueue`。

完成后由主智能体调用 `course_pipeline` 的 `validate-index`。索引阶段未通过前，不得生成详情；通过后还必须完成 `knowledge-points/G2_IDENTITY_REVIEW` 结构化审核。

索引阶段未通过前，不得生成详情。

### 4. 按任务包并发调度详情子智能体

G2 通过并调用 `init-points` 后，由主智能体调用 `course_pipeline` 的 `prepare-content-tasks`。它为 index
中每个知识点确定性生成一个只读任务包
`pipeline/<course-id>/worker-tasks/content/<point-id>.json`，并生成每点一行的注册表
`registry.json` 和只调度 `{}` 占位点的波次计划 `content-plan.json`。一任务一点，不再由模型自适应
合批：任务粒度一致能均衡每波的尾部延迟，主智能体的 task 提示也保持 O(1) 长度；已开始的点也保留
任务包，修复和返工时 repair task 始终有可信输入。

每个任务包包含：

1. `course.json` 和范围契约（manifest `subject`，附 evidenceMode/contentContract）；
2. 自己负责的完整冻结索引项与前后点序号；
3. 全量 `id/title/difficulty/shortSummary` 注册表路径，worker 需要选择前置时自行读取；
4. 按顺序列出的 session-local `SKILL.md`、[content-worker-brief.md](content-worker-brief.md)、数据契约、
   动画契约、point Schema、animation-request Schema（教材 v2 另加内容块 Schema），worker 写文件前
   必须完整读取；
5. 教材模式下由对应点 `manifest.pointEvidence` 机械投影出的 `evidence`；普通 `researched` 课程则是
   本点 `pointEvidence` 单项及其 `sourceRefs` 指向的来源记录 `sourceEvidence`；
6. 明确的文件所有权 `ownership.write` 与禁止修改清单 `forbidden`。

主智能体不得把索引项、注册表、`pointEvidence`、合同正文或模板规则粘贴或转述进 task 提示；只使用
[orchestration.md](orchestration.md) 中的固定短模板。

子智能体只写自己负责的：

```text
src/data/points/<id>.json
generation/animation-requests/<id>.json
```

不得修改 `index.json`、manifest、动画清单、注册文件或共享样式。
主智能体也不得用 `edit`/`write` 直接修改已分配给详情任务的文件；校验失败必须交回原 worker，
或在原 worker 无法继续时交给拥有同一组互斥文件的 repair task。

第一波是 `content-plan.json` 的 canary（按索引顺序前 min(3, 待生成数) 个待生成点）。之后每一波最多
k 个任务（k 来自 `COURSE_WORKER_CONCURRENCY`，默认 10），全部 task 调用都在同一条 assistant 消息里
一次性发出。每波返回后主智能体只调用一次 `course_pipeline` 的 `finalize-point-drafts`：它先把教材块
的 span ref 机械展开为可信 span，再执行与 `validate-point-drafts` 相同的草稿校验。canary 全部通过后
才扩大并发，canary 有失败时下一条消息只含 canary 的修复调用。之后不等待整波通过：`waves` 按队列
消费，失败点的完整、未经摘要的校验错误发回原 worker 会话，修复调用优先，新任务补足到 k 个，放
不下的顺延；只有平台明确限流（如 429）时才降低 k。报告的“待生成队首”中出现本条消息已派发的点，
说明 worker 没写文件，按失败处理。
同一点连续两次失败时只能创建同所有权 repair task，主智能体不得代写。子智能体不得自行运行校验脚本，最终完整 `validate-points` 仍是 G3
的硬门禁。

### 5. 按当前内容契约生成详情

普通 `researched/model-only` 课程继续使用栏目式 v1，每个详情必须包含：

- 索引 6 项元数据；
- `coreIdea`；
- 2–6 条 `principles`；
- 至少 1 个 `applications`；
- `aliases`，没有则为 `[]`；
- 准确的 `intuition`；
- 至少 1 条 `misconceptions`；
- 至少 2 组 `qa`，覆盖机制理解与应用/边界；
- `prerequisites`，没有则为 `[]`；
- 初始 `animationType: "none"`。

按事实适用性生成 `formula`、`comparisons`、`history`、`yearIntroduced`、`prosCons`、`visualType` 和 `visualSuggestion`。不适用时省略，不得为了字段数量编造内容。

`shortSummary` 说明“是什么或解决什么问题”；`coreIdea` 解释机制而不是复述摘要；原理每条只表达一个可验证要点；应用必须是真实任务或场景。

教材 `textbook-content/2.0` 详情保留索引元数据、`origin`、`prerequisites` 和动画字段，正文写入
`content.schema_version`、`content.learningDesign`、`content.blocks` 以及有明确学习目的时的
`content.learningAssets`。不得同时写旧正文栏目或顶层 `sourceSpans/modelEnriched`。
块类型、来源联合和完整字段以 `schemas/textbook-content.schema.json` 为准：

- 先定义 learning outcomes 和常见误区，再选择主要教学模式、模块、完成条件和预计时长；
- `adaptationLevel` 仅允许 `faithful|balanced|teaching-first`，默认显式写 `balanced`；
- 内容组织采用“问题导入、核心理解、应用活动、达成检查、下一点桥接”的通用骨架，并按概念解释、
  定量机理、操作流程、比较决策、故障诊断或案例分析选择类型模板；通常使用 4–7 个模块，按复杂度
  增减，不得机械凑齐固定栏目；
- 类型模板必须改变实际编排：概念解释突出定义、边界和正反例；定量机理突出变量、单位、假设、推导、
  算例和参数实验；操作流程突出前置条件、步骤、分支、错误恢复和检查表；比较决策使用统一维度并给出
  情境化取舍；故障诊断按症状、假设、证据、定位和修复组织；案例分析按情境、决策、证据、结果、
  反思和迁移组织。只在 `primaryPattern` 中改名、正文仍使用同一套栏目不算完成差异化重编；
- 顶部会自动展示 outcomes，正文不得再生成完整重复的学习目标块；`estimatedMinutes` 必须计入正文
  阅读、公式与表格理解、互动活动和练习作答的总时间；
- 每个 block 必须用 `moduleId` 命中一个 module，并用 `depth: core|support|advanced` 表示学习深度；
- 块数组顺序就是阅读顺序，ID 在点内唯一；
- 教材块至少一个，必须有非空 spans；worker 草稿中教材块的 `provenance.sourceSpans` 只写任务包
  `evidence.spans[].ref` 字符串（例如 `["block-000051"]`），不抄写 span 对象或哈希，由
  `finalize-point-drafts` 机械展开为精确 span；
- 教材块 ref 按块顺序和数组顺序的首次出现必须覆盖全部 ref 且与任务包 spans 顺序一致；展开后的
  spans 做首次出现去重，必须与完整 `manifest.pointEvidence.sourceSpans` 深度相等且顺序一致；
  不得使用 material 的 `chunk-*` ID 替换 manifest 中的 `block-*` section ID；
- 模型块至少一个，只能引用排在前面的块，并最终追溯到教材块；
- 模型块必须就近跟随它所依据的教材内容：单一锚点的补充放在该锚点之后，综合多个块的补充放在最后一个被引用块之后；不得先堆完全部教材块再集中追加所有模型块；
- 模型块不得引入 `pointEvidence.sourceSpans` 之外的新 span 或任务包之外的 ref；
- 模型块可补充解释、推导、例子、对比或练习，但标题和呈现必须让来源清楚；
- `learningAssets` 的每项必须有 anchor、目标引用、学习目的、可追溯 grounding 和无交互 fallback；
  类型自有参数放在 `config`，不得借此放入未经 provenance 支持的事实；
- `completion.nextPointId` 可省略；需要下一点桥接时只能填写冻结 `index.points[]` 中紧随当前点的
  稳定 ID（即任务包 `sequence.nextPointId`），末点不得填写；
- 点级 `sourceSpans` 和 `modelEnriched` 由校验器从 blocks 派生，不由任务重复填写。

所有 point 和 animation request 都是 JSON 文件。LaTeX 的每个反斜杠在文件中必须编码为合法
JSON 的 `\\`：例如运行时公式 `\delta` 要写成 `"\\delta"`，不能写成非法的 `"\delta"`；
Markdown 正文统一使用 `$...$` 或 `$$...$$`，不得使用 `\(...\)`、`\[...\]`、未包裹的
LaTeX 命令或可见的字面量 `\n\n`；`\frac` 等命令仍须写成 `\\frac`。worker 写完后必须用
`read` 回读自己拥有的两个 JSON 文件，检查物理文本中的转义、字段和闭合结构后才能返回。完整自检
清单见 [content-worker-brief.md](content-worker-brief.md)。

### 6. 提交动画意图

每个详情任务都写一个动画请求。请求必须回答：

- 输入或初始状态是什么；
- 哪个状态随时间改变；
- 每次变化遵循什么规则；
- 终态、收敛条件或循环边界是什么；
- 动画为什么比静态图更有教学价值。

仅当存在真实状态转移、迭代、传播、搜索、收敛、采样或反馈过程时标记 `needed: true`。分类、术语表和静态结构通常标记为 `false`。

### 7. 全局复核并同步索引

所有详情通过 `finalize-point-drafts` 后，串行检查：

1. 标题、别名和缩写造成的重复（教材来源点保留原始标题时，同名教材点按 `point.id` 区分，不视为生成重复）；
2. 模板化正文或同一句式批量替换；
3. 过宽章节和过细实现细节；
4. 悬空、自引用、重复或成环的前置关系；
5. 难度、重要性和摘要与目标受众是否一致；
6. 公式、历史、年份和事实归属是否可核实。

发现问题时按 [orchestration.md](orchestration.md) 的修复消息或 repair task 模板交回拥有该文件的
worker（任务包对全部点保留），修复后重新调用 `finalize-point-drafts`；主智能体不代写。

由主智能体依次调用 `course_pipeline` 的 `validate-points`、`sync-index`、`validate-points`。子智能体不得自行运行脚本。

同步脚本冻结 `id`、`title` 和顺序，只从详情回写 `shortSummary`、`difficulty`、`importance`、`keyTerms`。

### 8. 归并动画机制

主智能体读取全部动画请求，按真实机制归并，写出 `generation/animation-manifest.json`：

- 同一状态机或计算过程可以共享一个组件；
- 仅主题相近、机制不同的知识点不得共享；
- 一个需要动画的知识点必须且只能绑定一个动画类型；
- `needed: false` 的点不得进入动画清单。

清单为空也是合法结果。不要设置动画数量配额。

### 9. 实现动画组件

写好动画清单并调用 `init-animations` 后，由主智能体调用 `course_pipeline` 的
`prepare-animation-tasks`，为清单中每个唯一机制生成只读任务包
`pipeline/<course-id>/worker-tasks/animations/<Component>.json`，`animation-plan.json` 只调度 TSX/CSS
仍是占位的组件，每个机制启动一个独立子智能体。每个任务只拥有：

```text
src/animations/<Component>.tsx
src/animations/<Component>.css
```

每个动画任务提示使用 [orchestration.md](orchestration.md) 中的固定短模板，要求子智能体先加载
`candidate-knowledge-point-generator` Skill，完整读取任务包，再按任务包 `contracts` 顺序完整读取
`SKILL.md`、[animation-worker-brief.md](animation-worker-brief.md) 和 session-local 的
[animation-contract.md](animation-contract.md)，并自行读取 `boundPoints[].pointFile` 中的绑定知识点。
任务包原样携带完整 animation manifest 单项；主智能体不得把 manifest 单项、绑定知识点正文或合同
正文粘贴进提示。组件使用 React、SVG 和 CSS，除非三维空间关系确实不可替代。不得让多个动画任务
修改同一文件。

第一个动画组件必须作为 canary，单独派发；返回后主智能体调用 `course_pipeline` 的
`validate-animation-drafts`，失败时把完整错误发回原任务，在原 TSX/CSS 所有权内修复并重验。
canary 未通过前不派发其他组件。canary 通过后，其余组件按 `animation-plan.json` 每 k 个一波，在同一条
assistant 消息里并发发出；每波返回后只调用一次 `validate-animation-drafts`，失败组件的修复调用优先
并入下一条消息，新任务补足到 k 个。

全部组件通过草稿校验后，由主智能体串行调用 `course_pipeline` 的 `build-animation-registry`。

该脚本更新 points 中的动画字段，并生成 `courseKnowledge.ts`、`AnimationBlock.tsx` 和共享样式。即使没有动画也必须运行。

### 10. 全量校验

由主智能体调用 `course_pipeline` 的 `validate-all`。该校验覆盖结构、注册闭环和最低动态源码信号。可以额外观察重播、状态推进、低动态和响应式效果，但生成期不为正文或动画创建用户审核，不调用 `question`，也不签发人工动画凭据；真实生产 bundle、依赖边界和资产完整性由最终发布 action 强制执行。

如果输出目录所在项目提供 TypeScript 构建命令，再运行该构建。修复全部错误后重复校验；不得用局部 JSON 可解析替代全量通过。

## 最终报告

只报告：

- 采用的课程解释、受众、深度和输出目录；
- 规划知识点数、完成详情数和复核项数；
- 来源模式与来源数量；
- 动画请求数、归并后的动画类型数和组件数；
- index 同步、全量校验、脚本测试和可用构建的结果；
- 仍需人工判断的真实问题。

不要粘贴完整知识点列表、大段 JSON 或动画源码。

## 禁止项

- 不输出旧版 `candidate-points.json`。
- 不生成或暗含知识簇、章节归属和森林布局。
- 不把该中间包描述为现有 AI 知识森林可直接加载的 CKDS 1.0 数据。
- 不让并行子智能体修改共享文件或 `worker-tasks/` 任务包。
- 不在 task 提示中粘贴或转述索引项、注册表、`pointEvidence`、合同正文或模板规则。
- 不把中文标题、路径或未来占位符写入 `prerequisites`。
- 不为追求“丰富”生成重复、空泛或不可核实内容。
- 不用漂移、闪烁、旋转等装饰运动冒充原理动画。
