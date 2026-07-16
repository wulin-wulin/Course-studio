# 关系判定方法参考（v2）

本文件是 `knowledge-cluster-builder` 的判定细则。上游 v2 已产出完整内容和保证无环的 `prerequisites`，因此本阶段的工作是：**聚类分簇（含一点多簇）、标注层级角色、补横向关联，并在上游依赖之上做有据可查的优化**——而不是从零构建关系。

## 一、依赖（prerequisites） vs 关联（related）

对任意一对点 A、B：

| 提问 | 结论 |
|---|---|
| “不先掌握 B，是否根本无法开始学 A？” → 是 | A 的 `prerequisites` 含 B（有向、必需、构成 DAG） |
| “A、B 相关/易混淆/常对比，但先学哪个都行” | 互放入 `related`（无向、可选） |
| “只是碰巧同簇” | 不建立任何关系 |

`prerequisites` 与 `related` 互斥：已是前置关系的点对，不再放进 `related`。

## 二、多簇归属判定（clusterIds）

`clusterIds` 是数组，**首个为主簇**（该点最核心的归属，供森林布局/着色），其余为附加归属。

判定规则：

- **默认单簇**。绝大多数点只属于一个主题簇，`clusterIds` 只含主簇。
- **仅当一个点在多个簇都具有独立教学价值、且都会被那个簇的学习者当作本簇内容时，才追加附加簇。** 例：
  - “版本控制”既属「协作与流程」又属「工具链」；
  - “损失函数”既属「优化」又属「神经网络训练」。
- **主簇怎么选**：该点最本源、最常被归入的主题；也是它的 `role` 判定所在的簇。
- **克制**：多簇会让可视化里一个点跨区域、边界含糊。除非归属确实横跨主题，否则单簇。宁可少，不可滥。
- 附加簇不改变依赖或角色，只表示“这个点在那个簇里也应出现”。

## 三、用 kind 作先验

`kind` 来自上游 `generation/manifest.json` 的 `pointEvidence[].kind`（point 详情里没有 kind）。常见“通常依赖”方向（→ 表示“依赖”）：

| kind | 通常依赖 | 说明 |
|---|---|---|
| `algorithm` | `model` / `method` / `concept` | 算法建立在其模型和基础概念上 |
| `method` | `concept` / `model` | 方法建立在它操作的概念/模型上 |
| `model` | `concept` | 模型是对基础概念的形式化 |
| `theorem` | `concept` / `model` | 定理涉及的概念先要成立 |
| `metric` | `task` / `model` | 度量依赖被评价的任务或模型 |
| `task` | `concept` | 任务定义依赖其核心概念 |
| `phenomenon` | `concept` / `model` | 现象需要用其机制概念解释 |
| `concept` | （通常是被依赖方） | 基础概念很少依赖 algorithm/metric |

`kind` 同样是聚类的相近度信号，但以语义主题为准。

## 四、层级角色 role 判定

先用（透传+优化后的）`prerequisites` 建图，再对**每个点在其主簇内部**统计：

- **簇内入度** = 被同（主）簇其他点依赖的次数；
- **簇内出度** = 依赖同（主）簇其他点的次数。

据此定角色：

- `trunk`（主干）：簇内出度低（≈0）且入度高，或 `importance` 高、`difficulty` 偏低的枢纽概念。每个非空主簇至少一个 trunk。
- `leaf`（叶子）：簇内入度为 0（不被依赖）且出度 > 0 的末端点。
- `branch`（分支）：介于两者之间。

自查：标为 `leaf` 的点不应出现在任何点的 `prerequisites` 里。

## 五、prerequisites 的复核与优化

上游 `prerequisites` 已是无环 DAG。默认**原样透传**；仅在有明确依据时做以下三类优化，且**每处改动都记入 `generation.refinedPrerequisiteEdges`**（`{op, from, to, reason}`）：

1. **补漏（op: add）**：上游遗漏了一条必需前置。判据同第一节的“不先学 B 就学不了 A”。
   - 例：`continuous-integration → software-testing`（CI 的质量门禁以测试为前置）。
2. **去冗余（op: remove）**：一条边可由传递关系推出，属间接依赖。
   - 例：已有 `A→B` 且 `B→C`，则 A 上多余的 `A→C` 可移除，让图只保留直接前置。
3. **纠向（记为一 remove + 一 add）**：方向明显反了（更进阶点被当成了更基础点的前置）。按第六节判断哪端更基础。

原则：

- **不确定就不动**。宁可保留上游原样，也不要凭猜测增删——错误的依赖比缺失的依赖更有害。
- 每条 `reason` 要具体、可核对（说清依据，而非“优化”“更合理”这类空话）。
- 优化后必须仍无环（见第六节）。

## 六、环的打破

优化理论上可能引入环（补漏时方向搞反）。若 `check-graph.mjs` 报环，逐条反向边处理：

1. 取环上一条边 `X → Y` 与其反向；
2. 判定谁更基础：`importance` 更高者更基础；`importance` 接近（差 < 0.1）时 `difficulty` 更低者更基础；
3. 保留“较进阶点依赖更基础点”的方向，移除相反那条；
4. 在 `generation.brokenCycleEdges` 追加 `{from, to, reason}`；
5. 重新检测直到无环。

无法确信方向时，优先把这对关系降级为 `related`（无向），而不是强留一条可能错误的依赖。

## 七、id 纪律（硬约束）

- `prerequisites` / `related` / `clusterIds` 的每个元素都必须是本图中存在的 id（点 id 或簇 id，kebab-case）。
- 禁止中文标题或别名、禁止悬空、禁止自环、数组内去重。
- `clusterIds` 至少一个元素，首个为主簇。

以上任一违反都会被 `scripts/check-graph.mjs` 拦下并以非零码退出。
