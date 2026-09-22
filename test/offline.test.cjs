// Real handlers and HTTP requests; VS Code UI APIs are replaced only for deterministic assertions.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const catalogs = Object.fromEntries(['zh-cn', 'zh-tw'].map(locale => [locale, JSON.parse(fs.readFileSync(path.join(root, `l10n/bundle.l10n.${locale}.json`), 'utf8'))]));
const snippet = '  export const greeting = "Hello\\nEverMem\\t!";\n';
const fixture = [{ id: 'memory-1', event_id: 'event-1', summary: 'Login snippet', content: snippet, metadata: { mem_cell: { codeSnippet: snippet, language: 'typescript', filePath: path.join(root, 'sample.ts'), startLine: 2 } } }];
const disposable = { dispose() {} };
function event() { const listeners = new Set(); return { subscribe(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; }, fire(value) { for (const fn of listeners) fn(value); } }; }
class CancellationError extends Error { constructor() { super('Cancelled'); } }
class Uri { constructor(file) { this.fsPath = file; this.scheme = 'file'; } toString() { return pathToFileURL(this.fsPath).href; } static file(file) { return new Uri(file); } }
let settings, requests, mode, panels, documents, notices, picks, editor, cancellation, configChanged, configWrites, reads, base, progressCancelled, activeResponse;
const vscode = {
  env: { language: 'en', machineId: 'test-user' },
  l10n: { t(message, ...args) { return (catalogs[vscode.env.language]?.[message] || message).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)])); } },
  CancellationError, Uri, ConfigurationTarget: { Global: 1, Workspace: 2 }, ProgressLocation: { Notification: 15 }, ViewColumn: { One: 1, Beside: -2 }, TextEditorRevealType: { InCenter: 1 },
  Position: class { constructor(line, character) { Object.assign(this, { line, character }); } }, Range: class {}, Selection: class {},
  languages: { getLanguages: async () => ['typescript', 'plaintext'] },
  commands: { executeCommand: async () => undefined },
  workspace: {
    name: 'project', workspaceFolders: [{ uri: new Uri(root) }], get textDocuments() { return documents; },
    getWorkspaceFolder: () => ({ uri: new Uri(root) }),
    onDidChangeConfiguration(fn) { return configChanged.subscribe(fn); },
    getConfiguration() { return { get(key, fallback) { return settings[key] ?? fallback; }, inspect(key) { return { workspaceValue: settings[key] }; }, async update(key, value, target) { settings[key] = value; configWrites.push({ key, value, target }); configChanged.fire({ affectsConfiguration: () => true }); } }; },
    async openTextDocument(options) {
      const doc = { uri: options instanceof Uri ? options : new Uri(`/tmp/evermem-test-${documents.length}`), version: 1, lineCount: 4, getText: () => options.content || '', languageId: options.language, positionAt: offset => offset };
      documents.push(doc); return doc;
    },
  },
  window: {
    get activeTextEditor() { return editor; }, get visibleTextEditors() { return editor ? [editor] : []; },
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    async showErrorMessage(message) { notices.push({ level: 'error', message }); },
    async showWarningMessage(message, ...args) { notices.push({ level: 'warning', message }); return args.find(a => a === vscode.l10n.t('Delete')); },
    async showInformationMessage(message) { notices.push({ level: 'info', message }); },
    async showInputBox() { return picks.shift(); },
    async showQuickPick(items) { const choice = picks.shift(); return choice === 'first' ? items[0] : items.find(item => item.value === choice || choice === 'more' && item.more); },
    async withProgress(_options, fn) { return fn({ report() {} }, { get isCancellationRequested() { return progressCancelled; }, onCancellationRequested: fn => cancellation.subscribe(fn) }); },
    createWebviewPanel() {
      const disposed = event(); const p = { viewColumn: 2, reveals: 0, webview: { html: '', onDidReceiveMessage(fn) { p.receive = fn; return disposable; } }, reveal() { p.reveals++; }, dispose() { disposed.fire(); }, onDidDispose: fn => disposed.subscribe(fn) }; panels.push(p); return p;
    },
    async showTextDocument(doc) { return { document: doc, revealRange() {} }; },
  },
};
const load = Module._load;
Module._load = function(id, ...args) { return id === 'vscode' ? vscode : load.call(this, id, ...args); };
const config = require('../out/config');
const api = require('../out/api');
const commands = require('../out/commands');
const results = require('../out/results');
const i18n = require('../out/i18n');
const { EvermemConfigViewProvider } = require('../out/sidebar');
Module._load = load;
let server;
before(async () => {
  server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://localhost');
    const payload = req.method === 'GET' ? Object.fromEntries(url.searchParams) : raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method, path: url.pathname, payload });
    let status = 200, data;
    if (mode === 'slow') { activeResponse = res; setTimeout(() => cancellation.fire(), 10); return; }
    if (mode === 'disconnect') { req.socket.destroy(); return; }
    if (mode === '401' || mode === '500') { status = Number(mode); data = { error: 'server error' }; }
    else if (mode === 'fallback' && url.pathname.includes('/v0/')) { status = 404; data = {}; }
    else if (mode === 'postSearch' && req.method === 'GET') { status = 405; data = {}; }
    else if (mode === 'unsupported') { status = 404; data = {}; }
    else if (mode === 'failedJob') { data = { success: true, data: { status: 'failed' } }; }
    else if (mode === 'rejected') { data = { success: false }; }
    else if (req.method === 'POST' && !url.pathname.endsWith('/search')) { data = { request_id: 'test-request', result: { count: 1 } }; }
    else if (req.method === 'DELETE') { data = { success: true, data: { deleted: 1 } }; }
    else { data = { result: { memories: mode === 'empty' ? [] : fixture, total_count: 1, has_more: mode === 'pages' && payload.page === '1' } }; }
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { results.disposeResults(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  results.disposeResults(); api.clearApiRouteCache();
  settings = { apiBaseUrl: base, apiKey: 'local-test-only', authToken: '' }; process.env.EVERMEM_API_KEY = '';
  requests = []; panels = []; documents = []; notices = []; picks = []; configWrites = []; reads = 0;
  mode = 'normal'; progressCancelled = false; cancellation = event(); configChanged = event(); vscode.env.language = 'en';
  editor = { document: { uri: new Uri(path.join(root, 'sample.ts')), languageId: 'typescript', lineCount: 2, getText() { reads++; return snippet; } }, selection: { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 1, character: 0 }, active: { line: 0, character: 0 } }, async edit(fn) { fn({ insert(_position, text) { documents.push({ getText: () => text }); } }); return true; } };
});

