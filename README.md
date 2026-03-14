# EverMemOS VS Code 插件（云端版）

[English version](#evermemos-vs-code-extension-cloud) | [中文](#evermemos-vs-code-插件云端版)

将 EverMem Cloud 直接接入 VS Code：保存/搜索/概览记忆，一键侧边栏操作，命令面板亦可用。
点击以下链接可观看demo视频：
https://github.com/user-attachments/assets/c81924dd-5be1-4a26-b780-a949442fd751
## 本版变更（官方云端兼容）
- 路径按配置自动优先：默认云端 `/api/v0/...`，若 `apiBaseUrl` 带 `/api/v1` 则优先 `/api/v1/...`（仍保留 v0 兜底）。
- 仅保留官方接口集：POST/GET/DELETE `/api/{v0|v1}/memories`，GET `/api/{v0|v1}/memories/search`。
- 侧边栏新增 Auth Token 输入（自托管/旧版可用），Key/Token 都支持。
- 搜索/删除 `user_id` 自动填入，`group_id` 可选（来自工作区名），`top_k` 提升到 100 以方便读旧会话。
- 项目概览展示 `request_id`，方便配合删除/状态查询。
- 健康检查+鉴权探针：假 Key 将显示不可用，不再误报连接成功。

## 功能速览
- 侧边栏卡片式 UI：填 Key、测试连接、保存记忆、搜索/回顾、项目概览、删除记忆、日志回显。
- 选区/整文件/自定义文本入库，支持备注。
- 云端自动摘要与回顾（由 EverMemOS Cloud 处理）。
- 命令面板快捷：Add Memory / Quick Recap / Project Overview / Delete Memory / Open Sidebar。

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
3. 「搜索/快速回顾」：输入关键词（留空返回最近记忆），结果以 Markdown 打开。
4. 「项目概览」：输出当前工作区的记忆概览。
5. 「删除记忆」：按提示选择并删除。
6. 「状态/日志」：查看最近 12 条操作反馈。

## 命令面板（Command Palette）
- EverMemOS: Add Memory
- EverMemOS: Quick Recap
- EverMemOS: Project Overview
- EverMemOS: Delete Memory
- EverMemOS: Open Sidebar

## 配置项
- `evermem.apiBaseUrl`：默认 `https://api.evermind.ai`
- `evermem.apiKey`：云端 API Key，支持 `EVERMEM_API_KEY`
- `evermem.authToken`：旧版自托管 Token（有 apiKey 时可留空）

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

## What’s new (cloud-compatible)
- Path preference honors config: default to `/api/v0/...`; if `apiBaseUrl` ends with `/api/v1`, v1 paths are tried first (v0 kept as fallback).
- Only official endpoints kept: POST/GET/DELETE `/api/{v0|v1}/memories`, GET `/api/{v0|v1}/memories/search`.
- Sidebar now accepts Auth Token (self-hosted/legacy); API Key or Token both supported.
- `user_id` auto-filled; `group_id` optional (derived from workspace name); `top_k` raised to 100 to surface older sessions.
- Project Overview shows `request_id` to pair with delete/status checks.
- Health + auth probe: fake API keys will fail connection tests instead of reporting success.

## Features
- Card-style sidebar: set API, test connection, save memory, search/recap, project overview, delete, and recent logs.
- Save selection/whole file/custom text with optional note.
- Cloud-side summarization/recap handled by EverMemOS Cloud.
- Command Palette shortcuts: Add Memory / Quick Recap / Project Overview / Delete Memory / Open Sidebar.

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
3. **Search / Quick Recap**: enter keywords (blank returns recent memories); result opens as Markdown.
4. **Project Overview**: get workspace-level summary.
5. **Delete Memory**: follow prompts to remove entries.
6. **Status / Logs**: last 12 actions.

## Commands (Command Palette)
- EverMemOS: Add Memory
- EverMemOS: Quick Recap
- EverMemOS: Project Overview
- EverMemOS: Delete Memory
- EverMemOS: Open Sidebar

## Settings
- `evermem.apiBaseUrl`: default `https://api.evermind.ai`
- `evermem.apiKey`: cloud API key, supports `EVERMEM_API_KEY`
- `evermem.authToken`: legacy self-hosted token (leave empty if apiKey is set)

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
