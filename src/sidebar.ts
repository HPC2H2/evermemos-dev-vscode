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
    const locale = (vscode.env.language || 'en').toLowerCase();
    const isZh = locale.startsWith('zh');
    const text = this.getStrings(isZh);

    webviewView.webview.html = this.getHtml(webviewView.webview, initial, text);

    webviewView.webview.onDidReceiveMessage(async (msg: SidebarActionPayload | any) => {
      if (!msg?.type) {
        return;
      }

      if (msg.type === 'saveConfig') {
        const payload = msg.data || {};
        const cfg = vscode.workspace.getConfiguration('evermem');
        await cfg.update('apiBaseUrl', payload.apiBaseUrl || DEFAULT_API_BASE_URL, true);
        await cfg.update('apiKey', payload.apiKey || '', true);
        vscode.window.showInformationMessage(text.toastConfigSaved);
        this.postMessage({ type: 'toast', level: 'success', message: text.toastConfigSaved });
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
            vscode.window.showInformationMessage(ok ? text.connectionOk : text.connectionFail);
            return;
          }
          if (action === 'addMemory') {
            const res = await this.actions.addMemory({
              text: msg.payload?.text,
              note: msg.payload?.note,
              useSelection: msg.payload?.useSelection !== false,
            });
            this.postMessage({ type: 'actionResult', action, ok: !!res?.ok, message: res?.message || text.addMemoryDone });
            return;
          }
          if (action === 'quickRecap') {
            const res = await this.actions.quickRecap({ query: msg.payload?.query, openDocument: true });
            this.postMessage({ type: 'actionResult', action, ok: !!res?.ok, message: res?.message || text.quickRecapDone });
            return;
          }
          if (action === 'projectOverview') {
            const res = await this.actions.projectOverview({ openDocument: true });
            this.postMessage({ type: 'actionResult', action, ok: !!res?.ok, message: res?.message || text.overviewDone });
            return;
          }
          if (action === 'deleteMemory') {
            const res = await this.actions.deleteMemory();
            this.postMessage({ type: 'actionResult', action, ok: !!res?.ok, message: res?.message || text.deleteDone });
            return;
          }
        } catch (error) {
          vscode.window.showErrorMessage(`${EXTENSION_NAME}: ${action} failed`);
          this.postMessage({ type: 'actionResult', action, ok: false, message: (error as Error)?.message || text.actionFailed });
        }
      }
    });
  }

  private getStrings(isZh: boolean) {
    if (isZh) {
      return {
        lang: 'zh-CN',
        heroSubtitle: '云端记忆捕获 · 快捷搜索 · 项目概览',
        statusPending: '待检测',
        statusOk: '已连接',
        statusFail: '未连接',
        apiCard: 'Cloud API',
        testConnection: '测试连接',
        apiBaseLabel: 'API Base URL',
        apiKeyLabel: 'API Key（console.evermind.ai 获取，例如 46b7d3f9-199a-4665-ad1c-6495e1945fd7）',
        apiKeyPlaceholder: '粘贴你的 EverMem API Key',
        save: '保存',
        openSettings: '打开设置',
        envHint: '支持环境变量 EVERMEM_API_KEY，默认指向云端 https://api.evermind.ai',
        quickOps: '快速操作',
        quickOpsHint: '使用选区或自定义文本',
        memoryLabel: '添加记忆（留空则使用当前文件/选区）',
        memoryPlaceholder: '可选：直接在此粘贴要保存的内容',
        noteLabel: '可选备注',
        notePlaceholder: '例如：这段代码初始化了配置',
        useSelection: '优先使用当前选区/文件',
        saveMemory: '保存记忆',
        searchLabel: '搜索 / 快速回顾',
        searchPlaceholder: '输入关键词，留空查看最近记忆',
        search: '搜索',
        overview: '项目概览',
        delete: '删除记忆',
        logTitle: '状态 / 日志',
        logHint: '最近 12 条',
        welcome: '欢迎使用 EverMemOS Cloud',
        toastConfigSaved: '配置已保存',
        connectionOk: `${EXTENSION_NAME}: Cloud API 可用`,
        connectionFail: `${EXTENSION_NAME}: 无法连接 Cloud API`,
        addMemoryDone: '记忆已提交',
        quickRecapDone: '已完成搜索/回顾',
        overviewDone: '项目概览已生成',
        deleteDone: '删除流程完成',
        actionFailed: '操作失败',
        toastDefault: '完成',
        heroEyebrow: 'EverMem Cloud',
        heroTitle: 'EverMemOS',
      };
    }
    return {
      lang: 'en',
      heroSubtitle: 'Cloud memory capture · Quick search · Project overview',
      statusPending: 'Pending',
      statusOk: 'Connected',
      statusFail: 'Offline',
      apiCard: 'Cloud API',
      testConnection: 'Test Connection',
      apiBaseLabel: 'API Base URL',
      apiKeyLabel: 'API Key (from console.evermind.ai, e.g. 46b7d3f9-199a-4665-ad1c-6495e1945fd7)',
      apiKeyPlaceholder: 'Paste your EverMem API Key',
      save: 'Save',
      openSettings: 'Open Settings',
      envHint: 'Env var EVERMEM_API_KEY is supported; default points to https://api.evermind.ai',
      quickOps: 'Quick Actions',
      quickOpsHint: 'Use selection or custom text',
      memoryLabel: 'Save memory (blank uses current file/selection)',
      memoryPlaceholder: 'Optional: paste content to store',
      noteLabel: 'Optional note',
      notePlaceholder: 'e.g., This code initializes config',
      useSelection: 'Prefer current selection/file',
      saveMemory: 'Save Memory',
      searchLabel: 'Search / Quick Recap',
      searchPlaceholder: 'Keyword (blank shows recent memories)',
      search: 'Search',
      overview: 'Project Overview',
      delete: 'Delete Memory',
      logTitle: 'Status / Logs',
      logHint: 'Latest 12',
      welcome: 'Welcome to EverMemOS Cloud',
      toastConfigSaved: 'Config saved',
      connectionOk: `${EXTENSION_NAME}: Cloud API reachable`,
      connectionFail: `${EXTENSION_NAME}: Cannot reach Cloud API`,
      addMemoryDone: 'Memory submitted',
      quickRecapDone: 'Search/recap completed',
      overviewDone: 'Project overview generated',
      deleteDone: 'Delete flow finished',
      actionFailed: 'Action failed',
      toastDefault: 'Done',
      heroEyebrow: 'EverMem Cloud',
      heroTitle: 'EverMemOS',
    };
  }

  private getHtml(webview: vscode.Webview, initial: Record<string, string>, text: ReturnType<typeof this.getStrings>): string {
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
      const t = ${JSON.stringify(text)};
      const setConn = (ok, textOverride) => { conn.textContent = ok ? (textOverride || t.statusOk) : (textOverride || t.statusFail); conn.className = 'badge ' + (ok ? 'ok' : 'fail'); };
      const push = (level, message) => { const li = document.createElement('li'); li.className = level === 'error' ? 'err' : 'ok'; const ts = new Date().toLocaleTimeString(); li.textContent = '[' + ts + '] ' + message; feed.prepend(li); while (feed.children.length > 12) { feed.removeChild(feed.lastChild); } };

      // init text values
      qs('heroSubtitle').textContent = t.heroSubtitle;
      conn.textContent = t.statusPending;
      qs('apiCardTitle').textContent = t.apiCard;
      qs('testBtn').textContent = t.testConnection;
      qs('apiBaseLabel').textContent = t.apiBaseLabel;
      qs('apiKeyLabel').textContent = t.apiKeyLabel;
      qs('apiKey').placeholder = t.apiKeyPlaceholder;
      qs('saveBtn').textContent = t.save;
      qs('openSettings').textContent = t.openSettings;
      qs('envHint').textContent = t.envHint;
      qs('quickOpsTitle').textContent = t.quickOps;
      qs('quickOpsHint').textContent = t.quickOpsHint;
      qs('memoryLabel').textContent = t.memoryLabel;
      qs('memoryText').placeholder = t.memoryPlaceholder;
      qs('noteLabel').textContent = t.noteLabel;
      qs('memoryNote').placeholder = t.notePlaceholder;
      qs('useSelectionLabel').lastChild.textContent = ' ' + t.useSelection;
      qs('addMemoryBtn').textContent = t.saveMemory;
      qs('searchLabel').textContent = t.searchLabel;
      qs('searchQuery').placeholder = t.searchPlaceholder;
      qs('quickRecapBtn').textContent = t.search;
      qs('overviewBtn').textContent = t.overview;
      qs('deleteBtn').textContent = t.delete;
      qs('logTitle').textContent = t.logTitle;
      qs('logHint').textContent = t.logHint;

      const initialBase = '${initial.apiBaseUrl.replace(/'/g, "&#39;")}';
      qs('apiBaseUrl').value = initialBase;
      qs('apiKey').value = '${(initial.apiKey || '').replace(/'/g, "&#39;")}';
      push('info', t.welcome);

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
        if (msg?.type === 'connection') { setConn(!!msg.ok); push(msg.ok ? 'success' : 'error', msg.ok ? t.connectionOk : t.connectionFail); }
        if (msg?.type === 'actionResult') { push(msg.ok ? 'success' : 'error', msg.message || t.toastDefault); }
        if (msg?.type === 'toast') { push(msg.level === 'error' ? 'error' : 'success', msg.message || t.toastDefault); }
      });
    `;

    return `<!DOCTYPE html>