test('missing key blocks saving without HTTP', async () => {
  settings.apiKey = ''; assert.equal((await commands.handleAddMemory({ text: 'text', note: '' })).ok, false); assert.equal(requests.length, 0); assert.match(notices[0].message, /Missing API key/);
});
test('connection probe uses a single authenticated request; no health preflight', async () => {
  assert.equal(await config.testConnection(config.getConfig()), true); assert.equal(requests.length, 1); assert.equal(requests[0].path, '/api/v0/memories');
});
test('saving captures exact code and range without preflight HTTP', async () => {
  assert.equal((await commands.handleAddMemory({ note: '' })).ok, true); assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST'); const p = requests[0].payload; assert.equal(p.content, snippet); assert.equal(p.metadata.mem_cell.codeSnippet, snippet); assert.equal(p.metadata.mem_cell.startLine, 0);
});
test('disabled capture never reads the editor or adds file metadata', async () => {
  const r = await commands.handleAddMemory({ text: 'custom', note: '', useSelection: false }); assert.equal(r.ok, true); assert.equal(reads, 0); assert.equal(requests[0].payload.metadata.mem_cell, undefined);
});
test('explicit text wins even with the capture checkbox enabled', async () => {
  await commands.handleAddMemory({ text: 'custom', note: '', useSelection: true }); assert.equal(reads, 0); assert.equal(requests[0].payload.metadata.mem_cell, undefined);
});
test('disabled capture stays disabled after prompting for missing text', async () => {
  picks = ['typed later']; await commands.handleAddMemory({ useSelection: false, note: '' }); assert.equal(reads, 0); assert.equal(requests[0].payload.content, 'typed later');
});
test('custom text without editor does not show an editor warning', async () => {
  editor = undefined; assert.equal((await commands.handleAddMemory({ text: 'custom', note: '' })).ok, true); assert.equal(notices.some(n => n.level === 'warning'), false);
});
test('cancelling the note prompt does not submit', async () => {
  picks = [undefined]; assert.equal((await commands.handleAddMemory({ text: 'custom' })).cancelled, true); assert.equal(requests.length, 0);
});
test('empty search result preserves all scope filters and sends one request', async () => {
  mode = 'empty'; const r = await commands.handleQuickRecap({ query: 'login' }); assert.equal(r.ok, true); assert.equal(requests.length, 1); assert.equal(requests[0].payload.group_id, 'vscode-project'); assert.equal(requests[0].payload.user_id, 'test-user'); assert.match(panels[0].webview.html, /No memories found/);
});
test('blank query lists recent memories instead of calling search', async () => {
  await commands.handleQuickRecap({ query: '' }); assert.equal(requests[0].path, '/api/v0/memories'); assert.equal(requests[0].payload.group_id, 'vscode-project');
});
test('404 fallback is cached for the next search', async () => {
  mode = 'fallback'; const client = new api.MemoryApi(config.getConfig()); await client.search('one'); requests = []; await client.search('two'); assert.equal(requests.length, 1); assert.equal(requests[0].path, '/api/v1/memories/search');
});
test('405 can use POST search without dropping keyword or scope', async () => {
  mode = 'postSearch'; await new api.MemoryApi(config.getConfig()).search('login'); assert.equal(requests.length, 2); assert.equal(requests[1].method, 'POST'); assert.equal(requests[1].payload.query, 'login'); assert.equal(requests[1].payload.user_id, 'test-user');
});
for (const status of ['401', '500']) test(`${status} fails immediately instead of probing other routes`, async () => {
  mode = status; assert.equal((await commands.handleQuickRecap({ query: 'login' })).ok, false); assert.equal(requests.length, 1);
});
test('unsupported keyword search never silently returns an unfiltered list', async () => {
  mode = 'unsupported'; const r = await commands.handleQuickRecap({ query: 'login' }); assert.equal(r.ok, false); assert.ok(requests.every(r => r.path.endsWith('/search'))); assert.match(r.message, /not supported/);
});
test('a dropped write response is not automatically replayed', async () => {
  mode = 'disconnect'; const r = await commands.handleAddMemory({ text: 'custom', note: '' }); assert.equal(r.ok, false); assert.equal(requests.length, 1);
});
test('business rejection does not display save success', async () => {
  mode = 'rejected'; const r = await commands.handleAddMemory({ text: 'custom', note: '' }); assert.equal(r.ok, false); assert.equal(notices.some(n => n.level === 'info'), false);
});
test('both nested result envelopes and grouped memories are normalized', () => {
  const page = api.normalizeMemories({ success: true, data: { result: { memories: [{ episodic_memory: fixture }], total_count: 8 } } }); assert.equal(page.memories.length, 1); assert.equal(page.total, 8);
});
test('cancelled search and overview do not send requests or return success', async () => {
  progressCancelled = true;
  assert.equal((await commands.handleQuickRecap({ query: 'test' })).cancelled, true);
  assert.equal((await commands.handleProjectOverview()).cancelled, true);
  assert.equal(requests.length, 0); assert.equal(panels.length, 0);
});
test('cancelling in-flight HTTP stops the handler promptly', async () => {
  mode = 'slow'; const start = performance.now(); const r = await commands.handleQuickRecap({ query: 'slow' }); assert.equal(r.cancelled, true); assert.ok(performance.now() - start < 1000); assert.equal(panels.length, 0); activeResponse.destroy();
});
test('cancelling retry backoff skips subsequent attempts', async () => {
  const controller = new AbortController(); let calls = 0;
  const promise = config.requestWithRetry(async () => { calls++; throw Object.assign(new Error('network'), { code: 'ECONNREFUSED' }); }, 2, 1000, controller.signal);
  setTimeout(() => controller.abort(), 10); await assert.rejects(promise, CancellationError); assert.equal(calls, 1);
});
test('search reuses its panel and rejects stale/malformed messages', async () => {
  await commands.handleQuickRecap({ query: 'one' }); const oldRevision = Number(panels[0].webview.html.match(/revision: (\d+)/)[1]);
  await commands.handleQuickRecap({ query: 'two' }); assert.equal(panels.length, 1); assert.equal(panels[0].reveals, 2);
  await panels[0].receive({ type: 'insert', index: 0, revision: oldRevision }); await panels[0].receive({ type: 'insert', code: 'untrusted', index: -1, revision: oldRevision + 1 }); assert.equal(documents.length, 0);
});
test('inserting uses the stored original snippet, ignoring message-supplied code', async () => {
  await commands.handleQuickRecap({ query: 'one' }); const revision = Number(panels[0].webview.html.match(/revision: (\d+)/)[1]);
  await panels[0].receive({ type: 'insert', index: 0, revision, code: 'untrusted' }); assert.equal(documents.at(-1).getText(), snippet);
});
test('no-editor insertion creates a document and preserves escapes and whitespace', async () => {
  editor = undefined; await results.insertSnippet(snippet, 'typescript'); assert.equal(documents[0].getText(), snippet);
});
test('failed editor edit does not report success', async () => {
  editor.edit = async () => false; await assert.rejects(results.insertSnippet(snippet, 'typescript'), /read-only/); assert.equal(notices.length, 0);
});
test('HTML source is escaped, nonce CSP is strict, and highlighting is local', () => {
  const html = results.renderResults(results.toSearchItems([{ content: '</script><script>globalThis.pwned = true</script>', metadata: { mem_cell: { language: 'html' } } }]), 1);
  assert.equal(html.includes('</script><script>'), false); assert.equal((html.match(/<script /g) || []).length, 1); assert.equal(html.includes('unsafe-inline'), false); assert.equal(html.includes('unsafe-eval'), false); assert.match(html, /hljs-/); assert.doesNotMatch(html, /onclick=|<script src=/);
});
test('preview limits do not truncate the snippet used for insertion', () => {
  const code = 'x'.repeat(21000); const item = results.toSearchItems([{ content: code }]); assert.equal(item[0].code.length, 21000); const html = results.renderResults(item, 1); assert.match(html, /Preview shortened/); assert.ok(html.length < 26000);
});
test('deleting uses the same ID shown to the user and retains scope', async () => {
  picks = ['recent', 'first']; const r = await commands.handleDeleteMemory(); assert.equal(r.ok, true); const req = requests.find(r => r.method === 'DELETE'); assert.equal(req.payload.event_id, 'event-1'); assert.equal(req.payload.user_id, 'test-user'); assert.equal(req.payload.group_id, 'vscode-project');
});
test('recent-memory delete picker can load the next page', async () => {
  mode = 'pages'; picks = ['recent', 'more', 'first']; assert.equal((await commands.handleDeleteMemory()).ok, true); assert.deepEqual(requests.filter(r => r.method === 'GET').map(r => r.payload.page), ['1', '2']);
});
test('cancelling delete never sends DELETE', async () => {
  picks = [undefined]; assert.equal((await commands.handleDeleteMemory()).cancelled, true); assert.equal(requests.length, 0);
});
test('sidebar transports configuration as data and tracks external changes', async () => {
  const provider = new EvermemConfigViewProvider({}); const posted = []; let receive;
  const view = { webview: { html: '', postMessage(msg) { posted.push(msg); return Promise.resolve(true); }, onDidReceiveMessage(fn) { receive = fn; return disposable; } }, onDidDispose: () => disposable };
  settings.apiKey = '</script><script>secret</script>'; provider.resolveWebviewView(view); assert.equal(view.webview.html.includes(settings.apiKey), false);
  await receive({ type: 'ready' }); assert.equal(posted[0].data.apiKey, settings.apiKey);
  settings.apiBaseUrl = base + '/api/v1'; configChanged.fire({ affectsConfiguration: () => true }); assert.equal(posted.at(-1).data.apiBaseUrl, settings.apiBaseUrl); provider.dispose();
});
test('sidebar saves effective workspace settings and validates URLs first', async () => {
  const provider = new EvermemConfigViewProvider({}); let receive; const posted = [];
  provider.resolveWebviewView({ webview: { postMessage(msg) { posted.push(msg); return Promise.resolve(true); }, onDidReceiveMessage(fn) { receive = fn; return disposable; } }, onDidDispose: () => disposable });
  await receive({ type: 'saveConfig', data: { apiBaseUrl: 'javascript:alert(1)', apiKey: '', authToken: '' } }); assert.equal(configWrites.length, 0);
  await receive({ type: 'saveConfig', data: { apiBaseUrl: base + '/api/v1', apiKey: '', authToken: '' } }); assert.ok(configWrites.length > 0); assert.ok(configWrites.every(w => w.target === vscode.ConfigurationTarget.Workspace)); provider.dispose();
});
for (const locale of ['en', 'zh-cn', 'zh-tw']) test(`all UI messages and placeholders are available in ${locale}`, () => {
  vscode.env.language = locale;
  for (const source of Object.values(i18n.messages)) {
    const translated = locale === 'en' ? source : catalogs[locale][source]; assert.equal(typeof translated, 'string', `Missing: ${source}`); assert.ok(translated.length > 0);
    assert.deepEqual((translated.match(/\{\d+\}/g) || []).sort(), (source.match(/\{\d+\}/g) || []).sort());
  }
  const html = results.renderResults([], 1); assert.ok(html.includes(i18n.t('searchResults'))); assert.ok(html.includes(i18n.t('noMemories'))); assert.ok(!i18n.t('searchDone', 3).includes('{0}'));
});
test('manifest localization includes all placeholders in all supported languages', () => {
  const manifest = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const keys = [...manifest.matchAll(/%([^%]+)%/g)].map(m => m[1]);
  for (const suffix of ['', '.zh-cn', '.zh-tw']) { const strings = JSON.parse(fs.readFileSync(path.join(root, `package.nls${suffix}.json`), 'utf8')); for (const key of keys) assert.ok(strings[key], `${suffix}: ${key}`); }
});

test('failed asynchronous processing is returned as a status', async () => {
  mode = 'failedJob';
  assert.equal((await new api.MemoryApi(config.getConfig()).status('job-1')).status, 'failed');
  assert.equal(requests.length, 1);
});
test('connection probe rejects an HTTP 200 business error', async () => {
  mode = 'failedJob';
  assert.equal(await config.testConnection(config.getConfig()), false);
  assert.equal(requests.length, 1);
});
