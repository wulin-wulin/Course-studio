# 课程知识森林 Studio

这是一个以《人工智能原理》知识森林为起点的课程内容工作台。中间区域展示
Three.js 知识森林，右侧保留 OpenCode Agent 对话。Agent 管理课程数据；它不
负责前端交互或渲染代码。

当前已发布课程包括：

- 《人工智能原理》：23 个知识簇、603 个知识点，来自
  `D:\Project\AI_tree_course` 的已发布数据。
- 《软件工程》：9 个知识簇、35 个知识点，并包含 3 个可交互教学动画；由 Agent v2 流水线生成并发布。
- 《数据结构》：7 个知识簇、16 个知识点，并包含 12 个可交互教学动画。

## 数据与 Agent 边界

课程数据的唯一正式位置是仓库根目录的 `course-data/courses/`：

```text
course-data/courses/<course-id>/
├── course.json                 # 课程元数据
├── index.json                  # 知识簇、点位和轻量摘要
├── points/
│   └── <point-id>.json         # 单个知识点的完整内容
└── animations/                 # 可选；发布工具生成的沙箱动画包
    ├── manifest.json           # 类型、知识点绑定和资产哈希
    ├── runtime.js              # 已编译的独立 React 运行时
    └── runtime.css             # 已编译样式
```

课程导览会自动读取 `course-data/courses/` 下通过校验的课程包；新增课程无需修改
前端代码即可在列表中显示和切换。

OpenCode 在每个会话的暂存副本
`packages/backend/generated/course_agent_sessions/<conversation>/courses/`
中工作。后端校验成功的 JSON 变更后才会同步回 `course-data/courses`。生成的权限
策略只允许修改：

- `**/course.json`
- `**/index.json`
- `**/points/*.json`

它可以读取课程数据及会话说明，但不能编辑应用代码、配置或 Markdown，且
Shell、联网和交互式提问工具均被禁用。这样后续可加入课程创建、知识点生成和
内容维护 Skill，而不扩大 Agent 的文件系统权限。

## 首次准备

