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
- 并发上限服从当前平台限制；默认以 8 个任务一波为安全起点。
- 同一依赖邻域可并行写详情，因为前置 ID 已冻结；不得根据尚未完成的正文发明新 ID。
- 每波完成后先做逐文件结构校验，再启动下一波。
- 子智能体失败不影响其他互斥任务；只重试失败任务。

## 详情任务输入

每个详情任务都必须获得以下完整上下文：

1. `course.json`；
2. manifest 中的受众、深度、范围、排除项和学习成果；
3. 自己负责的完整索引项；
4. 全量合法 prerequisite ID 与 `id → title` 注册表；
5. 为本任务筛出的建议前置候选；
6. 与负责知识点直接相关的来源记录；
7. [data-contract.md](data-contract.md)；
8. 本任务可写文件的绝对或相对路径；
9. 禁止修改的共享文件列表。

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

只允许写：
[points 文件路径]
[animation request 文件路径]

必须遵循：
[data-contract.md 的绝对路径]

任务：
1. 为每个索引项生成一个完整 points JSON。
2. id、title 必须与索引完全一致；不得创建新知识点 ID。
3. prerequisites 只能从全量注册表选择，并保持最小必要集合。
4. 必填内容必须具体、可教学、非模板化；可选事实字段只在适用且可核实时生成。
5. point 初稿写 animationType: "none"。
6. 为每个 point 生成一个动画请求；只有真实动态机制才写 needed: true。
7. 自检 JSON、文件名、字段、引用和事实后再结束。

禁止修改 index、manifest、动画清单、注册文件和任何未授权路径。

最终只报告：写入文件、使用的前置 ID、动画请求结论、仍有疑问的事实。
```

## 逐任务验收

详情任务完成后，主智能体至少检查：

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
3. 仍失败：主智能体接管该文件，不要扩大权限或让另一个并发任务覆盖它。
4. 发现索引本身错误：暂停受影响任务，由主智能体串行修订索引和 manifest，再重新生成任务清单。

不得用忽略校验、删除问题字段或把引用改为空数组来掩盖错误。

## 全局 points 复核

逐任务校验不能替代全局复核。全部详情完成后检查：

- 标题、英文名、缩写和别名的重复；
- 不同点的 `coreIdea` 是否能清楚区分；
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
[绑定知识点的 title/coreIdea/principles]

只允许写：
src/animations/[Component].tsx
src/animations/[Component].css

必须遵循：
[animation-contract.md 的绝对路径]

要求：
1. 准确展示输入、关键中间状态、更新规则和终态/循环边界。
2. 提供重播；涉及随机性时使用可复现 seed，并区分重播与重新生成。
3. 使用响应式 SVG/React/CSS，提供 aria-label、role="img" 和 <title>。
4. 支持 prefers-reduced-motion，静态终态仍可读。
5. 清理全部定时器、动画帧、监听器、观察器和图形资源。
6. CSS 类使用组件命名空间，不修改全局元素选择器。
7. 不修改注册表、类型文件、points、manifest 或其他动画。

完成后说明输入、变化状态、规则、终态和人工验证方式。
```

## 动画任务验收

- 组件和同名 CSS 均存在；
- 组件默认导出且根视图含 `animation-stage`；
- SVG 有 `role="img"` 和 `<title>`，根视图有准确中文 `aria-label`；
- 标签能解释变化规则，颜色不是唯一信息通道；
- CSS 有组件命名空间和低动态降级；
- 重播回到同一初始条件；重新生成才改变随机样本；
- effect 清理覆盖所有副作用；
- 机制与清单中所有绑定点都一致。

所有动画任务完成后，才由主智能体运行注册构建脚本。

## 最终串行步骤

```text
validate --phase points
sync_index_from_points
write animation-manifest
animation component tasks
build_animation_registry
validate --phase all
node --test scripts/*.test.mjs
project build（若可用）
```

任何串行步骤失败时，停止发布并修复根因；不要在失败状态下继续添加更多内容。
