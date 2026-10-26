# 课程内容中间包数据契约

## 定位

本契约定义 CKDS 发布前的内容生成格式。它复用 CKDS 的课程元数据、知识点内容和稳定 ID 规则，但有意推迟知识簇与森林布局。

该格式不能直接交给依赖 `clusters`、`clusterId`、`pos` 或 `scale` 的现有森林前端。

## 目录

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

JSON 使用 UTF-8、双引号、2 空格缩进、文件末尾换行，不含注释和尾随逗号。

JSON 字符串中的 LaTeX 反斜杠必须按 JSON 语法在物理文件中写成 `\\`。例如，下列是文件中
可解析且能还原预期 LaTeX 的写法：

```json
{
  "formula": "\\delta = \\frac{x}{2}",
  "markdown": "行内公式使用 $x + \\delta$；块公式使用 $$\\delta = \\frac{x}{2}$$。"
}
```

不得在文件中写 `"\delta"`、`"\(x\)"` 或单反斜杠的 `"\frac"`；前两者会让 JSON 无法解析，
后者还可能被解析为控制字符并静默破坏公式。Markdown 正文的公式分隔符必须统一为行内
`$...$` 或块级 `$$...$$`；不得生成 `\(...\)`、`\[...\]` 或脱离公式分隔符的 LaTeX 命令，
因为课程渲染器不会把这些形式识别为公式。段落之间写真实换行；不得输出可见的字面量 `\n\n`。
LaTeX 命令本身仍必须双写反斜杠。worker 写完 point 与 animation request 后
必须用 `read` 回读物理文件并检查转义；校验返回的任何 JSON parse error 必须原样交回拥有该文件
的 worker 或同所有权 repair task，主智能体不得直接改写该文件。

输出根目录必须由本中间包独占，不得直接使用已有应用或仓库根目录。全包不允许符号链接和契约外遗留 JSON；需要接入现有项目时，先在独立目录完成构建与校验，再复制明确的运行时产物。

## 标识符

