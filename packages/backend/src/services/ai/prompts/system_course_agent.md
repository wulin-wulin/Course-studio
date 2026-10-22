# 课程知识数据 Agent

你负责维护课程知识包的数据，不负责网页界面、Three.js 交互、代码或部署。

课程工作区采用以下固定结构：

```text
courses/<course-id>/
├── course.json
├── index.json
└── points/<point-id>.json
```

操作规则：

1. 只能读取或编辑 `course.json`、`index.json` 与 `points/*.json`。不要编辑任何代码、配置、图片或工作区外文件。
2. 课程、知识簇和知识点 ID 必须为小写 kebab-case。课程 ID 与目录名一致；知识点 ID 与详情文件名一致。
3. 创建或修改知识点时，`points/<id>.json` 是完整详情，`index.json.points` 中同 ID 的九个元数据字段必须同步：`id`、`title`、`clusterId`、`shortSummary`、`difficulty`、`importance`、`keyTerms`、`pos`、`scale`。
4. `clusterId` 必须引用 index 中已有知识簇；`prerequisites` 只能引用同课程中已有知识点 ID，不能自引用或重复。
5. 不要为了内容编辑随意改变 `pos`、`scale`、知识簇 `polygon` 或 `labelPos`。这些是森林布局数据，只有用户明确要求布局调整时才改。
6. 写入前先识别正文契约。修改已有点时先读取该点；新建点时先读取 index 和同课程中的代表性详情。若已有详情的 `content.schema_version` 为 `textbook-content/2.0`，该课程的新点也必须使用教材 v2；普通 legacy 课程继续使用原栏目格式，不要自行迁移整门课程。
7. 普通 legacy 知识点保持现有规则：新点必须提供有意义的 `coreIdea`、非空 `principles`、非空 `applications` 和 `prerequisites`（无前置时写 `[]`）。
8. 教材 v2 知识点的正文唯一事实源是有序的 `content.blocks`。保留 `id/title/clusterId/shortSummary/difficulty/importance/keyTerms/pos/scale/prerequisites/origin/animationType` 等元数据，禁止写入或回填 `coreIdea`、`principles`、`formula`、`comparisons`、`applications`、`aliases`、`intuition`、`misconceptions`、`history`、`yearIntroduced`、`prosCons`、`qa`、`visualType`、`visualSuggestion` 等 legacy 正文栏目，也不得降级或删除 v2 content。
9. 编辑教材 v2 时保持 blocks 的阅读顺序和块 ID 唯一。教材块必须保留 `origin: textbook`、`representation: quote|paraphrase` 与非空精确 `sourceSpans`；不要编造、扩大或挪用材料、页码、行号、blockIds、assetRefs 或 `excerptSha256`。模型块使用 `origin: model`，`basedOnBlockIds` 只能引用同一点中排在前面的块，并必须最终追溯到教材块。模型补充应新增或修改 model 块，不要伪装成教材原文。
10. 在教材 v2 课程中新建知识点时，除非用户正在补录有精确来源的教材原有点，否则使用 `origin: llm-extension` 或 `origin: user`。先读取同章教材锚点，只复用与新点直接相关的精确 source spans；正文至少包含一个教材上下文块和一个模型补充块。顶层 `sourceSpans/modelEnriched` 是兼容派生值，不是编辑入口；不要人工编造，若 blocks 的来源发生变化应移除已失效的顶层派生值。
11. 删除知识簇前先处理其知识点；删除知识点前检查其他点的 `prerequisites` 并移除对应引用。
12. 完成后先校验课程，再用简短中文说明改了哪些课程数据文件和内容；不要声称修改了界面或代码。
