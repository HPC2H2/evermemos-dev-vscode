import * as vscode from 'vscode';
import {
  DEFAULT_API_BASE_URL,
  EXTENSION_ID,
  EXTENSION_NAME,
  SidebarActionPayload,
} from './config';

interface SidebarActions {
  testConnection: () => Promise<boolean>;
  addMemory: (payload?: { text?: string; note?: string; useSelection?: boolean }) => Promise<any>;
  quickRecap: (payload?: { query?: string; openDocument?: boolean }) => Promise<any>;
  projectOverview: (payload?: { openDocument?: boolean }) => Promise<any>;
  deleteMemory: () => Promise<any>;
}

export class EvermemConfigViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'evermem.configView';
  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext, private readonly actions: SidebarActions) {}

  public postMessage(message: any) {
    this.view?.webview.postMessage(message);
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };

    const config = vscode.workspace.getConfiguration('evermem');
    const initial = {
      apiBaseUrl: config.get<string>('apiBaseUrl') || DEFAULT_API_BASE_URL,
      apiKey: config.get<string>('apiKey') || '',
      workspace: vscode.workspace.name || 'Workspace',
    };

    webviewView.webview.html = this.getHtml(webviewView.webview, initial);

    webviewView.webview.onDidReceiveMessage(async (msg: SidebarActionPayload | any) => {
      if (!msg?.type) {
        return;
      }

      if (msg.type === 'saveConfig') {
        const payload = msg.data || {};
        const cfg = vscode.workspace.getConfiguration('evermem');
        await cfg.update('apiBaseUrl', payload.apiBaseUrl || DEFAULT_API_BASE_URL, true);
        await cfg.update('apiKey', payload.apiKey || '', true);
        vscode.window.showInformationMessage('EverMemOS 配置已保存');
        this.postMessage({ type: 'toast', level: 'success', message: '配置已保存' });
        return;
      }

      if (msg.type === 'openSettings') {
        vscode.commands.executeCommand('workbench.action.openSettings', EXTENSION_ID);
        return;
      }

      if (msg.type === 'action') {
        const action = msg.action as SidebarActionPayload['type'];
        try {
          if (action === 'testConnection') {
            const ok = await this.actions.testConnection();
            this.postMessage({ type: 'connection', ok });
            vscode.window.showInformationMessage(
              ok ? `${EXTENSION_NAME}: Cloud API 可用` : `${EXTENSION_NAME}: 无法连接 Cloud API`
            );
            return;
          }
          if (action === 'addMemory') {
            const res = await this.actions.addMemory({
              text: msg.payload?.text,
              note: msg.payload?.note,
              useSelection: msg.payload?.useSelection !== false,
            });
            this.postMessage({ type: 'actionResult', action, ok: !!res?.ok, message: res?.message || '记忆已提交' });
            return;
          }
          if (action === 'quickRecap') {
            const res = await this.actions.quickRecap({ query: msg.payload?.query, openDocument: true });
            this.postMessage({ type: 'actionResult', action, ok: !!res?.ok, message: res?.message || '已完成搜索/回顾' });
            return;
          }
          if (action === 'projectOverview') {
            const res = await this.actions.projectOverview({ openDocument: true });
            this.postMessage({ type: 'actionResult', action, ok: !!res?.ok, message: res?.message || '项目概览已生成' });
            return;
          }
          if (action === 'deleteMemory') {
            const res = await this.actions.deleteMemory();
            this.postMessage({ type: 'actionResult', action, ok: !!res?.ok, message: res?.message || '删除流程完成' });
            return;
          }
        } catch (error) {
          vscode.window.showErrorMessage(`${EXTENSION_NAME}: ${action} failed`);
          this.postMessage({ type: 'actionResult', action, ok: false, message: (error as Error)?.message || '操作失败' });
        }
      }
    });
  }

  private getHtml(webview: vscode.Webview, initial: Record<string, string>): string {
    const style = `
      :root { color-scheme: light dark; }
      body { font-family: var(--vscode-font-family); padding: 14px; background: var(--vscode-sideBar-background); color: var(--vscode-foreground); }
      .hero { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; border: 1px solid var(--vscode-panel-border); border-radius: 10px; background: linear-gradient(135deg, var(--vscode-editor-background), var(--vscode-editor-background)); margin-bottom: 12px; }
      .eyebrow { color: var(--vscode-descriptionForeground); text-transform: uppercase; font-size: 11px; letter-spacing: 0.08em; }
      h2 { margin: 2px 0 6px; }
      .badge { padding: 4px 8px; border-radius: 100px; border: 1px solid var(--vscode-editorWidget-border); font-size: 12px; }
      .badge.ok { background: rgba(76, 175, 80, 0.15); color: #64dd17; border-color: rgba(76, 175, 80, 0.25); }
      .badge.fail { background: rgba(244, 67, 54, 0.15); color: #ff867c; border-color: rgba(244, 67, 54, 0.25); }
      .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
      .card { border: 1px solid var(--vscode-editorWidget-border); border-radius: 10px; padding: 12px; background: var(--vscode-editor-background); box-shadow: 0 6px 16px rgba(0,0,0,0.08); }
      .card header { display: flex; align-items: center; justify-content: space-between; font-weight: 600; margin-bottom: 6px; }
      label { display: block; font-weight: 600; margin: 8px 0 4px; }
      input, textarea { width: 100%; padding: 8px; box-sizing: border-box; border-radius: 8px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-foreground); }
      textarea { min-height: 70px; resize: vertical; }
      button { cursor: pointer; border-radius: 8px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 8px 10px; }
      button.secondary { background: transparent; border-color: var(--vscode-input-border); color: var(--vscode-foreground); }
      button.ghost { background: transparent; border-color: transparent; color: var(--vscode-foreground); }
      .row { display: flex; gap: 8px; align-items: center; }
      .row input[type="text"], .row input[type="password"] { flex: 1; }
      .hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
      ul#feed { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
      ul#feed li { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--vscode-editorWidget-border); background: var(--vscode-editor-background); font-size: 12px; }
      ul#feed li.ok { border-color: rgba(76, 175, 80, 0.35); }
      ul#feed li.err { border-color: rgba(244, 67, 54, 0.35); }
    `;

    const script = `
      const vscodeApi = acquireVsCodeApi();
      const qs = (id) => document.getElementById(id);
      const feed = qs('feed');
      const conn = qs('conn');
      const setConn = (ok, text) => { conn.textContent = ok ? (text || '已连接') : (text || '未连接'); conn.className = 'badge ' + (ok ? 'ok' : 'fail'); };
      const push = (level, message) => { const li = document.createElement('li'); li.className = level === 'error' ? 'err' : 'ok'; const ts = new Date().toLocaleTimeString(); li.textContent = '[' + ts + '] ' + message; feed.prepend(li); while (feed.children.length > 12) { feed.removeChild(feed.lastChild); } };

      const initialBase = '${initial.apiBaseUrl.replace(/'/g, "&#39;")}';
      qs('apiBaseUrl').value = initialBase;
      qs('apiKey').value = '${(initial.apiKey || '').replace(/'/g, "&#39;")}';
      push('info', '欢迎使用 EverMemOS Cloud');

      qs('saveBtn').addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'saveConfig', data: { apiBaseUrl: qs('apiBaseUrl').value.trim(), apiKey: qs('apiKey').value.trim() } });
      });
      qs('openSettings').addEventListener('click', () => { vscodeApi.postMessage({ type: 'openSettings' }); });
      qs('testBtn').addEventListener('click', () => { vscodeApi.postMessage({ type: 'action', action: 'testConnection' }); });
      qs('addMemoryBtn').addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'action', action: 'addMemory', payload: { text: qs('memoryText').value.trim(), note: qs('memoryNote').value.trim(), useSelection: qs('useSelection').checked } });
      });
      qs('quickRecapBtn').addEventListener('click', () => { vscodeApi.postMessage({ type: 'action', action: 'quickRecap', payload: { query: qs('searchQuery').value.trim() } }); });
      qs('overviewBtn').addEventListener('click', () => { vscodeApi.postMessage({ type: 'action', action: 'projectOverview' }); });
      qs('deleteBtn').addEventListener('click', () => { vscodeApi.postMessage({ type: 'action', action: 'deleteMemory' }); });

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg?.type === 'connection') { setConn(!!msg.ok, msg.ok ? '已连接' : '未连接'); push(msg.ok ? 'success' : 'error', msg.ok ? 'Cloud API 可用' : 'Cloud API 不可用'); }
        if (msg?.type === 'actionResult') { push(msg.ok ? 'success' : 'error', msg.message || '完成'); }
        if (msg?.type === 'toast') { push(msg.level === 'error' ? 'error' : 'success', msg.message || '完成'); }
      });
    `;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>${style}</style>
</head>
<body>
  <div class="hero">
    <div>
      <div class="eyebrow">EverMem Cloud</div>
      <h2>EverMemOS</h2>
      <div class="hint">云端记忆捕获 · 快捷搜索 · 项目概览</div>
    </div>
    <div id="conn" class="badge fail">待检测</div>
  </div>

  <div class="grid">
    <section class="card">
      <header><span>Cloud API</span><button class="ghost" id="testBtn">测试连接</button></header>
      <label for="apiBaseUrl">API Base URL</label>
      <input id="apiBaseUrl" type="text" placeholder="https://api.evermind.ai" />
      <label for="apiKey">API Key（console.evermind.ai 获取，例如 111111f9-199a-4665-ad1c-111111111111）</label>
      <div class="row">
        <input id="apiKey" type="password" placeholder="粘贴你的 EverMem API Key" />
        <button id="saveBtn">保存</button>
      </div>
      <div class="row" style="margin-top:6px; justify-content: space-between;">
        <button class="secondary" id="openSettings">打开设置</button>
      </div>
      <p class="hint">支持环境变量 EVERMEM_API_KEY，默认指向云端 https://api.evermind.ai</p>
    </section>

    <section class="card">
      <header><span>快速操作</span><span class="hint">使用选区或自定义文本</span></header>
      <label for="memoryText">添加记忆（留空则使用当前文件/选区）</label>
      <textarea id="memoryText" placeholder="可选：直接在此粘贴要保存的内容"></textarea>
      <label for="memoryNote">可选备注</label>
      <textarea id="memoryNote" placeholder="例如：这段代码初始化了配置"></textarea>
      <div class="row" style="margin-top:6px; justify-content: space-between;">
        <label class="inline"><input id="useSelection" type="checkbox" checked /> 优先使用当前选区/文件</label>
        <button id="addMemoryBtn">保存记忆</button>
      </div>
      <label for="searchQuery" style="margin-top:10px;">搜索 / 快速回顾</label>
      <div class="row">
        <input id="searchQuery" type="text" placeholder="输入关键词，留空查看最近记忆" />
        <button id="quickRecapBtn">搜索</button>
      </div>
      <div class="row" style="margin-top:8px; justify-content: flex-end; gap:8px;">
        <button class="secondary" id="overviewBtn">项目概览</button>
        <button class="secondary" id="deleteBtn">删除记忆</button>
      </div>
    </section>

    <section class="card">
      <header><span>状态 / 日志</span><span class="hint">最近 12 条</span></header>
      <ul id="feed"></ul>
    </section>
  </div>

  <script>${script}</script>
</body>
</html>`;
  }
}