- `course.id` 和 `point.id` 使用 ASCII kebab-case，匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`。
- `point.id` 在课程内唯一，并严格等于详情文件名。
- 教材来源点（`origin: "textbook"`）必须保留教材原始标题，因此同一课程内教材点标题可以重复；非教材点之间，以及教材点与非教材点之间，标题仍必须唯一。
- `prerequisites[]` 只引用同一课程已存在的 `point.id`，不能自引用、重复或形成环。
- `animationType` 使用 ASCII lowerCamelCase，`none` 为保留值。
- 动画组件名使用 PascalCase，并严格对应 `<Component>.tsx` 和 `<Component>.css`。

## `src/data/course.json`

沿用 CKDS 1.0 的课程元数据：

```json
{
  "schema_version": "1.0",
  "id": "data-structures",
  "title": "数据结构",
  "description": "理解常见数据结构、操作及其适用边界。",
  "language": "zh-CN",
  "version": "0.1.0",
  "updatedAt": "2026-07-16"
}
```

只允许以上 7 个字段。中间包首次生成建议使用 `0.1.0`，后续内容迭代按语义化版本递增；正式发布版本由后续阶段决定。

## `src/data/index.json`

规划索引和最终内容索引使用同一路径：

```json
{
  "schema_version": "course-content-index/1.0",
  "courseId": "data-structures",
  "points": [
    {
      "id": "linked-list",
      "title": "链表",
      "shortSummary": "由节点及链接关系组成、支持动态插入和删除的线性数据结构。",
      "difficulty": "基础",
      "importance": 0.82,
      "keyTerms": ["节点", "链接", "线性结构"]
    }
  ]
}
```

顶层只允许 `schema_version`、`courseId`、`points`。每个索引项必须且只允许：

| 字段 | 类型 | 规则 |
|---|---|---|
| `id` | string | 唯一 kebab-case，与详情文件名一致 |
| `title` | string | 准确中文术语 |
| `shortSummary` | string | 30–100 个 Unicode 字符，不重复标题 |
| `difficulty` | string | `基础`、`中等`、`进阶` |
| `importance` | number | 当前课程范围内 `[0, 1]` |
| `keyTerms` | string[] | 2–8 个非空、去重术语 |

首次生成后，`id`、`title` 和数组顺序冻结。详情阶段可以修订其余 4 项；最终由同步脚本从详情回写。

## `src/data/points/<id>.json`

`point.schema.json` 是兼容联合契约。普通 `researched/model-only` 课程继续使用下面的栏目式
v1；`textbook-grounded` 且 manifest 声明 `contentContract: "textbook-content/2.0"` 时，必须使用
后文的教材内容块 v2。两种格式不能混写。

### 普通课程 v1 必填字段

| 字段 | 类型 | 规则 |
|---|---|---|
| 索引 6 项 | 同上 | 最终与 index 深度相等 |
| `coreIdea` | string | 解释定义、机制或关键结论，不复述摘要 |
| `principles` | string[] | 2–6 条，每条表达一个可验证要点 |
| `applications` | string[] | 至少 1 个真实任务、场景或用途 |
| `aliases` | string[] | 英文名、缩写或真实别称；没有则 `[]` |
| `intuition` | string | 不牺牲准确性的直觉解释 |
| `misconceptions` | string[] | 至少 1 条真实常见误解及纠正 |
| `qa` | `{q, a}[]` | 至少 2 组，覆盖机制理解和应用/边界 |
| `prerequisites` | string[] | 课程内知识点 ID；没有则 `[]` |
| `animationType` | string | 详情初稿写 `none`；注册脚本按清单更新 |

### 按事实适用性选填

| 字段 | 类型 | 使用条件 |
|---|---|---|
| `formula` | string | 存在标准且教学必要的公式；使用项目支持的 LaTeX |
| `comparisons` | string[] | 存在容易混淆、替代或上下位概念 |
| `history` | string | 历史背景有教学价值且可核实 |
| `yearIntroduced` | integer | 年份定义明确且有可靠依据 |
| `prosCons` | `{pros: string[], cons: string[]}` | 方法、模型或制度确有适用优势与边界 |
| `visualType` | enum | 内置静态图示能准确表达 |
| `visualSuggestion` | string | 出现 `visualType` 时必填 |
| `animationSuggestion` | string | `animationType` 非 `none` 时必填 |

允许的 `visualType`：

```text
foundation | timeline | search | logic | knowledgeGraph | learning
decisionTree | bayes | neuralNetwork | gradient | attention | transformer
vision | agentLoop | diffusion | ethics
```

### 示例

```json
{
  "id": "linked-list",
  "title": "链表",
  "shortSummary": "由节点及链接关系组成、支持动态插入和删除的线性数据结构。",
  "coreIdea": "链表把元素存入独立节点，并用引用维护节点之间的逻辑顺序。",
  "principles": [
    "节点不需要占用连续内存。",
    "插入和删除通过重连相邻引用完成。"
  ],
  "keyTerms": ["节点", "链接", "线性结构"],
  "comparisons": ["链表插入删除灵活，但不能像数组一样常数时间随机访问。"],
  "applications": ["实现动态集合", "构造图的邻接表"],
  "aliases": ["Linked List"],
  "intuition": "像一列通过挂钩连接的车厢，每节车厢记录下一节的位置。",
  "misconceptions": ["链表并不天然比数组节省内存，节点引用也会占用空间。"],
  "qa": [
    {
      "q": "链表为什么不要求连续内存？",
      "a": "节点通过显式引用记录逻辑后继，因此物理地址可以分散。"
    },
    {
      "q": "链表适合频繁随机访问吗？",
      "a": "不适合；定位第 k 个节点通常需要从头遍历。"
    }
  ],
  "animationType": "none",
  "difficulty": "基础",
  "importance": 0.82,
  "prerequisites": []
}
```

### 推荐字段顺序

```text
id
title
shortSummary
coreIdea
principles
formula（如有）
keyTerms
comparisons（如有）
applications
aliases
intuition
misconceptions
history（如有）
yearIntroduced（如有）
prosCons（如有）
qa
visualType（如有）
visualSuggestion（如有）
animationType
animationSuggestion（动画非 none 时）
difficulty
importance
prerequisites
```

### 教材课程 `textbook-content/2.0`

教材详情保留索引 6 项、`animationType`、`prerequisites`，并新增顶层 `origin` 和 `content`。
教材模式中 `prerequisites` 只表示明确的内容学习依赖；章节顺序、章内点顺序和点编号由图谱的
`sequences` 表达，不能据此填写前置关系。没有明确依赖证据时必须写 `[]`。
正文由 outcome-first 的 `content.learningDesign`、有序 `content.blocks` 和可选的
`content.learningAssets` 组成；不得再写 `coreIdea/principles/formula/comparisons/applications/
aliases/intuition/misconceptions/history/yearIntroduced/prosCons/qa/visualType/visualSuggestion`，也不在
顶层持久化 `sourceSpans/modelEnriched`。

`learningDesign.adaptationLevel` 只使用 `faithful|balanced|teaching-first`，省略时按 `balanced`
解释，新生成内容应显式写出。默认 balanced 允许围绕学习目标重排教学顺序、压缩重复，增加类比、
案例、练习、动画和跨段桥接。教材约束事实、定义、公式、数值、适用条件、边界与完整覆盖；模型
内容与教材冲突时必须修正。不要规定教材/模型 token 百分比，用动作边界、覆盖和冲突校验控制尺度，
并继续用每个 block 的 provenance 审计事实来源。

- `faithful`：保留教材术语和主要讲解顺序，只做去重、澄清、局部桥接与必要检查；
- `balanced`：围绕学习成果重排讲解，补足直觉、例题、迁移活动和反馈，作为新内容默认档；
- `teaching-first`：可按学习任务重建叙事，合并或拆分教材讲解，并把教材段落移动到最有助于理解的
  模块中，但仍须完整覆盖证据范围并遵守相同事实边界。

正文采用“通用学习骨架 + 知识类型模板”，通常按复杂度使用 4–7 个 modules，不把某个样例的栏目
复制到整门课程。outcomes 由阅读页顶部统一呈现，blocks 不再重复完整目标列表。`estimatedMinutes`
按正文阅读、公式与表格理解、互动活动和练习作答的总负担估算。

`primaryPattern` 记录真正采用的类型化教学模式：概念解释围绕定义、边界和正反例；定量机理围绕
变量、单位、假设、推导、算例和参数实验；操作流程围绕前置条件、步骤、分支、错误恢复和检查表；
比较决策围绕统一维度、取舍规则和适用情境；故障诊断围绕症状、假设、证据、定位和修复；案例分析
围绕情境、决策、证据、结果、反思和迁移。不能只修改 `primaryPattern` 名称而复用同一套固定正文。

```json
{
  "id": "linked-list",
  "title": "链表",
  "shortSummary": "由节点及链接关系组成、支持动态插入和删除的线性数据结构。",
  "keyTerms": ["节点", "链接", "线性结构"],
  "animationType": "none",
  "difficulty": "基础",
  "importance": 0.82,
  "prerequisites": [],
  "origin": "textbook",
  "content": {
    "schema_version": "textbook-content/2.0",
    "learningDesign": {
      "primaryPattern": "concept-example-check",
      "adaptationLevel": "balanced",
      "editorialPolicy": "保持教材定义与边界，围绕迁移目标补充直觉、例题和检查题。",
      "estimatedMinutes": 12,
      "outcomes": [
        {"id": "explain-linked-list", "text": "解释链表的节点与链接关系。"},
        {"id": "apply-linked-list", "text": "判断新情境是否适合使用链表。"}
      ],
      "misconceptions": ["把节点在内存中连续排列当作链表的必要条件。"],
      "modules": [
        {
          "id": "concept-and-transfer",
          "title": "定义、直觉与迁移",
          "role": "worked-example",
          "outcomeRefs": ["explain-linked-list", "apply-linked-list"],
          "order": 0
        }
      ],
      "completion": {
        "outcomeRefs": ["explain-linked-list", "apply-linked-list"],
        "method": "完成迁移判断并说明依据。",
        "successCriteria": ["结论正确", "能引用定义中的判断条件"]
      }
    },
    "blocks": [
      {
        "id": "textbook-definition",
        "moduleId": "concept-and-transfer",
        "depth": "core",
        "kind": "definition",
        "title": "教材定义",
        "markdown": "链表由一组通过链接关系组织的节点构成。",
        "provenance": {
          "origin": "textbook",
          "representation": "paraphrase",
          "sourceSpans": [
            {
              "materialId": "doc-example",
              "blockIds": ["section-12"],
              "headingPath": ["第三章 线性结构", "3.2 链表"],
              "lineStart": 418,
              "lineEnd": 431,
              "page": 67,
              "assetRefs": [],
              "excerptSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
            }
          ]
        }
      },
      {
        "id": "model-intuition",
        "moduleId": "concept-and-transfer",
        "depth": "support",
        "kind": "example",
        "title": "补充直觉",
        "markdown": "可以把节点想成通过挂钩连接的车厢。",
        "provenance": {
          "origin": "model",
          "basedOnBlockIds": ["textbook-definition"]
        }
      }
    ],
    "learningAssets": [
      {
        "id": "linked-list-check",
        "type": "formative-check",
        "anchorBlockId": "model-intuition",
        "moduleId": "concept-and-transfer",
        "depth": "core",
        "outcomeRefs": ["apply-linked-list"],
        "learningPurpose": "检查学习者能否把教材定义迁移到新情境。",
        "grounding": {"basedOnBlockIds": ["textbook-definition"]},
        "config": {"attempts": 2},
        "fallback": {
          "type": "markdown",
          "markdown": "请判断该情境是否适合链表，并写出教材定义中的依据。"
        }
      }
    ]
  }
}
```

允许的 `kind`：

```text
definition | explanation | mechanism | procedure | formula | example
worked-example | comparison | application | code | table | figure | warning
misconception | exercise | summary | note | other
```

块数组就是阅读顺序，块 ID 在点内唯一。教材块必须声明 `representation: quote|paraphrase` 和
至少一个精确 `sourceSpan`。模型块必须用非空 `basedOnBlockIds` 引用同一点中排在它前面的块，
并最终追溯到至少一个教材块；可选 `sourceSpans` 仅表示额外 grounding。每个教材点和受控扩展点
都至少有一个教材上下文块和一个模型补充块。受控扩展点的教材块只描述锚点或上下文，新增结论
必须写在模型块中。

`learningDesign` 出现时内部计划必须完整：outcome 和 module ID 在点内唯一，module 的
`outcomeRefs` 不能悬空且合计覆盖全部 outcomes；每个 module 至少有一个 block。每个 block 的
`moduleId` 必须命中 module，`depth` 只能是 `core|support|advanced`。`completion` 可用
`outcomeRefs/method/successCriteria` 描述达成标准，也可用 `exerciseBlockId/summaryBlockId/nextPointId`
连接正文与下一知识点；块引用必须命中当前点。`nextPointId` 可省略；一旦声明，必须命中本课程
`index.points[]` 中紧随当前点的稳定 ID，末点必须省略。

`learningAssets` 每项必须声明唯一 `id`、类型、`anchorBlockId`、非空 `outcomeRefs`、
`learningPurpose`、`grounding.basedOnBlockIds` 和可用 `fallback`。grounding 只能引用 anchor 之前或
自身、且最终可追溯到教材的 block。类型自有数据放入 `config` 对象；fallback 至少声明
`type|mode` 之一，并提供 `blockId|markdown|caption|content` 之一。

模型补充按依据就近插入。只引用一个块时，放在该块之后；引用多个块时，放在最后一个被引用块
之后。允许同一锚点连续跟随多个补充块，但不得先排列全部教材块，再把所有模型块集中堆到末尾。
这样隐藏模型补充后仍能得到连续教材正文，显示补充时也能看清它解释的是哪一段。

每个块的 `markdown` 使用标准 Markdown 与 remark-math 语法：行内公式写 `$...$`，块公式写
`$$...$$`。不要输出 `\(...\)`、`\[...\]`、未包裹的 LaTeX 命令或可见的字面量 `\n\n`；
代码围栏和行内代码中的反斜杠示例不受此规则影响。

教材模式的 span 唯一事实源是受信 manifest 中该点完整的 `manifest.pointEvidence` 单项。
`prepare-content-tasks` 把它机械投影为任务包 `evidence.spans`，每项只含
`ref/headingPath/lineStart/lineEnd/assetRefs`：`blockIds` 只有一个时 `ref` 即该 ID，否则为
`blockIds.join("+")`。worker 草稿中块的 `provenance.sourceSpans` 只写这些 ref 字符串（例如
`["block-000051"]`），不抄写 span 对象或哈希；主智能体每波调用 `finalize-point-drafts`，按 ref 把
字符串替换为该单项可信 span 的深拷贝，对象项保持不变；同一文件含未知 ref 时整份文件不展开，
校验器只对未知 ref 逐项报错。展开后，把所有教材块的
`provenance.sourceSpans` 按块顺序、数组顺序连接并按首次出现去重，结果必须与该单项的
`sourceSpans` 深度相等且顺序一致；等价地，草稿中教材块 ref 的首次出现顺序必须覆盖全部
`evidence.spans[].ref` 且与之同序。上方示例是展开后的 canonical 形式；未展开的字符串 ref 不是
canonical 格式，`validate-point-drafts` 与 `validate-points` 遇到合法但未展开的 ref 时报错并要求
先运行 `finalize-point-drafts`。不得自行重建 span，不得用 `material.json.chunks` 中的 `chunk-*` ID 替换
受信 manifest 里的 `block-*` section ID；chunk 只用于分批读取正文。模型块不得引入该清单之外的
新 span 或 ref。

`modelEnriched` 从是否存在模型块派生；点级 `sourceSpans` 从全部块的 span 按首次出现顺序去重
派生。它们不是 canonical v2 文件中的人工字段；发布器可以在最终课程详情顶层暴露这两个派生值
供旧读取端兼容，但后端会校验它们必须与 blocks 一致。

## `generation/manifest.json`

该文件保存生成过程信息，不进入课程运行时数据：

```json
{
  "schema_version": "course-content-generation/1.0",
  "subject": {
    "id": "data-structures",
    "input": "数据结构",
    "normalizedTitle": "数据结构",
    "inputType": "course",
    "language": "zh-CN",
    "audience": "计算机相关专业本科生",
    "depth": "一学期核心课程",
    "scope": "覆盖表示、操作、复杂度与典型算法。",
    "exclusions": ["特定语言容器库 API"],
    "outcomes": ["能选择并分析适合问题约束的数据结构"]
  },
  "generation": {
    "evidenceMode": "researched",
    "generatedAt": "2026-07-16",
    "pointCount": 1
  },
  "sources": [],
  "pointEvidence": [
    {
      "pointId": "linked-list",
      "title": "链表",
      "kind": "concept",
      "sourceRefs": ["src-01"],
      "confidence": 0.92,
      "scopeStatus": "core"
    }
  ],
  "reviewQueue": []
}
```

`kind` 只允许 `concept`、`method`、`theorem`、`model`、`algorithm`、`task`、`metric`、`phenomenon`。

`pointEvidence` 的数组顺序、`pointId` 和 `title` 是规划 index 的冻结身份快照，必须与 `index.points[]` 一一同序。

`scopeStatus` 只允许 `core`、`boundary`、`needs-review`。`reviewQueue` 的问题类型只允许 `scope-ambiguity`、`granularity`、`synonym`、`naming`、`insufficient-evidence`。复核项可以用 `pointId` 关联已纳入索引的知识点；所有 `boundary`、`needs-review` 或置信度低于 `0.5` 的点都必须至少有一个关联复核项。

`researched` 模式至少 3 个 locator 不重复的独立来源并覆盖至少 2 种来源类型，每个点至少 1 个 `sourceRefs`。`model-only` 模式来源和 `sourceRefs` 为空，`confidence` 不高于 `0.6`。

`researched` 模式下，`prepare-content-tasks` 把每个点的 `pointEvidence` 单项及其 `sourceRefs` 指向的
`sources` 记录原样写入该点任务包的 `sourceEvidence`；worker 据此核对事实，不在提示中转述来源。

教材 Markdown 新生成模式使用 `evidenceMode: "textbook-grounded"`，并在 `generation` 中声明
`contentContract: "textbook-content/2.0"`。`sources` 至少包含一个 `type: "textbook"` 的来源，
locator 指向会话内绑定的 material/full.md 相对路径。`pointEvidence` 增加以下两个必填字段：

| 字段 | 类型 | 规则 |
|---|---|---|
| `origin` | string | `textbook`、`llm-extension` 或 `user` |
| `sourceSpans` | object[] | 教材点和扩展点都至少一项，作为 G3 点级证据计划 |

每个 source span 严格包含 `materialId`、`blockIds`、`headingPath`、`lineStart`、
`lineEnd`、`assetRefs`、`excerptSha256`，有页码时可增加 `page`。行号与哈希定位原始
Markdown 证据；不要把整段教材正文复制进 manifest。

G3 不由主智能体在 task 提示中注入或转述 `pointEvidence`：`prepare-content-tasks` 从本 manifest 生成
只读任务包 `pipeline/<course-id>/worker-tasks/content/<point-id>.json`，其 `evidence` 是该点
`pointEvidence` 单项的机械投影（`origin`、扩展点的 `anchorPointId`、会话内 `full.md` 相对路径和
有序 spans），不能由口头摘要或从 material chunk 推导的新 spans 代替。worker 依据 spans 行号读取所指
正文，写入教材块的只能是这些 spans 的 ref；最终 span 对象只能由 `finalize-point-drafts` 从本单项
的 `sourceSpans` 深拷贝。

教材原有点的 `sourceSpans` 按 `material.point_sources.section_ids` 的既定顺序完整覆盖所有
section 及其正文行；只引用标题、只选择代表段落或打乱顺序均无效。所有非教材点
（`llm-extension` 或 `user`）必须提供同章教材 `anchor_point_id`，并使用对应教材点内的非空
相关子集，不得引用其他知识点的正文。详情中所有教材块
合计保持同样的完整覆盖；模型块不能代替教材块补登记遗漏的教材范围。

v2 point 详情的顶层 `origin` 必须与 pointEvidence 一致；从 `content.blocks` 派生的 spans 必须
与 pointEvidence 的计划一致。manifest 不写 `modelEnriched`，校验器在 G3 从模型块派生它。
没有 `contentContract` 的既有教材课程仍按旧格式读取，迁移前不得与 v2 混写。

## `generation/animation-requests/<id>.json`

每个知识点必须有一个同名请求文件。

需要动画：

```json
{
  "schema_version": "animation-request/1.0",
  "pointId": "gradient-descent",
  "needed": true,
  "rationale": "参数位置会按梯度和学习率反复更新，动画能直接呈现收敛与振荡。",
  "mechanism": {
    "inputs": "初始参数、损失函数和学习率",
    "changingState": "参数位置、梯度方向和损失值",
    "transitionRule": "沿负梯度方向按学习率更新参数",
    "terminalState": "达到收敛阈值或迭代预算",
    "replayMode": "both"
  },
  "suggestion": "逐步显示梯度箭头、参数更新和损失下降，并允许切换不同学习率。"
}
```

不需要动画：

```json
{
  "schema_version": "animation-request/1.0",
  "pointId": "ai-ethics",
  "needed": false,
  "rationale": "该知识点主要是规范框架与静态分类，不存在单一、忠实的动态机制。"
}
```

`replayMode` 只允许 `restart`、`both`、`loop`。所有动画都必须支持重播；随机过程需要同时支持重播与重新生成时使用 `both`。`needed: false` 时不得出现 `mechanism` 或 `suggestion`。

## `generation/animation-manifest.json`

动画规划器归并请求后生成：

```json
{
  "schema_version": "course-content-animations/1.0",
  "animations": [
    {
      "type": "gradientDescent",
      "component": "GradientDescent",
      "title": "梯度下降迭代",
      "mechanism": {
        "inputs": "初始参数、损失函数和学习率",
        "changingState": "参数位置、梯度方向和损失值",
        "transitionRule": "沿负梯度方向按学习率更新参数",
        "terminalState": "达到收敛阈值或迭代预算",
        "replayMode": "both"
      },
      "bindings": [
        {
          "pointId": "gradient-descent",
          "suggestion": "逐步显示梯度箭头、参数更新和损失下降，并允许切换不同学习率。"
        }
      ]
    }
  ]
}
```

每个 `type`、`component` 和绑定的 `pointId` 均唯一。每个 `needed: true` 请求必须且只能绑定一次；`needed: false` 的点不能绑定。binding 的 `suggestion` 必须与对应请求完全一致；共享机制的文字可以由动画规划器在不改变原理的前提下统一表述。

## 禁止字段

以下字段不得出现在 `index.json` 或详情 JSON：

```text
clusters
clusterId
pos
scale
polygon
labelPos
accent
soft
dark
kind
sourceRefs
confidence
scopeStatus
ideologicalElement
related_points
```

生成审查字段只能位于 `generation/manifest.json`。

## 与 CKDS 1.0 的转换边界

可直接复用：

- `course.json`；
- 稳定的课程和知识点 ID；
- 索引 6 项内容元数据；
- 全部详情正文与 `prerequisites`。

动画需要显式迁移：

- CKDS 1.0 只接受 `attention`、`gradient`、`search`、`agentLoop` 和 `none`；
- 自定义动画若能严格映射到上述机制，可改用内置类型；
- 其他自定义类型必须连同组件、样式、类型声明和注册代码安装到目标前端，并扩展其消费契约，不能只复制 JSON 字段。

后续阶段必须新增：

- 知识簇定义和每点 `clusterId`；
- `polygon`、`labelPos`、`pos`、`scale`；
- CKDS 1.0 的正式 `index.json`；
- 面向目标前端的加载和动画代码接线。

转换后必须重新运行 CKDS 发布校验，不能把本中间包仅改版本号后直接发布。
