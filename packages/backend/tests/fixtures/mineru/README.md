# MinerU Markdown 教材测试资源

这组 fixture 用于开发“已经获得 MinerU Markdown 后”的教材知识森林链路。它不调用 MinerU、Kimi 或其他外部服务，也不包含密钥和真实教材版权内容。正文、结构和图片均由仓库内脚本确定性生成。

## 采用的格式基线

本项目当前接入的是 MinerU 在线精准 API v4。格式判断基于两类证据：

1. [MinerU 在线 API 文档](https://mineru.net/apiManage/docs) 在 2026-10-22 仍说明，非 HTML 结果 ZIP 中的 `full.md` 是 Markdown，`*_content_list.json` 是内容列表，`layout.json` 对应中间处理结果；具体成员应以下载到的 ZIP 为准。
2. 本项目在 2026-10-15 保存的真实在线 VLM 返回包含 `full.md`、`*_content_list.json`、`*_content_list_v2.json`、`layout.json` 和 `images/`。真实样本位于被忽略的研究目录，只作为格式核对依据，不是测试运行依赖。

[MinerU 当前开源输出说明](https://opendatalab.github.io/MinerU/reference/output_files/) 已进入 4.0 的统一文档模型，文件名、图片命名和中间 JSON 协议正在演进。开源 SDK 或自部署 V1 的能力不能直接当作在线精准 API 的固定契约。因此，下游适配器应检测实际成员和 schema，不能只按 MinerU 版本号猜测格式。

本 fixture 模拟目前项目需要消费的托管 API ZIP：

```text
result.zip
├── full.md
├── <name>_content_list.json
├── <name>_content_list_v2.json
├── layout.json
└── images/
```

`expected.json` 是 Course Studio 的测试 oracle，不属于 MinerU ZIP，所以不放入 `result.zip`。

## 字段约定

### `full.md`

- 是按阅读顺序展平的 UTF-8 Markdown。
- 标题使用 `#` 层级；行间公式使用 `$$ ... $$`；表格允许 HTML；代码使用 fenced code block。
- 图片使用相对于 ZIP 根目录的路径，例如 `images/page_3_image_1.png`。
- Markdown 本身没有可靠的原始页边界。fixture 故意不添加自定义分页注释，避免测试代码依赖 MinerU 不保证的标记。

### Content List V1

- 顶层是按阅读顺序展平的 `list[dict]`。
- 每个块含从 0 开始的 `page_idx` 和映射到 0–1000 的 `bbox`。
- 标题和正文同为 `type: "text"`；标题通过 `text_level` 区分，正文为 0。
- 视觉块采用 `image`、`table`、`equation`；代码和算法使用 `code` 加 `sub_type`。
- 页眉、页脚和页码分别使用 `header`、`footer`、`page_number`。这些块可用于版面核查，不应进入知识点正文。
- `table_body` 使用 HTML；行间公式的 `text` 保存 LaTeX，并带 `text_format: "latex"`。

### Content List V2

- 顶层按原始页分组，即 `list[list[dict]]`；页号由外层下标确定，块内通常不再重复 `page_idx`。
- 统一使用 `type + content`，包括 `title`、`paragraph`、`equation_interline`、`image`、`table`、`code`、`algorithm` 和页面辅助块。
- V2 在 MinerU 3.x 文档中曾标为开发格式，且在线 API 文档没有要求消费者只能使用 V2。因此它适合作为兼容性输入，不应成为唯一可接受输入。

### `layout.json`

fixture 仅保存在线 VLM 旧式中间结果的可消费子集：`pdf_info`、`page_idx`、`page_size`、`para_blocks`、`discarded_blocks`、`_backend` 和 `_version_name`。它足以测试页码账本和块定位，不模拟模型置信度、行级 span 或真实 OCR 坐标精度。测试不能用这些占位 bbox 评价 MinerU 的实际版面识别质量。

## 两套样本

| 目录 | 规模 | 用途 |
| --- | ---: | --- |
| `small/` | 6 页、2 章、4 个教材知识点 | 快速单元测试；公式、HTML 表格、相对图片、算法、重复局部标题 |
| `large/` | 30 页、3 章、12 个教材知识点 | 分块与归并、完整树恢复、顺序边、逐点正文检索、教材内容与模型扩展区分 |

`small/` 使用真实托管样本曾出现的哈希图片名；`large/` 使用当前文档示例中的 `page_{page_idx}_{type}_{ordinal}.png`。两种命名同时存在，是为了确保消费端读取引用，而不是自行拼接文件名。

`large/full.md` 包含十二个编号知识点，同时反复出现三级标题“推演、边界与自查”。预期算法应把编号知识点恢复为教材树，把重复三级标题视为组织内容。附录也是教学材料，但不应机械转换成主知识点。`expected.json` 还列出了：

- 教材章节与知识点的期望集合；
- 模拟原始页范围；
- 章节和知识点阅读顺序边；
- 可供模型建议、但不能冒充教材原有节点的扩展机会；
- 测试覆盖特征。

图片是确定性占位图。图片标题和正文可以测试资源绑定与来源引用，但这组 fixture 不用于视觉理解准确率测试。

## 章节结构候选样本

`structure_cases/` 是一个小型、无版权的结构回归样本，专门覆盖真实教材中常见的
`第 N 章`、OCR 产生的 `N 章`、重复页眉、附录、答案和参考文献。它不模拟完整正文，
只用于验证第一阶段的章节候选提取与证据校验；原始 Markdown 文件在测试过程中必须保持
字节级不变。

## 安全与兼容要求

消费这些产物时应满足以下规则：

- 页码以 Content List 或受支持的结构化 JSON 为准，不能按 Markdown 字符位置反推。
- 图片引用必须相对结果包根目录解析，拒绝绝对路径、`..`、符号链接和越界文件。
- 跟随 Markdown/JSON 中的真实路径；不要假设所有版本都用哈希名或 `page_*` 名。
- 未识别块类型应保留为 finding，不能静默丢弃后仍声称完整覆盖。
- 表格、公式和图片可以缺少某些可选字段；适配器应验证必需定位信息，并对降级情况作明确记录。
- 标题层级只是结构证据之一。目录、编号、正文范围和重复语义还需要共同参与知识点判断。

## 重新生成与校验

在仓库根目录运行：

```powershell
python packages/backend/tests/fixtures/mineru/generate_fixtures.py
python packages/backend/tests/fixtures/mineru/generate_fixtures.py --check-only
```

校验会检查页码覆盖、V1/V2 页数、bbox 范围、图片引用、路径安全、标题存在、ZIP 成员和文件哈希。生成器不读取 `.env`、`models.json`、API key 文件或研究目录中的真实解析结果。
