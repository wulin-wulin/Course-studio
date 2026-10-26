# 子智能体编排规范

## 目标

在不牺牲全局一致性的前提下，把详情和动画实现拆成可并行、文件所有权互斥的任务。并行只用于独立文件；索引、清单、注册表和全量校验始终串行。

任务上下文由受信 action 机械写入只读任务包，主智能体的每个 task 提示保持固定长度；这样全课程的
派发成本随知识点数线性增长，而不是随“点数 × 注册表长度”平方增长。

## 阶段门

严格按以下顺序推进：

```text
范围与证据
  → 规划 index
  → index 校验
  → G2 审核通过后 init-points
  → prepare-content-tasks
  → points canary 波 → points 并发波（每波 finalize-point-drafts）
  → points 全局复核
  → index 同步
  → 动画请求归并
  → init-animations → prepare-animation-tasks
  → 动画 canary → 动画并发波（每波 validate-animation-drafts）
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

### 受信 action 独占

```text
pipeline/<course-id>/worker-tasks/registry.json
pipeline/<course-id>/worker-tasks/content-plan.json
pipeline/<course-id>/worker-tasks/content/<point-id>.json
pipeline/<course-id>/worker-tasks/animation-plan.json
pipeline/<course-id>/worker-tasks/animations/<Component>.json
```

`worker-tasks/` 与 `course-content/` 同级，不属于课程内容包。它只由 `prepare-content-tasks` 与
`prepare-animation-tasks` 确定性生成；主智能体和全部 worker 只读，不得手写、修改或删除。

### 详情任务独占

每个知识点由一个且仅一个任务拥有：

```text
src/data/points/<point-id>.json
generation/animation-requests/<point-id>.json
```

任务包 `ownership.write` 精确列出这两条会话相对路径；不同任务的点互斥。
文件一旦分配给详情任务，主智能体不得用 `edit`/`write` 代替该任务修改它；需要返工时继续交给
原 worker，或先结束旧所有权再创建拥有同一组文件的单一 repair task。受信 action
`finalize-point-drafts` 按 ref 机械展开 sourceSpans 时会原子写回 point 文件，这是确定性脚本的
受控写入，不属于主智能体代写。

### 动画任务独占

每个动画机制由一个且仅一个任务拥有：

```text
src/animations/<Component>.tsx
src/animations/<Component>.css
```

动画任务不得修改 points、动画清单、类型文件、注册组件或其他动画的文件。

## 一点一任务

`prepare-content-tasks` 为 index 中每个知识点确定性生成一个任务包，`content-plan.json` 只调度仍是
`{}` 占位的点；一个详情任务只负责一个知识点，不再由模型按重要性、难度或依赖邻域自行合批。理由：

- 均衡尾部延迟：所有任务粒度相同，一波不会被某个多点批次拖住，修复也只影响单点；
- 主智能体提示保持 O(1)：上下文全部在任务包中，task 提示是固定短模板，不随课程规模变长；
- 拆分与所有权由脚本决定，可重现、可恢复，不依赖模型判断；
- 已开始的点也保留任务包，修复、恢复、全局复核和 G5 返工时 repair task 始终有可信输入。

取舍：旧流程中主智能体为每个任务筛出的“建议前置候选”不再生成，worker 读取全量注册表自行
判断最小必要前置；前置关系的全局质量由“全局 points 复核”兜底。

不得把整门课程或多个知识点交给一个详情子智能体。

## 任务包与计划

`prepare-content-tasks` 在 G2 回执有效且 `init-points` 之后调用，生成：

- `registry.json`：`course-worker-registry/1.0`，`points` 中每个知识点一行
  `{id,title,difficulty,shortSummary}`，适配 `read` 工具的行数与单行长度限制；
- `content/<point-id>.json`：`course-worker-task/1.0`、`kind: "content"`，index 中每个知识点一个；
  重跑只改写内容有变化的任务包，只删除已不在 index 中的点的旧任务包；
- `content-plan.json`：`course-worker-plan/1.0`，含 `concurrency`（k）、`canary`、`waves`、
  `started`（已开始的点）与 `taskDir`；每一波占一行，大课程也不会超出 `read` 的行数上限。

详情任务包字段：

| 字段 | 内容 |
|---|---|
| `courseId` / `pointId` / `title` | 冻结身份 |
| `ownership.write` | point 与 animation request 的会话相对路径 |
| `forbidden` | 禁止修改的共享文件 |
| `contracts` | 按顺序：session-local `SKILL.md`、`content-worker-brief.md`、`data-contract.md`、`animation-contract.md`、`schemas/point.schema.json`、`schemas/animation-request.schema.json`；教材 v2 追加 `schemas/textbook-content.schema.json` |
| `course` | `course.json` 原样 |
| `scope` | manifest 的 `subject`（受众、深度、范围、排除项、学习成果）原样，附 `evidenceMode/contentContract` |
| `indexEntry` | 完整索引项 JSON 原样，不是主智能体手写的摘要 |
| `sequence` | `order`、`previousPointId`、`nextPointId` |
| `registryPath` | 全量注册表路径；worker 需要选择前置时自行读取 |
| `evidence` | 仅 `textbook-grounded`：`origin`、`anchorPointId`、`markdownPath` 与有序 `spans` |
| `sourceEvidence` | 仅 `researched`：本点 `manifest.pointEvidence` 单项原样，以及其 `sourceRefs` 指向的 `sources` 记录原样 |

教材证据是受信 `generation/manifest.json` 中 `manifest.pointEvidence` 单项的机械投影：

- `spans` 严格按该单项 `sourceSpans` 的顺序排列，每项含 `ref/headingPath/lineStart/lineEnd/assetRefs`；
  `blockIds` 只有一个时 `ref` 即该 ID，否则为 `blockIds.join("+")`，同一点内 ref 不唯一时 action
  直接失败；
- 教材原有点的 spans 按受信 manifest 的既定顺序完整覆盖全部 section 及正文行；所有非教材点
  （`llm-extension` 或 `user`）都带同章教材 `anchorPointId`，spans 是受信 action 为该锚点确定的
  非空证据子集；
- `markdownPath` 指向会话内绑定的 `full.md`；worker 按 span 行号读取正文和必要的相邻 section，
  不得自行扫描整本 Markdown，也不得把其他知识点的大段正文复制进当前上下文；
- 长教材的 `chunk-*` ID 只用于定位读取批次，不是 canonical source span；详情任务不得用 chunk ID
  替换 ref 中的 `block-*` section ID。

manifest 声明 `contentContract: "textbook-content/2.0"` 时，扩展点也必须分配非空教材锚点
span；该 span 对应的教材块只描述锚点上下文，扩展出来的新结论写入模型块。

worker 草稿中教材块的 `provenance.sourceSpans` 只写 `evidence.spans[].ref` 字符串，首次出现顺序覆盖
全部 ref 且与 spans 顺序一致，不再抄写 span 对象和哈希。`finalize-point-drafts` 按 ref 把字符串机械
替换为可信 span 的深拷贝；展开后教材块 span 按块顺序和数组顺序首次出现去重的结果必须与
`manifest.pointEvidence.sourceSpans` 深度相等且顺序一致。模型块不得引入清单外 span。

主智能体不得把索引项、注册表、`pointEvidence`、合同正文或模板规则粘贴或转述进 task 提示；
可信任务包就是契约注入载体。worker 的全部规则（Schema 快速核对、写作任务、教材 ref、LaTeX
转义、`read` 回读自检、禁止修改清单和最终报告格式）集中在 [content-worker-brief.md](content-worker-brief.md)，
worker 按任务包 `contracts` 顺序完整读取。子智能体没有 `course_pipeline` 权限，正式校验由主智能体
执行。

## 并发策略

- 并发数 k 由 `prepare-content-tasks` 读取环境变量 `COURSE_WORKER_CONCURRENCY` 决定：整数 1–32，
  默认 10；非法值回退到 10 并在输出中警告。主智能体使用 `content-plan.json` 的 `concurrency`，
  不得自行把正常批次固定为更小或更大的值。
- `canary` 是按索引顺序的前 min(3, 待生成数) 个待生成点；其余待生成点按索引顺序每 k 个一波。
- 每一波（包括 canary 波）的全部 task 调用都必须在同一条 assistant 消息里一次性发出，才能真正并行；
  不得逐条消息串行派发同一波任务。
- canary 波全部返回后调用一次 `finalize-point-drafts`；只有 canary 全部通过，才扩大到后续波次。
  canary 有失败时，下一条消息只包含 canary 的修复调用，不追加任何新任务；修复返回后再调用一次
  `finalize-point-drafts`，直到 canary 全部通过。canary 中同一点连续两次失败仍按“失败与重试”新建
  repair task；错误指向任务包、索引或合同本身时按“失败与重试”第 4 条处理，不扩大并发。
- canary 通过后，`waves` 按顺序消费为待派发队列：每条消息先放入上一轮失败点的修复调用，再按队列
  顺序补入新任务直到调用总数达到 k，放不下的新任务顺延到下一条消息。不等待失败点修好才启动下一
  波；失败点的修复与新任务在同一条消息里并发。
- 每条消息的全部调用返回后，只调用一次 `finalize-point-drafts`，据其报告确定下一条消息的修复集合。
- 已派发但文件仍为 `{}` 占位的点视同失败。草稿校验会跳过成对占位，因此报告中的“校验通过”不代表
  本轮任务都写了文件；报告另有一行“待生成队首”，按计划顺序列出最前面最多 k 个仍为占位的点。新
  任务严格按计划顺序派发，本轮已派发却没写文件的点必然出现在队首：只要队首里有本条消息派发过的
  点，就把它按失败处理（发回原 worker 会话），即使报告整体通过。canary 判定同样适用这条规则。
- 只有平台明确限流（如 HTTP 429）时才降低 k，并在进度记录中写明原因；任务失败或校验失败不降低 k。
- 同一依赖邻域可并行写详情，因为前置 ID 已冻结；不得根据尚未完成的正文发明新 ID。
- 子智能体失败不影响其他互斥任务；只重试失败任务。
- 恢复会话时先重跑 `prepare-content-tasks`：它幂等地保留全部任务包，只按剩余 `{}` 占位点重建计划。
  再调用 `finalize-point-drafts`，已开始但未通过的点用其任务包交回原会话修复；原会话不可用时按
  “失败与重试”新建拥有同一组文件的 repair task。之后按新计划继续，新计划的 canary 同样先单独验收。
  任何情况下都不得改为在提示中粘贴证据。

## 详情任务提示模板

将尖括号替换为真实 ID，其余文字保持不变，不得追加索引项、注册表、证据或规则正文：

```text
你是课程 <course-id> 的内容 worker，只负责知识点 <point-id>。
1. 先加载 `candidate-knowledge-point-generator` Skill。
2. 完整读取任务包 `pipeline/<course-id>/worker-tasks/content/<point-id>.json`。
3. 按任务包 `contracts` 的顺序完整读取每个合同与 Schema，并严格执行 `content-worker-brief.md`。
4. 只写任务包 `ownership.write` 列出的两个文件；不得修改 `forbidden` 或任何其他路径。
5. 完成后按 `content-worker-brief.md` 的“最终报告”格式返回。
```

发回原 worker 会话的修复消息：

```text
知识点 <point-id> 未通过 finalize-point-drafts，以下是涉及你所拥有文件的完整原始错误：
<原样粘贴错误，不摘要、不改写，包括任何 JSON parse error>
只在任务包 `ownership.write` 内修复；修复后按 `content-worker-brief.md` 回读自检并返回最终报告。
```

点已派发但仍为 `{}` 占位时，错误就写“任务包 ownership.write 中的两个文件仍是 {} 占位，尚未写入”，
同样发回原会话。

同一点连续两次失败后新建的 repair task：

```text
你是课程 <course-id> 知识点 <point-id> 的 repair task，接手原 worker 的全部文件所有权。
1. 先加载 `candidate-knowledge-point-generator` Skill。
2. 完整读取任务包 `pipeline/<course-id>/worker-tasks/content/<point-id>.json`，按其 `contracts` 顺序完整读取合同与 Schema。
3. 完整读取 `ownership.write` 中的现有文件，只修复以下历次完整原始错误：
<原样粘贴全部原始错误>
4. 只写 `ownership.write`；完成后按 `content-worker-brief.md` 的“最终报告”格式返回。
```

## 逐波验收

每一波的全部 task 返回后，主智能体调用一次：

```text
course_pipeline {"action":"finalize-point-drafts","courseId":"<course-id>"}
```

该动作先做溯源机械展开：仅在 manifest 声明 `textbook-content/2.0` 时，对每个已开始且可解析的点，
把 blocks 中 `provenance.sourceSpans` 的字符串 ref 替换为该点 `manifest.pointEvidence.sourceSpans`
中可信 span 的深拷贝，对象项保持不变；只有内容变化时才原子写回，不碰占位、动画请求或其他
文件。随后执行与 `validate-point-drafts` 完全相同的草稿校验，打印同样格式的报告并附加 materialized
摘要。存在未知 ref 或校验失败时退出码非 0。非教材课程跳过展开，只做校验。

同一文件只要有一个 ref 不在该点 `evidence.spans[].ref` 中，finalize 就不改写这个文件；校验报告只对
真正未知的 ref 逐项报错，并要求改成任务包中的合法 ref 字符串、不要手写 span 对象，同文件中合法的
ref 不再报错。报告出现“请先运行 finalize-point-drafts”只说明尚未展开，此时直接调用 finalize 即可，
不要转给 worker。

```text
course_pipeline {"action":"validate-point-drafts","courseId":"<course-id>"}
```

`validate-point-drafts` 保留为只读检查：跳过尚未开始的 `{}` 占位，只对已经开始的 point/request 成对
执行正式 Schema 和一致性校验，并报告已校验数与待生成数；遇到未展开的字符串 ref 会明确要求先运行
`finalize-point-drafts`。

只有报告明确通过的点才算验收。校验失败时，把涉及该点文件的完整原始错误发回拥有该文件的
同一 worker 会话修复并重新校验；主智能体不得直接 `edit`/`write` 详情文件，任何 JSON parse error
也必须原样交回有该文件所有权的 worker。不得等整门课程完成后一次性汇总错误。

finalize 的正式校验对每个已开始的点覆盖以下机械项，worker 也在回读自检中逐项确认；主智能体以
报告为准，不为此逐文件通读正文：

- point 与 animation request 成对开始，不允许只写一侧（两侧都仍为 `{}` 的点按上文“待生成队首”判定）；
- 文件内部 ID 与文件名、冻结索引一致；
- 没有 cluster/layout 或生成审查字段；
- 必填数组达到下限且没有重复；
- `prerequisites` 全部存在、无自引用；
- 动画请求 `pointId` 一致；
- `needed: true` 时五项机制信息完整。

“正文不是标题替换式模板”等非机械质量项由 worker 自检，并在全局 points 复核中检查。

结构错误可直接重试；事实边界错误应附上证据和明确修订要求。

## 失败与重试

1. 第一次失败：通过 task 的会话续接把精确、完整的原始校验错误发回原 worker 会话，在原文件
   所有权内修复；canary 通过后，该修复调用并入下一条消息，与下一波新任务一起发出（canary 失败时
   下一条消息只含 canary 修复，见“并发策略”）。
2. 同一点连续第二次失败：结束原 worker 的所有权，新建拥有同一组文件的 repair task，转交任务包
   路径和全部原始错误；主智能体不得直接编辑文件，也不得让两个任务同时拥有同一路径。
3. repair task 失败时继续把完整错误发回该 repair task；错误指向任务包、索引或合同本身时按第 4 条
   处理，不要反复重试。
4. 发现索引本身错误：暂停受影响任务，由主智能体串行修订索引和 manifest，再重跑
   `prepare-content-tasks` 生成任务包；`id`、`title` 或顺序变化会使 G2 回执失效，必须重新审核。

不得用忽略校验、删除问题字段或把引用改为空数组来掩盖错误。

## 全局 points 复核

逐波校验不能替代全局复核。全部详情完成后检查：

- 标题、英文名、缩写和别名的重复；
- 普通点的 `coreIdea` 或教材点的 blocks 是否能清楚区分；
- 摘要、难度和重要性是否使用统一尺度；
- 前置关系是否为真正的学习依赖；
- 是否存在环、孤立的高级点或缺失的基础点；
- 高频模板句、标题替换式正文、空泛应用、虚构历史和伪精确年份；
- 公式符号是否定义、JSON 和 LaTeX 是否正确转义（如运行时 `\delta` 在文件中写作 `"\\delta"`）；
- 所有点是否都提交了动画请求。

全局复核或 G5 `validate-all` 发现某个点的问题时，同样不由主智能体改文件：按“修复消息”模板交回
仍可用的原 worker 会话，否则按 repair task 模板新建拥有该点文件的 repair task；任务包对全部点保留，
repair task 始终从任务包读取上下文。修复后重新调用 `finalize-point-drafts` 验收。

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

## 动画任务包与提示模板

写好动画清单并调用 `init-animations` 后，主智能体调用 `prepare-animation-tasks`。它为清单中每个组件
生成 `animations/<Component>.json`，`animation-plan.json`（`kind: "animation"`）只调度 TSX/CSS 仍是
占位的组件：`canary` 是第一个待实现组件，其余每 k 个一波。动画任务包包含 `component`、animation manifest
单项原样内容、`ownership.write`（TSX/CSS 的会话相对路径）、`forbidden`、
`boundPoints[{id,title,pointFile}]`，以及按顺序的 `contracts`：session-local `SKILL.md`、
[animation-worker-brief.md](animation-worker-brief.md)、[animation-contract.md](animation-contract.md)。

动画 worker 自己读取任务包和绑定知识点文件；主智能体不得把 manifest 单项、绑定知识点正文或
合同正文粘贴进提示。动画实现要求、源码自检和完成后说明集中在 animation-worker-brief.md。

```text
你是课程 <course-id> 的动画 worker，只负责组件 <Component>。
1. 先加载 `candidate-knowledge-point-generator` Skill。
2. 完整读取任务包 `pipeline/<course-id>/worker-tasks/animations/<Component>.json`。
3. 按任务包 `contracts` 的顺序完整读取合同，并严格执行 `animation-worker-brief.md`。
4. 完整读取任务包 `boundPoints[].pointFile` 列出的绑定知识点文件。
5. 只写 `ownership.write` 列出的 TSX/CSS；完成后按 brief 的“完成后说明”返回。
```

修复消息与 repair task 沿用详情任务的格式，把任务包路径换成动画任务包、把
`finalize-point-drafts` 换成 `validate-animation-drafts`、把 brief 换成 animation-worker-brief.md；
组件已派发但仍为占位时，错误写“任务包 ownership.write 中的 TSX/CSS 仍是 {} 占位，尚未写入”。

## 动画任务源码检查

- 组件和同名 CSS 均存在；
- 组件默认导出且根视图含 `animation-stage`；
- SVG 有 `role="img"` 和 `<title>`，根视图有准确中文 `aria-label`；
- 标签能解释变化规则，颜色不是唯一信息通道；
- CSS 有组件命名空间和低动态降级；
- 重播回到同一初始条件；重新生成才改变随机样本；
- effect 清理覆盖所有副作用；
- 机制与清单中所有绑定点都一致。

第一个动画组件必须作为 canary，单独派发；返回后执行：

```text
course_pipeline {"action":"validate-animation-drafts","courseId":"<course-id>"}
```

只有它通过后才启动其余组件；canary 失败时下一条消息只包含 canary 的修复调用，修复后再验，直到
通过。其余组件按 `animation-plan.json` 的波次队列在同一条 assistant 消息里并发发出：修复调用优先，
新任务补足到 k 个，放不下的顺延；每条消息返回后只调用一次 `validate-animation-drafts`，失败组件的
完整原始错误发回原任务，在原 TSX/CSS 所有权内修复。同一组件连续两次失败时，按详情任务规则新建
拥有同一组文件的 repair task。该 action 跳过成对的 `{}` 占位，但拒绝只完成 TSX/CSS 一侧，并对已
开始组件执行完整源码契约检查；报告中的“动画待生成队首”出现本条消息已派发的组件时，按失败处理。
所有动画任务通过后，才由主智能体通过 `course_pipeline` 固定 action 构建注册层。动画清单为空时没有
动画任务，直接构建注册层。本检查不创建人工审核凭据。

## 最终串行步骤

```text
course_pipeline: init-points
course_pipeline: prepare-content-tasks
content task 波次（canary 后每波在同一条消息里并发）
course_pipeline: finalize-point-drafts（每波返回后一次；展开 ref 并验收草稿）
course_pipeline: validate-points
course_pipeline: sync-index
course_pipeline: validate-points
course_pipeline: init-animation-manifest
write animation-manifest
course_pipeline: init-animations
course_pipeline: prepare-animation-tasks
animation task 波次（首个组件为 canary，之后每波在同一条消息里并发）
course_pipeline: validate-animation-drafts（每波返回后一次）
course_pipeline: build-animation-registry
course_pipeline: validate-all
course_pipeline: publish（G6 图谱审核通过后，内部执行生产构建）
```

任何串行步骤失败时，停止发布并修复根因；不要在失败状态下继续添加更多内容。
