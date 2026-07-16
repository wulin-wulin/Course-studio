---
name: candidate-knowledge-point-generator
description: 从课程名或领域名生成可审查的课程内容中间包。先建立无知识簇和布局字段的全量 index.json，再用子智能体逐文件生成丰富的 points JSON，归并并实现必要的 React 教学动画，最后同步索引并执行全量校验。用于创建课程知识点内容、扩展候选知识点为完整详情，或为后续 CKDS 聚类与布局阶段准备数据。
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

### 3. 生成课程元数据与规划索引

先写 `src/data/course.json`、`generation/manifest.json` 和 `src/data/index.json`。

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

`id` 使用稳定的 ASCII kebab-case；冲突使用有语义的限定词，禁止随机编号。为每个索引项在 manifest 的 `pointEvidence` 中按 index 同序记录冻结的 `pointId/title`、原子类型、来源、置信度和范围状态。所有边界、待复核或低置信度点必须关联到 `reviewQueue`。

完成后运行：

```bash
node "$SKILL_DIR/scripts/validate_output.mjs" \
  --root "$OUTPUT_ROOT" \
  --phase index
```

索引阶段未通过前，不得生成详情。

### 4. 自适应调度详情子智能体

按 [orchestration.md](orchestration.md) 生成任务清单：

- 核心、高难、公式密集、前置关系复杂或动画候选点：一任务一点；
- 其他简单点：按依赖邻域组成 3–5 点小批次；
- 每个任务仍必须逐文件输出和逐文件自检。

每个子智能体必须获得：

1. 范围契约和受众；
2. 自己负责的冻结索引项；
3. 全量 `id/title` 注册表；
4. 全量合法 prerequisite ID 和建议前置候选；
5. 相关来源与事实约束；
6. 数据契约和动画请求契约；
7. 明确的文件所有权。

子智能体只写自己负责的：

```text
src/data/points/<id>.json
generation/animation-requests/<id>.json
```

不得修改 `index.json`、manifest、动画清单、注册文件或共享样式。

### 5. 生成丰富但非填充式的详情

每个详情必须包含：

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

### 6. 提交动画意图

每个详情任务都写一个动画请求。请求必须回答：

- 输入或初始状态是什么；
- 哪个状态随时间改变；
- 每次变化遵循什么规则；
- 终态、收敛条件或循环边界是什么；
- 动画为什么比静态图更有教学价值。

仅当存在真实状态转移、迭代、传播、搜索、收敛、采样或反馈过程时标记 `needed: true`。分类、术语表和静态结构通常标记为 `false`。

### 7. 全局复核并同步索引

所有详情完成后，串行检查：

1. 标题、别名和缩写造成的重复；
2. 模板化正文或同一句式批量替换；
3. 过宽章节和过细实现细节；
4. 悬空、自引用、重复或成环的前置关系；
5. 难度、重要性和摘要与目标受众是否一致；
6. 公式、历史、年份和事实归属是否可核实。

运行：

```bash
node "$SKILL_DIR/scripts/validate_output.mjs" \
  --root "$OUTPUT_ROOT" \
  --phase points

node "$SKILL_DIR/scripts/sync_index_from_points.mjs" \
  --root "$OUTPUT_ROOT"
```

同步脚本冻结 `id`、`title` 和顺序，只从详情回写 `shortSummary`、`difficulty`、`importance`、`keyTerms`。

### 8. 归并动画机制

主智能体读取全部动画请求，按真实机制归并，写出 `generation/animation-manifest.json`：

- 同一状态机或计算过程可以共享一个组件；
- 仅主题相近、机制不同的知识点不得共享；
- 一个需要动画的知识点必须且只能绑定一个动画类型；
- `needed: false` 的点不得进入动画清单。

清单为空也是合法结果。不要设置动画数量配额。

### 9. 实现动画组件

按动画清单为每个唯一机制启动一个独立子智能体。每个任务只拥有：

```text
src/animations/<Component>.tsx
src/animations/<Component>.css
```

组件必须遵守 [animation-contract.md](animation-contract.md)，使用 React、SVG 和 CSS，除非三维空间关系确实不可替代。不得让多个动画任务修改同一文件。

组件完成后串行运行：

```bash
node "$SKILL_DIR/scripts/build_animation_registry.mjs" \
  --root "$OUTPUT_ROOT"
```

该脚本更新 points 中的动画字段，并生成 `courseKnowledge.ts`、`AnimationBlock.tsx` 和共享样式。即使没有动画也必须运行。

### 10. 全量校验

运行：

```bash
node "$SKILL_DIR/scripts/validate_output.mjs" \
  --root "$OUTPUT_ROOT" \
  --phase all

node --test "$SKILL_DIR/scripts/"*.test.mjs
```

脚本只能验证结构、注册闭环和最低动态信号，不能仅凭源码文本证明动画忠于教学机制。必须按 [animation-contract.md](animation-contract.md) 逐组件实际操作重播、重新生成、状态推进、低动态模式和响应式布局，并把人工验收结论记入最终报告。

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
- 不让并行子智能体修改共享文件。
- 不把中文标题、路径或未来占位符写入 `prerequisites`。
- 不为追求“丰富”生成重复、空泛或不可核实内容。
- 不用漂移、闪烁、旋转等装饰运动冒充原理动画。
