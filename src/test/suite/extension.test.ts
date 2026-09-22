import * as assert from 'assert';
import * as vscode from 'vscode';
import * as http from 'node:http';
import { safeTruncate } from '../../utils';
import { createClient, getConfig, requestWithRetry } from '../../config';
import { insertSnippet, showResults, disposeResults } from '../../results';
import { t } from '../../i18n';

suite('EverMemOS in VS Code', () => {
  suiteTeardown(async () => {
    disposeResults();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('safeTruncate keeps punctuation boundary', () => {
    const truncated = safeTruncate('Hello world! This is a long sentence that should be truncated nicely.', 30);
    assert.ok(truncated.endsWith('...'));
    assert.ok(truncated.length <= 33);
  });

  test('requestWithRetry retries network errors', async () => {
    let calls = 0;
    const result = await requestWithRetry(async () => {
      if (++calls < 2) { throw Object.assign(new Error('fail'), { code: 'ECONNREFUSED' }); }
      return 'ok';
    }, 2, 10);
    assert.strictEqual(result, 'ok');
    assert.strictEqual(calls, 2);
  });

  test('createClient trims /api suffix and sets auth header', () => {
    const client = createClient({ apiBaseUrl: 'https://api.evermind.ai/api/v0', apiKey: 'abc' });
    assert.strictEqual(client.defaults.baseURL, 'https://api.evermind.ai');
    assert.strictEqual(client.defaults.headers.Authorization, 'Bearer abc');
  });

  test('getConfig reads settings and environment', async () => {
    const cfg = vscode.workspace.getConfiguration('evermem');
    const previous = cfg.inspect('apiKey')?.globalValue;
    const env = process.env.EVERMEM_API_KEY;
    try {
      await cfg.update('apiKey', 'offline-settings-key', vscode.ConfigurationTarget.Global);
      assert.strictEqual(getConfig()?.apiKey, 'offline-settings-key');
      await cfg.update('apiKey', '', vscode.ConfigurationTarget.Global);
      process.env.EVERMEM_API_KEY = 'offline-env-key';
      assert.strictEqual(getConfig()?.apiKey, 'offline-env-key');
    } finally {
      if (env === undefined) { delete process.env.EVERMEM_API_KEY; } else { process.env.EVERMEM_API_KEY = env; }
      await cfg.update('apiKey', previous, vscode.ConfigurationTarget.Global);
    }
  });

  test('command translations load through the native extension manifest', () => {
    const locale = process.env.EVERMEM_TEST_LOCALE || 'en';
    assert.strictEqual(vscode.env.language.toLowerCase(), locale);
    const expected: Record<string, string> = { en: 'Add Memory', 'zh-cn': '添加记忆', 'zh-tw': '新增記憶' };
    const manifest = vscode.extensions.getExtension('HPC2H2.evermemos-dev-vscode')!.packageJSON;
    const title = manifest.contributes.commands[0].title;
    assert.strictEqual(typeof title === 'string' ? title : title.value, expected[locale]);
  });

  test('extension activates and registers commands without credentials', async () => {
    const extension = vscode.extensions.getExtension('HPC2H2.evermemos-dev-vscode');
    assert.ok(extension);
    await extension.activate();
    const commands = await vscode.commands.getCommands();
    for (const name of ['addMemory', 'quickRecap', 'projectOverview', 'deleteMemory', 'openSidebar']) {
      assert.ok(commands.includes(`evermem.${name}`));
    }
  });

  test('inserting into a real editor preserves escapes and whitespace', async () => {
    const doc = await vscode.workspace.openTextDocument({ content: '// offline fixture\n', language: 'typescript' });
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    const snippet = String.raw`export const greeting = "Hello\nEverMem";` + '\n  ';
    await insertSnippet(snippet, 'typescript', editor);
    assert.strictEqual(doc.getText(), '// offline fixture\n' + snippet);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  test('repeated search reuses one real webview tab', async () => {
    const resultTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label.includes(t('searchResults')));
    for (let index = 0; index < 3; index++) {
      showResults([{ content: '</script><script>unsafe()</script>' }]);
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.strictEqual(resultTabs().length, 1);
    }
    disposeResults();
  });

  test('overview reuses generated documents and preserves user edits', async () => {
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ result: { memories: [{ content: 'offline memory' }], total_count: 1 } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const cfg = vscode.workspace.getConfiguration('evermem');
    const previousUrl = cfg.inspect('apiBaseUrl')?.globalValue;
    const previousKey = cfg.inspect('apiKey')?.globalValue;
    try {
      await cfg.update('apiBaseUrl', `http://127.0.0.1:${address.port}`, vscode.ConfigurationTarget.Global);
      await cfg.update('apiKey', 'offline-dummy-key', vscode.ConfigurationTarget.Global);
      assert.ok((await vscode.commands.executeCommand<{ ok: boolean }>('evermem.projectOverview'))?.ok);
      const first = vscode.window.activeTextEditor!.document;
      const titles: Record<string, string> = { en: 'Project Overview', 'zh-cn': '项目概览', 'zh-tw': '專案概覽' };
      assert.ok(first.getText().includes(titles[process.env.EVERMEM_TEST_LOCALE || 'en']), 'Runtime bundle must use the selected display language');
      assert.ok((await vscode.commands.executeCommand<{ ok: boolean }>('evermem.projectOverview'))?.ok);
      assert.ok((await vscode.commands.executeCommand<{ ok: boolean }>('evermem.projectOverview'))?.ok);
      assert.strictEqual(vscode.window.activeTextEditor!.document.uri.toString(), first.uri.toString());
      await vscode.window.activeTextEditor!.edit(edit => edit.insert(new vscode.Position(0, 0), 'user note\n'));
      assert.ok((await vscode.commands.executeCommand<{ ok: boolean }>('evermem.projectOverview'))?.ok);
      assert.notStrictEqual(vscode.window.activeTextEditor!.document.uri.toString(), first.uri.toString());
      assert.ok(first.getText().startsWith('user note\n'));
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.window.showTextDocument(first);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    } finally {
      await cfg.update('apiBaseUrl', previousUrl, vscode.ConfigurationTarget.Global);
      await cfg.update('apiKey', previousKey, vscode.ConfigurationTarget.Global);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
