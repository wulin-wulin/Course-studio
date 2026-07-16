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

输出根目录必须由本中间包独占，不得直接使用已有应用或仓库根目录。全包不允许符号链接和契约外遗留 JSON；需要接入现有项目时，先在独立目录完成构建与校验，再复制明确的运行时产物。

## 标识符

- `course.id` 和 `point.id` 使用 ASCII kebab-case，匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`。
- `point.id` 在课程内唯一，并严格等于详情文件名。
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

### 必填字段

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
