---
name: knowledge-pipeline-orchestrator
description: 端到端编排课程或领域知识数据流水线：建立范围契约，调用候选知识点生成阶段，执行人工复核门禁，调用知识簇与关系构建阶段，并校验 Schema、字段透传、点集一致性和 DAG。用于用户要求从课程名或领域名完整生成知识图谱中间产物、继续中断的知识流水线、校验 candidate-points.json 与 clustered-graph.json 交接，或请求干跑整个知识加工过程时。
---

# 知识流水线编排

把两个子阶段串成可恢复、有门禁、可审计的流水线。不在本 Skill 中重复或改写子 Skill 的领域规则。

## 输入与模式

确定一种运行模式：

- `full`：输入课程名或领域名，依次生成两个中间产物。
- `resume`：从已存在且通过门禁的 `candidate-points.json` 继续；不重新生成候选池。
- `validate`：只校验现有的一个或两个产物，不改写内容。
- `dry-run`：只返回下文规定的固定机器可读状态对象，不创建产物，也不执行任何阶段。

默认输出目录为用户指定位置；未指定时使用 `knowledge-output/<subject-id>/`。目标文件固定为 `candidate-points.json` 和 `clustered-graph.json`。

## 载入子 Skill

先把本 `SKILL.md` 所在目录解析为绝对路径 `<orchestrator-dir>`，并把同级的 `../knowledge-cluster-builder` 解析为 `<cluster-builder-dir>`。从任意工作目录运行脚本时都使用这两个绝对路径，不依赖当前目录。

在运行对应阶段前完整读取：

1. 候选点阶段：[`../candidate-knowledge-point-generator/SKILL.md`](../candidate-knowledge-point-generator/SKILL.md) 及其 Schema。
2. 聚类关系阶段：[`../knowledge-cluster-builder/SKILL.md`](../knowledge-cluster-builder/SKILL.md)、关系启发式、Schema 和 DAG 校验脚本。

子 Skill 的正式语义规则高于示例。若示例与规则矛盾，遵守规则并在结果中报告矛盾；特别是同一对点不得同时是 `prerequisites` 与 `related`。

## 门禁状态机

按顺序执行，不得跳过失败门禁：

### G0_SCOPE

- 确定 `course` 或 `domain`、受众、深度、纳入范围和排除范围。
- 只有一个会显著改变点集的关键歧义时才请求用户澄清；否则记录最常见假设。

### G1_CANDIDATES

- 使用候选点 Skill 写出 `candidate-points.json`，不生成簇、关系、布局或发布详情。
- 按候选 Schema 与子 Skill 发布前清单检查。
- 运行 `node "<orchestrator-dir>/scripts/check-pipeline.mjs" <candidate-points.json>`；退出码非 0 时修复并重跑。

### G2_REVIEW

- 报告 core、boundary、needs-review 和 `reviewQueue` 数量。
- `scope-ambiguity` / `granularity` / `synonym` / `naming` 会改变点 ID 或身份时必须停止，等待复核。
- 用户明确要求 `model-only` 或全自动时，可将 `insufficient-evidence` 作为非阻断警告继续，但不得提高置信度。

### G3_GRAPH

- 仅在 G1/G2 通过后使用聚类关系 Skill。
- 严格保持候选点集，不增删点，指定的内容字段必须原样透传。
- 先建立直接学习前置，再建立横向关联，最后根据依赖图标注 role。
- 环边必须移除并记入 `generation.brokenCycleEdges`。

### G4_RELEASE_READY

依次执行：

```bash
node "<cluster-builder-dir>/scripts/check-dag.mjs" <clustered-graph.json>
node "<orchestrator-dir>/scripts/check-pipeline.mjs" <candidate-points.json> <clustered-graph.json>
```

两个命令均为退出码 0 才能声明流水线中间产物合格。这不等于已布局或已发布；不得把两个 JSON 伪装成 CKDS 发布数据。

## 恢复与覆盖规则

- 已存在的阶段产物通过门禁时直接复用；除非用户要求重建，不覆盖。
- 上游候选池发生变化时，下游图立即过期，必须重建或重新校验。
- 保留失败产物以便定点修复，不通过删除问题点或关系来伪造成功。
- 无法判定的聚类或关系降级为待人工复核，宁可少连，不可错连。

## Dry-run 输出

`dry-run` 是固定接口契约，不是可扩展示例。不要载入子 Skill、读取项目文件、执行门禁或写文件。直接输出原始 JSON，禁止 Markdown 代码围栏、前后说明和空值占位；第一个非空字符必须是 `{`，最后一个非空字符必须是 `}`，整个回复不得包含反引号。对象必须且只能包含下面 5 个顶层键，键值及数组顺序必须完全一致。不要添加 `subject`、时间戳、范围假设、计划详情或备注：

```json
{
  "pipelineSkill": "knowledge-pipeline-orchestrator",
  "mode": "dry-run",
  "gates": ["G0_SCOPE", "G1_CANDIDATES", "G2_REVIEW", "G3_GRAPH", "G4_RELEASE_READY"],
  "artifacts": ["candidate-points.json", "clustered-graph.json"],
  "blockingPolicy": "stop-on-identity-affecting-review"
}
```

## 最终报告

除产物外只报告：运行模式、已通过门禁、候选点数、簇数、前置边数、打破环边数、警告和阻断问题。不宣称未经命令证明的门禁已通过。