需要 Node.js 20+、Python 3.11+ 和已安装的
[OpenCode](https://opencode.ai)。安装项目依赖：

```powershell
cd packages\frontend
npm install
cd ..\backend
pip install -e .
cd ..\..
```

在根目录创建 `.env`，至少包含以下运行项（模型密钥请使用自己的值）：

```env
OPENCODE_ENABLED=true
OPENCODE_BASE_URL=http://127.0.0.1:4096
OPENCODE_PROVIDER_BASE_URL=
# 等待 OpenCode 返回 session.idle/session.error 的主动处理时限；等待用户确认不计时
OPENCODE_TERMINAL_TIMEOUT_SECONDS=3600
# 创建课程会生成大量内容和动画，使用独立的六小时主动处理上限
COURSE_CREATE_TERMINAL_TIMEOUT_SECONDS=21600
COURSE_DATA_DIR=course-data/courses
# Docker only: host-side absolute path to generated/course_agent_sessions
OPENCODE_COURSE_HOST_ROOT=

BACKEND_HOST=127.0.0.1
BACKEND_PORT=8000
# Comma-separated local frontend origins permitted to call the API.
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
VITE_API_URL=http://127.0.0.1:8000
VITE_WS_URL=ws://127.0.0.1:8000

# 教材 PDF 导入（可选；下面是默认值）
# 上传的原始 PDF 和解析纲要保存在 generated/document_library，
# 不会进入正式 course-data 课程包。
DOCUMENT_LIBRARY_DIR=generated/document_library
DOCUMENT_MAX_UPLOAD_BYTES=104857600
# 在前多少页查找“目录”；目录较晚时可适当调大。
DOCUMENT_TOC_SCAN_PAGES=40
DOCUMENT_PARSE_TIMEOUT_SECONDS=180
# Windows 可填写 pdftotext.exe 的绝对路径；Linux/macOS 通常只需填 pdftotext。
DOCUMENT_PDFTOTEXT_EXECUTABLE=pdftotext

# MinerU 云端解析的预留配置。当前版本的 /api/documents/{id}/parse
# 固定使用本地 Poppler；配置这些变量不会自动切换解析器。
MINERU_API_BASE=
MINERU_API_TOKEN=
MINERU_TIMEOUT_SECONDS=300
```

在根目录创建 `models.json`，每个模型都需要完整的 `id`、`base_url` 和
`api_key`：

```json
{
  "default": "your-model-id",
  "models": [
    {
      "id": "your-model-id",
      "name": "Your Model",
      "base_url": "https://your-openai-compatible-endpoint/v1",
      "api_key": "your-api-key"
    }
  ]
}
```

`models.json` 与 `.env` 都被 Git 忽略，不要提交密钥。

教材扩充阶段使用的模型也从 `models.json` 读取。Moonshot/Kimi 使用 OpenAI
兼容配置，例如：

```json
{
  "default": "kimi-k2.6",
  "models": [
    {
      "id": "kimi-k2.6",
      "name": "Kimi K2.6",
      "base_url": "https://api.moonshot.cn/v1",
      "api_key": "sk-替换为自己的密钥"
    }
  ]
}
```

`id` 必须是当前 Moonshot 账号可用的模型名；如果账号开放的是其他 Kimi
版本，替换 `default` 和模型条目的 `id` 即可。密钥只放在本机被忽略的
`models.json` 或通过应用的模型配置界面填写。

## 教材 PDF 创建课程

当前教材流程以“结构优先”为准：先从 PDF 目录恢复章节和教材知识点，再在
章节内部由 LLM 增加扩展点并生成内容。教材章节会一一对应最终知识簇，教材点
必须保留其顺序和归属；后续图谱阶段不能把教材点重新聚类到其他章节。

### 使用界面

1. 按“本地运行”启动后端、前端和 OpenCode。
2. 在右侧 Agent 面板选择 **上传教材 PDF**，选择一本可复制文本的 PDF。
3. 前端会自动上传并解析，显示章节数和知识点数；解析成功后点击
   **使用此教材创建**。
4. 课程创建会固定教材 `document_id` 和对应的 `textbook-<id>` 课程 ID，先进入
   G2 结构审核。审核通过后才会进行内容扩充、图谱装配和 G6/G7 校验。

上传、解析和课程创建是可重试的：同一 PDF 的重复上传会复用其 SHA-256 对应的
文档记录，恢复会话时也会继续使用原教材，不会把教材结构悄悄换成另一份文件。

### HTTP 接口验证

后端启动后，可以不用前端直接验证文档服务。以下命令适用于 PowerShell；把路径
替换为实际 PDF 路径：

```powershell
# 1. 上传（返回 id，例如 doc-012345...）
$uploaded = curl.exe -sS `
  -F "file=@D:\教材\深度学习.pdf;type=application/pdf" `
  http://127.0.0.1:8000/api/documents | ConvertFrom-Json
$documentId = $uploaded.id

# 2. 解析目录和知识点
curl.exe -sS -X POST `
  "http://127.0.0.1:8000/api/documents/$documentId/parse"

# 3. 查看规范化的两层纲要
curl.exe -sS `
  "http://127.0.0.1:8000/api/documents/$documentId/outline"
```

上传接口把 `Content-Type` 当作提示而不是文件真实性证明：空值、
`application/octet-stream`、`binary/octet-stream` 和 `application/x-pdf` 也可以上传，
但文件内容必须以 `%PDF-` 开头；明确声明为其他媒体类型的请求会返回 415。

三个接口的职责分别是：`POST /api/documents` 保存 PDF，
`POST /api/documents/{id}/parse` 提取目录并生成 `textbook-outline/1.0`，
`GET /api/documents/{id}/outline` 读取已经校验的纲要。解析尚未完成时读取纲要
会返回冲突错误；失败后再次调用 `parse` 可以重试。

### Poppler、本地解析和 MinerU

默认解析器调用 Poppler 的 `pdftotext -layout`，只扫描前
`DOCUMENT_TOC_SCAN_PAGES` 页（默认 40 页），先查找“目录”标题，再识别编号目录项，
例如 `1`、`1.1`、`1.2`。目录中没有编号的条目（如“前言”“安装”“符号”或
“Bibliography”）会保留在保留章节 `chapter-0`（`number: "0"`）中，按
`0.1`、`0.2`……作为教材知识点；不编号条目集中在该保留章节内并保持彼此的目录顺序，
这是为了兼容当前两层结构，原条目的标题和页码仍会保留。
如果目录页码被 PDF 文本提取器拆到下一行，解析器会在列位置和页码顺序都吻合时自动合并。
Docker 镜像已经安装 `poppler-utils`；宿主机本地运行时请自行安装
并确认命令可执行：

```powershell
# Windows（winget）
winget install --id oschwartz10612.Poppler -e
pdftotext -v
```

```bash
# macOS
brew install poppler

# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y poppler-utils
pdftotext -v
```

如果 Windows 没有把 Poppler 放进 `PATH`，可以在 `.env` 中把
`DOCUMENT_PDFTOTEXT_EXECUTABLE` 改成 `pdftotext.exe` 的绝对路径，然后重启后端。
目录不在前 40 页时调大 `DOCUMENT_TOC_SCAN_PAGES`；大 PDF 还可以调高
`DOCUMENT_PARSE_TIMEOUT_SECONDS`。单个上传默认上限为 100 MiB，可通过
`DOCUMENT_MAX_UPLOAD_BYTES` 调整。

配置中的 `MINERU_API_BASE`、`MINERU_API_TOKEN` 和 `MINERU_TIMEOUT_SECONDS` 是
为后续 MinerU 适配器保留的后端设置。当前版本没有在上传接口中调用 MinerU，因而
没有 Token 也可以使用本地流程；接入云端适配器后，Token 仍只应放在 `.env`，不应
写进课程数据、Skill 或前端代码。

本地 `pdftotext` 对扫描件、图片目录、复杂多栏排版、目录页码跨行方式特殊的 PDF 仍可能无法
恢复完整结构。此时接口会返回解析失败或漏项，应该先进行 OCR/版面转换，或在后续
MinerU 适配器可用后切换解析器，再进入课程创建；不要把不完整的纲要直接当成正式
课程结构。

## 本地运行

在三个终端中分别启动后端、前端与 OpenCode：

```powershell
# 终端 1：后端
cd packages\backend
python -m uvicorn src.main:app --host 127.0.0.1 --port 8000 --reload
```

```powershell
# 终端 2：前端
cd packages\frontend
npm run dev
```

```powershell
# 终端 3：OpenCode（Windows）
.\scripts\opencode.ps1
```

在 Bash / WSL / macOS / Linux 中使用：

```bash
bash scripts/opencode.sh
```

长时间生成课程时，建议改用带自动重启的后台守护方式，避免终端关闭导致
OpenCode 服务退出：

```bash
bash scripts/opencode-service.sh start
bash scripts/opencode-service.sh status
# 不再需要时停止
bash scripts/opencode-service.sh stop
```

在 macOS 上该命令使用系统自带的 detached `screen` 会话，在其内部自动重启
OpenCode（避免 LaunchAgent 无法访问 Desktop/Documents 的系统隐私限制）；在
Linux / WSL 上使用独立于终端的 supervisor 进程。日志和 PID 等运行文件保存在
`packages/backend/generated/opencode-service/`，不会提交到 Git。

如果 PowerShell 拒绝执行脚本，可仅对当前终端临时放行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

启动脚本会从 `.env` 与 `models.json` 生成受限的 OpenCode 配置。默认工作目录
是 `packages/backend/generated/course_agent_sessions`；仅在受控测试环境中才使用
`OPENCODE_WORKSPACE_DIR` 覆盖它。

## 迁入原课程数据

仓库已经包含可展示的初始课程数据。若需要从原项目重新导入，请在根目录运行：

```powershell
python .\scripts\import_ai_tree_course.py
```

导入脚本只读取 `D:\Project\AI_tree_course`，不会修改源项目。为了避免覆盖
Agent 或人工后的课程内容，它默认拒绝覆盖已有课程包；只有明确需要重置时才用
`--force`。迁入时会保留原 `index.json` 和知识点 JSON 的原始内容，并报告旧
数据兼容性提示，不会擅自重排知识森林。

可通过 `AI_TREE_COURSE_SOURCE` 或 `--source` 指定另一个源项目位置：

```powershell
python .\scripts\import_ai_tree_course.py --source D:\another\AI_tree_course
```

## Docker（可选）

Compose 运行前端和后端；OpenCode 仍应在宿主机上运行，因为它需要访问宿主机
的会话暂存目录。为 Docker 后端设置宿主机可见的暂存根目录：

```env
# Windows 示例
OPENCODE_COURSE_HOST_ROOT=D:\Project\CAD-studio\packages\backend\generated\course_agent_sessions

# WSL/Linux 示例
# OPENCODE_COURSE_HOST_ROOT=/mnt/d/Project/course-knowledge-agent/packages/backend/generated/course_agent_sessions
```

先在宿主机启动 OpenCode，再构建容器：

```powershell
.\scripts\opencode.ps1
docker compose up --build
```

Compose 将 `course-data/` 和 `packages/backend/generated/` 绑定挂载到后端，并
通过 `host.docker.internal:4096` 连接宿主机 OpenCode。不要用命名卷替换这两个
目录，否则容器后端和宿主机 Agent 会看到不同的会话或课程内容。在 Linux Docker
宿主机上，如容器无法连接到宿主机 OpenCode，请在启动前设置
`OPENCODE_HOSTNAME=0.0.0.0`；PowerShell 与 Bash 启动脚本都会读取该 `.env` 值。

## 验证与排障

检查服务：

```powershell
curl http://127.0.0.1:8000/api/health
curl http://127.0.0.1:4096/global/health
```

若 Agent 报模型配置不完整，请检查 `models.json` 中所选模型的 `base_url` 与
`api_key`。若后端在 Docker 中无法连接 OpenCode，先确认 `OPENCODE_COURSE_HOST_ROOT`
是运行 OpenCode 的宿主机环境所见的绝对路径，而不是容器内 `/app/...` 路径。

## Agent 创建课程

在前端切换到 **Agent** 模式，点击输入框下方的 **创建课程**。系统会新建一个
隔离对话，并依次使用仓库 `skills/` 下的候选知识点生成、知识聚类和流水线编排
三个 Skill：

1. 确认课程范围与目标学习者；
2. 生成课程元数据与全量知识点索引，并停在 G2 知识点清单审核门；左侧审核工作区支持搜索、新增、删除和零修改一键通过；
3. 审核通过后生成逐点完整内容、动画请求和必要的教学动画；正文与动画不要求用户在生成阶段审核，但结构、注册、生产构建、依赖安全和资产完整性自动校验仍会阻断错误；
4. 构建知识簇、多簇归属、前置关系与横向关联；正文和课程主题由装配脚本从上游文件机械透传，禁止模型手工精简或改写；
5. 图谱装配检查通过后停在 G6 知识图谱审核门；左侧审核工作区可调整簇归属、添加或移除带原因的前置依赖，`related` 关系只读，并在前后端校验 DAG；
6. 图谱审核通过后在 G7 执行端到端校验，再次获得明确发布确认；
7. 生成正式课程包和 organic 知识地图布局。

G0-G7 中间文件保存在对应会话的 `pipeline/<course-id>/course-content/` 与同级
`clustered-graph.json`，不会直接进入正式课程。旧版 `candidate-points/1.0` 和
`clustered-graph/1.0` 不能作为 v2 流水线的恢复输入。
两次结构化审核都绑定当前产物哈希和版本号；审核提交后会回到原课程创建对话继续，
刷新页面或网络中断时由持久化恢复任务安全重试，不会把审核结果作为一条伪造的新对话。
正式发布仍会经过后端课程结构校验和冲突检查；同名课程不会被自动覆盖。新版 Skill
生成的 React 教学动画会在发布阶段通过项目内的 esbuild 做真实生产打包；语法、依赖、
组件或样式不完整时会原子失败，不会留下半个课程包。正式目录只保存编译产物，不保存或
直接执行会话 TSX。后端按清单哈希验证 `runtime.js`/`runtime.css`，阅读页再通过仅开放
脚本权限的 iframe 沙箱加载；旧课程没有动画运行包时继续显示正文提示。
G7 校验和动画构建分别有 120 秒、300 秒的默认超时，超时会明确失败并清理临时目录；
特殊大课程可通过 `COURSE_PIPELINE_G7_TIMEOUT_MS` 与 `COURSE_ANIMATION_BUNDLE_TIMEOUT_MS`
调整上限。

可以单独验证 v2 发布器和动画安全边界：

```powershell
# 后端文档服务、教材绑定和 API 契约
cd packages\backend
.\.venv\Scripts\python.exe -m unittest tests.test_documents -v

# 流水线与教材结构校验器
cd ..\..
node --test scripts/course-pipeline-v2.test.mjs
node --test scripts/course-pipeline-tool.test.mjs scripts/textbook-outline.test.mjs

# 全部后端单元测试
cd packages\backend
.\.venv\Scripts\python.exe -m unittest discover -s tests -v

# 前端契约测试和生产构建
cd ..\frontend
npm test
npm run build
```

`textbook-outline.test.mjs` 会验证两层教材树、章节到知识簇的固定映射、扩展点
锚点和顺序约束。它使用临时工作区，不会改动正式课程数据。运行真实教材验证时，
请先启动后端，再按上面的 HTTP 示例上传和解析；若要继续完整的 G0-G7 课程创建，
还需要启动 OpenCode，并在 `models.json` 中配置可用模型。真实模型调用可能产生费用，
不会由单元测试自动触发。

后端与 OpenCode 已启动时，可以运行真实端到端冒烟测试。它会通过 WebSocket 使用
一个唯一的概念型课程主题，依次经过 G0-G7、正式发布和后端读取，
成功后自动删除测试课程：

```powershell
packages\backend\.venv\Scripts\python.exe -u scripts\smoke_test_course_creation.py
```

测试会话的中间产物会保留在 `packages/backend/generated/course_agent_sessions/`，便于
排查门禁和模型输出；该目录不会进入正式课程数据或 Git。

## 历史对话

右侧课程助手标题栏提供历史对话入口。对话元数据、用户消息、助手回复、模式、模型和
课程创建工作流状态会保存在本机 SQLite 数据库：

```text
packages/backend/generated/conversations.sqlite3
```

当前按单用户本地应用设计，不需要账号登录。打开历史记录可恢复消息并继续对话，也可
删除不再需要的记录。删除历史记录不会删除已经发布的课程。此功能启用前产生的旧对话
没有进入数据库，无法自动补回；启用后的记录在刷新页面或重启后端后仍可读取。

可使用真实 Chat 请求验证消息写入和历史 API：

```powershell
packages\backend\.venv\Scripts\python.exe -u scripts\smoke_test_conversation_history.py
```

## 课程数据维护约定

- 新课程使用小写 kebab-case 目录和 ID，例如 `data-structures`。
- 每个知识点详情文件名必须与其 `id` 一致。
- 知识点修改后，应同步 `index.json` 中对应的轻量字段。
- `pos`、`scale`、`polygon` 与 `labelPos` 是森林布局数据；内容维护时不要随意
  改动它们。
- 新增、删除或批量生成内容的 Skill 应先校验知识簇引用与前置知识关系，再提交
  课程数据。

## 课程地图布局

使用内置脚本可重新生成任意正式课程的知识簇轮廓、节点坐标和节点缩放，而不改动
课程内容、配色或知识关系。默认只预览；只有传入 `--apply` 才会写入
`index.json` 与对应的 `points/*.json`：

```powershell
# 预览不规则岛屿式布局；同一个 seed 会得到完全相同的结果
node .\scripts\layout-course-map.mjs software-engineering --style organic --seed se-organic-v1

# 确认后写入课程数据
node .\scripts\layout-course-map.mjs software-engineering --style organic --seed se-organic-v1 --apply
```

目前提供 `organic`（岛屿式、不规则）和 `compact`（更紧凑）两种布局风格。新风格可在
`scripts/layout-course-map.mjs` 的 `MAP_LAYOUT_STYLES` 中扩展。

## License

MIT
