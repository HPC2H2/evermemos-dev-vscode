# EverMemOS VS Code 插件（云端版）

[English version](#evermemos-vs-code-extension-cloud) | [中文](#evermemos-vs-code-插件云端版)

将 EverMem Cloud 直接接入 VS Code：保存/搜索/概览记忆，一键侧边栏操作，命令面板亦可用。
点击以下链接可观看demo视频：
https://github.com/user-attachments/assets/c81924dd-5be1-4a26-b780-a949442fd751
## 本版亮点（用户功能）
- 一键保存：Alt+M；无输入时自动抓取当前文件/选区，附带语言、路径、选区行、Git 分支。
- 快速回顾：Ctrl+Shift+R（mac: Cmd+Shift+R），留空即可查看最近记忆。
- 搜索结果卡片：语法高亮、显示分支/路径，支持一键插入代码或打开文件；无编辑器会自动新建文档。
- 结构化 MemCell：保存时为代码/bug 记忆写入片段、路径、语言、分支元数据，检索时直接展示。
- 侧边栏易用：测试连接、保存、搜索/回顾、概览、删除、查看日志一站式。
- 云端兼容：官方 API 自动选择 v0/v1，健康+鉴权探针帮助判定 Key 可用。

## 功能速览
- 侧边栏卡片式 UI：填 Key、测试连接、保存记忆、搜索/回顾、项目概览、删除记忆、日志回显。
- 选区/整文件/自定义文本入库，支持备注；无输入时自动捕获当前文件/选区并写入 MemCell 元数据（代码/bug、路径、语言、分支）。
- 云端自动摘要与回顾（由 EverMemOS Cloud 处理），搜索结果卡片支持语法高亮、分支标记、插入代码、打开文件。
- 命令面板快捷：Add Memory / Quick Recap / Project Overview / Delete Memory / Open Sidebar；新增 Alt+M、Ctrl/Cmd+Shift+R 快捷键。

## 安装与运行
```bash
npm install
npm run compile
```
本地调试：在 VS Code 中按 `F5` 启动 Extension Development Host，新窗口侧边栏打开 EverMemOS。

## 配置 API Key
1) GUI：设置中搜索 `evermem.apiKey`（或在侧边栏 Cloud API 卡片直接填写/保存），`evermem.apiBaseUrl` 默认 `https://api.evermind.ai`。
2) 环境变量（可选）：`export EVERMEM_API_KEY="<你的APIKey>"` 后从同一终端启动 VS Code。
API Key 在 [console.evermind.ai](https://console.evermind.ai) 获取（示例：` 46b7d3f9-199a-4665-ad1c-6495e1945fd7`）。

## 侧边栏使用（推荐路径）
1. 点「测试连接」确认联通。
2. 「保存记忆」：默认取当前选区/文件；若在表单输入文本则以表单为准，可附加备注。
3. 「搜索/快速回顾」：输入关键词（留空返回最近记忆），结果以卡片 Webview 展示，支持语法高亮、一键插入/打开文件。
4. 「项目概览」：输出当前工作区的记忆概览。
5. 「删除记忆」：按提示选择并删除。
6. 「状态/日志」：查看最近 12 条操作反馈。

## 命令面板（Command Palette）
- EverMemOS: Add Memory
- EverMemOS: Quick Recap
- EverMemOS: Project Overview
- EverMemOS: Delete Memory
- EverMemOS: Open Sidebar

## Memory → Reasoning → Action（预览实现）
- Memory：保存时生成结构化 MemCell（代码/bug 类型、文件路径、语言、分支、代码片段），随 metadata 一起写入。
- Reasoning：利用云端返回的 summary 即时展示在卡片上，可直接理解“代码/bug 在做什么”。
- Action：卡片提供一键插入代码、打开文件跳转；无活动编辑器会自动新建文档插入。

## 场景化 Demo（Quality & Execution）
- 典型调试链路：在报错处选中堆栈 → Alt+M 保存为 Bug MemCell（自动带分支/文件）→ Ctrl/Cmd+Shift+R 搜索关键词或分支 → 读取 summary 了解原因 → 点击插入示例修复代码。
- 高实用场景：分支关联记忆（保存时自动写入当前 git 分支，搜索卡片展示分支，便于区分环境）+ 快捷键+自动上下文抓取（零输入也能保存当前文件）。

## 配置项
- `evermem.apiBaseUrl`：默认 `https://api.evermind.ai`
- `evermem.apiKey`：云端 API Key，支持 `EVERMEM_API_KEY`
- `evermem.authToken`：旧版自托管 Token（有 apiKey 时可留空）

## 用户反馈（示例）
- 开发者 A：希望保存时自动带分支做筛选 —— 已实现（MemCell 记录分支）。
- 开发者 B：没有选中文本时希望自动抓取上下文 —— 已实现（自动取当前文件/选区）。
- 开发者 C：搜索结果想直接插入代码 —— 已实现（卡片按钮，一键插入或打开文件）。

## 测试
```bash
npm test
```
覆盖：`safeTruncate` 截断、`requestWithRetry` 网络重试、`createClient` 去尾 `/api` 与授权头、`getConfig` 设置+环境变量读取。

## 故障排查
- 401/403：Key 无效/过期，重新在 console.evermind.ai 获取。
- 连接失败：检查网络/防火墙，确认 `apiBaseUrl` 可访问，重测连接。
- 空结果：刚写入需排队；留空关键词可列最近记忆。
- 删除失败/404：目标部署可能未开放删除接口，稍后重试或查云端文档。

## 参考
- 云端文档：<https://docs.evermind.ai>
- 后端源码：<https://github.com/EverMind-AI/EverMemOS>
- 官方示例：<https://github.com/EverMind-AI/evermem-claude-code>

遇到问题可查看侧边栏日志并反馈。祝使用顺利！

---

# EverMemOS VS Code Extension (Cloud)

[中文版本](#evermemos-vs-code-插件云端版)

Bring EverMem Cloud into VS Code: save/search/overview memories from the sidebar or Command Palette.
Click the link below to watch demo video:
https://github.com/user-attachments/assets/c81924dd-5be1-4a26-b780-a949442fd751

## Highlights (user-friendly)
- One-touch save: Alt+M. If you leave input empty, it auto-captures the current file/selection with language, path, range, and git branch.
- Quick recap: Ctrl+Shift+R (Cmd+Shift+R on mac); blank query lists recent memories.
- Rich result cards: syntax-highlighted snippets with branch/path, buttons to insert into editor or open file; opens a new doc if no editor.
- Structured MemCells: code/bug cells store snippet/path/language/branch so results carry meaningful context.
- Sidebar convenience: test connection, save, search/recap, overview, delete, and logs in one place.
- Cloud compatibility: official API v0/v1 auto-preference plus health/auth probe to validate keys.

## Features
- Card-style sidebar: set API, test connection, save memory, search/recap, project overview, delete, and recent logs.
- Save selection/whole file/custom text with optional note; when blank, auto-captures current file/selection into a structured MemCell (type, path, language, branch, snippet).
- Cloud-side summarization/recap handled by EverMemOS Cloud; search cards show branch, syntax-highlighted snippet, insert/open buttons.
- Command Palette shortcuts: Add Memory / Quick Recap / Project Overview / Delete Memory / Open Sidebar; new Alt+M, Ctrl/Cmd+Shift+R keybindings.

## Install & Run
```bash
npm install
npm run compile
```
Debug locally: press `F5` in VS Code to launch an Extension Development Host, then open the EverMemOS sidebar there.

## Configure API Key
1) GUI: search `evermem.apiKey` in Settings (or fill/save in the Cloud API card). `evermem.apiBaseUrl` defaults to `https://api.evermind.ai`.
2) Env var (optional): `export EVERMEM_API_KEY="<your API key>"` before launching VS Code from the same shell.
Get your key from [console.evermind.ai](https://console.evermind.ai) (example: ` 46b7d3f9-199a-4665-ad1c-6495e1945fd7`).

## Sidebar Flow (recommended)
1. Click **Test Connection**.
2. **Save Memory**: uses current selection/file by default; text entered in the form overrides it; note is optional.
3. **Search / Quick Recap**: enter keywords (blank returns recent memories); results open in a card-style webview with syntax highlighting and insert/open buttons.
4. **Project Overview**: get workspace-level summary.
5. **Delete Memory**: follow prompts to remove entries.
6. **Status / Logs**: last 12 actions.

## Commands (Command Palette)
- EverMemOS: Add Memory
- EverMemOS: Quick Recap
- EverMemOS: Project Overview
- EverMemOS: Delete Memory
- EverMemOS: Open Sidebar

## Memory → Reasoning → Action (preview)
- Memory: structured MemCells (code/bug) with snippet, path, language, branch are stored in metadata when saving.
- Reasoning: surface cloud-provided summaries directly on cards so you can see “what this code/bug does” at a glance.
- Action: cards ship “Insert to editor” and “Open file” buttons; if no editor is active, a new doc is opened and populated automatically.

## Scenario demo (Quality & Execution)
- Debug flow: select the stack trace at failure → Alt+M to save as a Bug MemCell (auto branch/path) → Ctrl/Cmd+Shift+R to search by keyword/branch → read the summary → click to insert a suggested fix.
- High-practical case: branch-aware memories (branch captured on save, shown on cards) + shortcuts + auto context capture to reduce clicks.

## Settings
- `evermem.apiBaseUrl`: default `https://api.evermind.ai`
- `evermem.apiKey`: cloud API key, supports `EVERMEM_API_KEY`
- `evermem.authToken`: legacy self-hosted token (leave empty if apiKey is set)

## User feedback (sample)
- Dev A: “Need branch-aware filtering.” — Implemented (MemCell records branch).
- Dev B: “Auto-capture when nothing is selected.” — Implemented (current file/selection auto-saved).
- Dev C: “Want direct code insertion from results.” — Implemented (card buttons insert/open).

## Tests
```bash
npm test
```
Covers: `safeTruncate`, `requestWithRetry` (network retry), `createClient` (trim `/api` + auth header), `getConfig` (settings + env).

## Troubleshooting
- 401/403: key invalid/expired; fetch a new one from console.evermind.ai.
- Cannot connect: network/firewall or wrong `apiBaseUrl`; retest connection.
- Empty results: recent writes may be pending; try blank keyword to list recent memories.
- Delete fails/404: target deployment may not expose delete; retry later or check cloud docs.

## References
- Cloud docs: <https://docs.evermind.ai>
- Backend repo: <https://github.com/EverMind-AI/EverMemOS>
- Official sample: <https://github.com/EverMind-AI/evermem-claude-code>

Check the sidebar logs for recent events if anything looks off. Enjoy!