<html lang="${text.lang}">
<head>
  <meta charset="UTF-8">
  <style>${style}</style>
</head>
<body>
  <div class="hero">
    <div>
      <div class="eyebrow">${text.heroEyebrow}</div>
      <h2>${text.heroTitle}</h2>
      <div id="heroSubtitle" class="hint">${text.heroSubtitle}</div>
    </div>
    <div id="conn" class="badge fail">${text.statusPending}</div>
  </div>

  <div class="grid">
    <section class="card">
      <header><span id="apiCardTitle">${text.apiCard}</span><button class="ghost" id="testBtn">${text.testConnection}</button></header>
      <label id="apiBaseLabel" for="apiBaseUrl">${text.apiBaseLabel}</label>
      <input id="apiBaseUrl" type="text" placeholder="https://api.evermind.ai" />
      <label id="apiKeyLabel" for="apiKey">${text.apiKeyLabel}</label>
      <div class="row">
        <input id="apiKey" type="password" placeholder="${text.apiKeyPlaceholder}" />
        <button id="saveBtn">${text.save}</button>
      </div>
      <div class="row" style="margin-top:6px; justify-content: space-between;">
        <button class="secondary" id="openSettings">${text.openSettings}</button>
      </div>
      <p id="envHint" class="hint">${text.envHint}</p>
    </section>

    <section class="card">
      <header><span id="quickOpsTitle">${text.quickOps}</span><span id="quickOpsHint" class="hint">${text.quickOpsHint}</span></header>
      <label id="memoryLabel" for="memoryText">${text.memoryLabel}</label>
      <textarea id="memoryText" placeholder="${text.memoryPlaceholder}"></textarea>
      <label id="noteLabel" for="memoryNote">${text.noteLabel}</label>
      <textarea id="memoryNote" placeholder="${text.notePlaceholder}"></textarea>
      <div class="row" style="margin-top:6px; justify-content: space-between;">
        <label id="useSelectionLabel" class="inline"><input id="useSelection" type="checkbox" checked /> ${text.useSelection}</label>
        <button id="addMemoryBtn">${text.saveMemory}</button>
      </div>
      <label id="searchLabel" for="searchQuery" style="margin-top:10px;">${text.searchLabel}</label>
      <div class="row">
        <input id="searchQuery" type="text" placeholder="${text.searchPlaceholder}" />
        <button id="quickRecapBtn">${text.search}</button>
      </div>
      <div class="row" style="margin-top:8px; justify-content: flex-end; gap:8px;">
        <button class="secondary" id="overviewBtn">${text.overview}</button>
        <button class="secondary" id="deleteBtn">${text.delete}</button>
      </div>
    </section>

    <section class="card">
      <header><span id="logTitle">${text.logTitle}</span><span id="logHint" class="hint">${text.logHint}</span></header>
      <ul id="feed"></ul>
    </section>
  </div>

  <script>${script}</script>
</body>
</html>`;
  }
}
