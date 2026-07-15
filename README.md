# 课程知识森林 Studio

这是一个以《人工智能原理》知识森林为起点的课程内容工作台。中间区域展示
Three.js 知识森林，右侧保留 OpenCode Agent 对话。Agent 管理课程数据；它不
负责前端交互或渲染代码。

当前内置课程包包含 23 个知识簇和 603 个知识点，来自
`D:\Project\AI_tree_course` 的已发布数据。

## 数据与 Agent 边界

课程数据的唯一正式位置是仓库根目录的 `course-data/courses/`：

```text
course-data/courses/<course-id>/
├── course.json                 # 课程元数据
├── index.json                  # 知识簇、点位和轻量摘要
└── points/
    └── <point-id>.json         # 单个知识点的完整内容
```

当前界面加载 `ai-principles`。目录结构已经支持更多课程包；“创建/切换课程”
的学习者界面会在后续产品迭代中补充。

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
COURSE_DATA_DIR=course-data/courses
# Docker only: host-side absolute path to generated/course_agent_sessions
OPENCODE_COURSE_HOST_ROOT=

BACKEND_HOST=127.0.0.1
BACKEND_PORT=8000
# Comma-separated local frontend origins permitted to call the API.
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
VITE_API_URL=http://127.0.0.1:8000
VITE_WS_URL=ws://127.0.0.1:8000
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

## 课程数据维护约定

- 新课程使用小写 kebab-case 目录和 ID，例如 `data-structures`。
- 每个知识点详情文件名必须与其 `id` 一致。
- 知识点修改后，应同步 `index.json` 中对应的轻量字段。
- `pos`、`scale`、`polygon` 与 `labelPos` 是森林布局数据；内容维护时不要随意
  改动它们。
- 新增、删除或批量生成内容的 Skill 应先校验知识簇引用与前置知识关系，再提交
  课程数据。

## License

MIT
