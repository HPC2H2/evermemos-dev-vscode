import * as vscode from 'vscode';
import { ActionResult, DEFAULT_API_BASE_URL, EXTENSION_ID, configError } from './config';
import { AddMemoryOptions } from './commands';
import { record } from './api';
import { htmlLanguage, t } from './i18n';
import { escapeHtml as esc, nonce, sharedStyles } from './webview';

interface SidebarActions {
  testConnection: () => Promise<ActionResult>;
  addMemory: (payload?: AddMemoryOptions) => Promise<ActionResult>;
  quickRecap: (payload?: { query?: string }) => Promise<ActionResult>;
  projectOverview: () => Promise<ActionResult>;
  deleteMemory: () => Promise<ActionResult>;
}

export class EvermemConfigViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'evermem.configView';
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private busy = false;
  private configRevision = 0;

  constructor(private readonly actions: SidebarActions) {
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(EXTENSION_ID)) { this.configRevision++; this.sendConfig(); }
    }));
  }

  dispose(): void { this.disposables.forEach(item => item.dispose()); }
  private post(message: unknown): void { void this.view?.webview.postMessage(message); }
  private sendConfig(): void {
    const config = vscode.workspace.getConfiguration(EXTENSION_ID);
    this.post({ type: 'config', data: {
      apiBaseUrl: config.get('apiBaseUrl', DEFAULT_API_BASE_URL), apiKey: config.get('apiKey', ''), authToken: config.get('authToken', ''),
    } });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    const subscription = view.webview.onDidReceiveMessage(message => this.receive(message));
    view.onDidDispose(() => { subscription.dispose(); if (this.view === view) { this.view = undefined; } });
    view.webview.html = this.getHtml();
  }

  private async receive(message: unknown): Promise<void> {
    const msg = record(message);
    if (msg.type === 'ready') { this.sendConfig(); this.post({ type: 'busy', busy: this.busy }); return; }
    if (msg.type === 'openSettings') { await vscode.commands.executeCommand('workbench.action.openSettings', EXTENSION_ID); return; }
    if (this.busy || !['saveConfig', 'action'].includes(String(msg.type))) { return; }
    this.busy = true;
    this.post({ type: 'busy', busy: true, connecting: msg.action === 'testConnection' });
    const revision = this.configRevision;
    try {
      if (msg.type === 'saveConfig') {
        const data = record(msg.data);
        if (typeof data.apiBaseUrl !== 'string' || typeof data.apiKey !== 'string' || typeof data.authToken !== 'string') { throw new Error(t('configMissing')); }
        const values = { apiBaseUrl: data.apiBaseUrl.trim() || DEFAULT_API_BASE_URL, apiKey: data.apiKey.trim(), authToken: data.authToken.trim() };
        // Permit clearing credentials, but validate the URL before writing any setting.
        const error = configError({ ...values, apiKey: 'validation-only' });
        if (error) { throw new Error(error); }
        const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
        const workspaceConfig = Object.keys(values).some(key => cfg.inspect(key)?.workspaceValue !== undefined);
        const target = workspaceConfig ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        for (const [key, value] of Object.entries(values)) {
          if (cfg.get(key) !== value) { await cfg.update(key, value, target); }
        }
        this.sendConfig();
        this.post({ type: 'result', ok: true, message: t('configSaved') });
        return;
      }
      const payload = record(msg.payload);
      let result: ActionResult;
      switch (msg.action) {
        case 'testConnection': result = await this.actions.testConnection(); break;
        case 'addMemory':
          result = await this.actions.addMemory({ text: typeof payload.text === 'string' ? payload.text : undefined,
            note: typeof payload.note === 'string' ? payload.note : '', useSelection: payload.useSelection !== false }); break;
        case 'quickRecap': result = await this.actions.quickRecap({ query: typeof payload.query === 'string' ? payload.query : '' }); break;
        case 'projectOverview': result = await this.actions.projectOverview(); break;
        case 'deleteMemory': result = await this.actions.deleteMemory(); break;
        default: return;
      }
      this.post({ type: 'result', ...result, connection: msg.action === 'testConnection' && revision === this.configRevision });
    } catch (error) {
      this.post({ type: 'result', ok: false, message: error instanceof Error ? error.message : t('actionFailed') });
    } finally {
      this.busy = false;
      this.post({ type: 'busy', busy: false });
    }
  }

  private getHtml(): string {
    const scriptNonce = nonce();
    const labels = JSON.stringify({ statusPending: t('statusPending'), statusOk: t('statusOk'), statusFail: t('statusFail'), statusTesting: t('statusTesting'), working: t('working'), ready: t('ready'), welcome: t('welcome') }).replace(/</g, '\\u003c');
    return `<!DOCTYPE html><html lang="${esc(htmlLanguage())}"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'nonce-${scriptNonce}';">
    <style nonce="${scriptNonce}">${sharedStyles}
      body { background: var(--vscode-sideBar-background); }
      .hero { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
      .hero h2 { margin: 0; }
      .hero .hint { flex-basis: 100%; margin: 0; }
      .badge { flex-shrink: 0; white-space: nowrap; padding: 4px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 20px; font-size: .85em; }
      .badge.ok { color: var(--vscode-testing-iconPassed); }
      .badge.error { color: var(--vscode-errorForeground); }
      header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
      h3 { font-size: 1em; margin: 0; }
      label { display: block; margin: 12px 0 5px; overflow-wrap: anywhere; }
      input:not([type="checkbox"]), textarea { width: 100%; min-width: 0; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 5px; padding: 8px; font: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
      textarea { min-height: 76px; resize: vertical; }
      .checkbox { display: flex; align-items: flex-start; gap: 7px; margin: 10px 0; }
      input[type="checkbox"] { flex: 0 0 auto; width: auto; margin: 2px 0 0; padding: 0; accent-color: var(--vscode-button-background); }
      .actions > button { flex: 1 1 auto; }
      .search-row { display: flex; flex-wrap: wrap; gap: 8px; }
      .search-row input { flex: 1 1 120px; }
      .search-row button { flex: 0 0 auto; }
      #activity { margin: 0 0 8px; }
      #feed { list-style: none; padding: 0; margin: 0; }
      #feed li { padding: 7px 0; border-top: 1px solid var(--vscode-panel-border); overflow-wrap: anywhere; }
      #feed .error { color: var(--vscode-errorForeground); }
    </style></head><body>
      <section class="card hero"><h2>EverMemOS</h2><span id="connection" class="badge" role="status">${esc(t('statusPending'))}</span><p class="hint">${esc(t('heroSubtitle'))}</p></section>
      <section class="card"><header><h3>${esc(t('apiCard'))}</h3><button id="test" data-action="testConnection">${esc(t('testConnection'))}</button></header>
        <label for="apiBaseUrl">${esc(t('apiBaseLabel'))}</label><input id="apiBaseUrl" type="url" placeholder="https://api.evermind.ai">
        <label for="apiKey">${esc(t('apiKeyLabel'))}</label><input id="apiKey" type="password" autocomplete="off" placeholder="${esc(t('apiKeyPlaceholder'))}">
        <p class="hint">${esc(t('envHint'))}</p>
        <label for="authToken">${esc(t('authTokenLabel'))}</label><input id="authToken" type="password" autocomplete="off" placeholder="${esc(t('authTokenPlaceholder'))}">
        <div class="actions"><button id="save">${esc(t('saveConfig'))}</button><button id="settings" class="secondary">${esc(t('openSettings'))}</button></div>
      </section>
      <section class="card"><h3>${esc(t('quickOps'))}</h3>
        <label for="memoryText">${esc(t('memoryLabel'))}</label><textarea id="memoryText" placeholder="${esc(t('memoryPlaceholder'))}"></textarea>
        <label for="memoryNote">${esc(t('optionalNote'))}</label><textarea id="memoryNote" placeholder="${esc(t('notePlaceholder'))}"></textarea>
        <label class="checkbox" for="useSelection"><input id="useSelection" type="checkbox" checked><span>${esc(t('useSelection'))}</span></label>
        <div class="actions"><button data-action="addMemory">${esc(t('saveMemory'))}</button></div>
        <label for="query">${esc(t('searchLabel'))}</label><div class="search-row"><input id="query" type="text" placeholder="${esc(t('searchPlaceholder'))}"><button data-action="quickRecap">${esc(t('search'))}</button></div>
        <p class="hint">${esc(t('scopeHint'))}</p>
        <div class="actions"><button class="secondary" data-action="projectOverview">${esc(t('overview'))}</button><button class="secondary" data-action="deleteMemory">${esc(t('deleteMemory'))}</button></div>
      </section>
      <section class="card"><header><h3>${esc(t('logTitle'))}</h3><span class="hint">${esc(t('logHint'))}</span></header><p id="activity" class="hint" role="status">${esc(t('ready'))}</p><ul id="feed" aria-live="polite" aria-relevant="additions"></ul></section>
      <script nonce="${scriptNonce}">
        const vscode = acquireVsCodeApi();
        const strings = ${labels};
        const byId = id => document.getElementById(id);
        const connection = byId('connection');
        const setConnection = (text, state = '') => { connection.textContent = text; connection.className = 'badge ' + state; };
        const append = (text, level = '') => { const li = document.createElement('li'); li.className = level; li.textContent = new Date().toLocaleTimeString(document.documentElement.lang) + ' · ' + text; byId('feed').prepend(li); while(byId('feed').children.length > 12) byId('feed').lastChild.remove(); };
        let busy = false;
        const state = vscode.getState() || {};
        for (const id of ['memoryText', 'memoryNote', 'query']) { if(typeof state[id] === 'string') byId(id).value = state[id]; }
        if(typeof state.useSelection === 'boolean') byId('useSelection').checked = state.useSelection;
        document.addEventListener('input', () => vscode.setState({ memoryText: byId('memoryText').value, memoryNote: byId('memoryNote').value, query: byId('query').value, useSelection: byId('useSelection').checked }));
        document.addEventListener('click', event => {
          const button = event.target.closest('button');
          if(!button || busy) return;
          if(button.id === 'settings') { vscode.postMessage({type:'openSettings'}); return; }
          if(button.id === 'save') { vscode.postMessage({type:'saveConfig',data:{apiBaseUrl:byId('apiBaseUrl').value,apiKey:byId('apiKey').value,authToken:byId('authToken').value}}); return; }
          const action = button.dataset.action;
          if(action) vscode.postMessage({type:'action',action,payload:{text:byId('memoryText').value,note:byId('memoryNote').value,useSelection:byId('useSelection').checked,query:byId('query').value}});
        });
        byId('query').addEventListener('keydown', event => { if(event.key === 'Enter' && !busy) document.querySelector('[data-action="quickRecap"]').click(); });
        window.addEventListener('message', event => {
          const msg = event.data;
          if(msg.type === 'config') { for(const id of ['apiBaseUrl','apiKey','authToken']) byId(id).value = msg.data[id] || ''; setConnection(strings.statusPending); }
          if(msg.type === 'busy') { busy = msg.busy; document.querySelectorAll('button').forEach(button => button.disabled = busy); document.body.setAttribute('aria-busy', String(busy)); byId('activity').textContent = busy ? strings.working : strings.ready; if(msg.connecting) setConnection(strings.statusTesting); else if(!busy && connection.textContent === strings.statusTesting) setConnection(strings.statusPending); }
          if(msg.type === 'result') { append(msg.message || strings.ready, msg.ok || msg.cancelled ? '' : 'error'); if(msg.connection) setConnection(msg.cancelled ? strings.statusPending : msg.ok ? strings.statusOk : strings.statusFail, msg.cancelled ? '' : msg.ok ? 'ok' : 'error'); }
        });
        append(strings.welcome);
        vscode.postMessage({type:'ready'});
      </script></body></html>`;
  }
}
