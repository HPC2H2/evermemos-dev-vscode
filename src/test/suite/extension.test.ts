import * as assert from 'assert';
import * as vscode from 'vscode';
import { safeTruncate } from '../../utils';
import { createClient, getConfig, requestWithRetry } from '../../config';

suite('EverMemOS core', () => {
  test('safeTruncate keeps punctuation boundary', () => {
    const text = 'Hello world! This is a long sentence that should be truncated nicely.';
    const truncated = safeTruncate(text, 30);
    assert.ok(truncated.endsWith('...'));
    assert.ok(truncated.length <= 33);
  });

  test('requestWithRetry retries network errors', async () => {
    let calls = 0;
    const result = await requestWithRetry(() => {
      calls += 1;
      if (calls < 2) {
        const err: any = new Error('fail');
        err.code = 'ECONNREFUSED';
        err.response = undefined;
        return Promise.reject(err);
      }
      return Promise.resolve('ok');
    }, 2, 10);
    assert.strictEqual(result, 'ok');
    assert.strictEqual(calls, 2);
  });

  test('createClient trims /api suffix and sets auth header', () => {
    const client = createClient({ apiBaseUrl: 'https://api.evermind.ai/api/v0', apiKey: 'abc' });
    assert.strictEqual(client.defaults.baseURL, 'https://api.evermind.ai');
    assert.strictEqual((client.defaults.headers as any)?.Authorization, 'Bearer abc');
  });

  test('getConfig reads settings and env', async () => {
    const cfg = vscode.workspace.getConfiguration('evermem');
    await cfg.update('apiBaseUrl', 'https://api.evermind.ai', true);
    await cfg.update('apiKey', 'key-from-settings', true);
    const res = getConfig();
    assert.ok(res);
    assert.strictEqual(res?.apiKey, 'key-from-settings');
  });
});
