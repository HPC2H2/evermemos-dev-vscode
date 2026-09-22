import * as vscode from 'vscode';
import axios, { AxiosInstance } from 'axios';
import { t } from './i18n';

export interface EvermemConfig {
  apiBaseUrl: string;
  apiKey?: string;
  authToken?: string;
}

export interface ActionResult<T = unknown> {
  ok: boolean;
  cancelled?: boolean;
  message?: string;
  data?: T;
}

export const DEFAULT_API_BASE_URL = 'https://api.evermind.ai';
export const API_PATHS = {
  MEMORIES: ['/api/v0/memories', '/api/v1/memories', '/api/memories', '/memories'],
  MEMORIES_SEARCH: ['/api/v0/memories/search', '/api/v1/memories/search'],
  REQUEST_STATUS: ['/api/v1/stats/request', '/api/v0/stats/request', '/api/stats/request', '/stats/request'],
} as const;

export function getPreferredApiVersion(apiBaseUrl: string): 'v0' | 'v1' {
  return /\/api\/v1(?:\/|$)/i.test(apiBaseUrl) ? 'v1' : 'v0';
}

export function orderPaths(paths: readonly string[], preferred: 'v0' | 'v1'): string[] {
  const score = (path: string) => path.includes(`/api/${preferred}/`) ? 0 : /\/api\/v[01]\//.test(path) ? 1 : 2;
  return [...new Set(paths)].sort((a, b) => score(a) - score(b));
}

export const EXTENSION_NAME = 'EverMemOS';
export const EXTENSION_ID = 'evermem';
export const outputChannel = vscode.window.createOutputChannel(EXTENSION_NAME);

// Do not log authorization headers, captured code, or full server responses.
export function logOutput(message: string, data?: unknown): void {
  outputChannel.appendLine(data === undefined ? message : `${message} ${JSON.stringify(data)}`);
}

export function createClient(config: EvermemConfig): AxiosInstance {
  const baseURL = (config.apiBaseUrl || DEFAULT_API_BASE_URL).trim().replace(/\/+$/, '').replace(/\/api(?:\/v\d+)?$/i, '');
  const authValue = config.apiKey || config.authToken;
  return axios.create({
    baseURL,
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(authValue ? { Authorization: `Bearer ${authValue}` } : {}),
      'User-Agent': `${EXTENSION_NAME}/VSCode`,
    },
  });
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new vscode.CancellationError();
  }
}

export function isCancelled(error: unknown): boolean {
  return error instanceof vscode.CancellationError || axios.isCancel(error);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new vscode.CancellationError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function requestWithRetry<T>(
  requestFn: () => Promise<T>, maxRetries = 2, baseDelay = 1000, signal?: AbortSignal
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    throwIfCancelled(signal);
    try {
      const result = await requestFn();
      throwIfCancelled(signal);
      return result;
    } catch (error) {
      throwIfCancelled(signal);
      if (isCancelled(error)) {
        throw error;
      }
      const code = (error as { code?: string })?.code;
      const networkFailure = axios.isAxiosError(error)
        ? !error.response && ['ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_NETWORK'].includes(code || '')
        : code === 'ECONNREFUSED' || code === 'ECONNABORTED';
      if (!networkFailure || attempt >= maxRetries) {
        throw error;
      }
      await delay(baseDelay * 2 ** attempt, signal);
    }
  }
}

export async function withCancellation<T>(token: vscode.CancellationToken, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const subscription = token.onCancellationRequested(() => controller.abort());
  if (token.isCancellationRequested) {
    controller.abort();
  }
  try {
    throwIfCancelled(controller.signal);
    return await fn(controller.signal);
  } finally {
    subscription.dispose();
  }
}

export function readConfig(): EvermemConfig {
  const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
  return {
    apiBaseUrl: (cfg.get<string>('apiBaseUrl', DEFAULT_API_BASE_URL) || DEFAULT_API_BASE_URL).trim(),
    apiKey: cfg.get<string>('apiKey', '').trim() || process.env.EVERMEM_API_KEY?.trim(),
    authToken: cfg.get<string>('authToken', '').trim() || undefined,
  };
}

export function configError(config: EvermemConfig): string | undefined {
  try {
    const url = new URL(config.apiBaseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return t('invalidUrl');
    }
  } catch {
    return t('invalidUrl');
  }
  return config.apiKey || config.authToken ? undefined : t('missingKey');
}

export function getConfig(): EvermemConfig | null {
  const config = readConfig();
  const error = configError(config);
  if (error) {
    const action = t('openSettings');
    void vscode.window.showErrorMessage(`${EXTENSION_NAME}: ${error}`, action).then((choice) => {
      if (choice === action) {
        void vscode.commands.executeCommand('workbench.action.openSettings', EXTENSION_ID);
      }
    });
    return null;
  }
  return config;
}

export async function testConnection(config: EvermemConfig, signal?: AbortSignal): Promise<boolean> {
  const client = createClient(config);
  for (const path of orderPaths(API_PATHS.MEMORIES, getPreferredApiVersion(config.apiBaseUrl))) {
    throwIfCancelled(signal);
    try {
      const response = await client.get(path, {
        params: { user_id: vscode.env.machineId || 'vscode-user', top_k: 1, page: 1, page_size: 1 },
        timeout: 5000,
        signal,
      });
      throwIfCancelled(signal);
      let data: unknown = response.data;
      for (let depth = 0; depth < 4; depth++) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) { return false; }
        const result = data as Record<string, unknown>;
        if (result.success === false || result.status === 'error' || result.status === 'failed') { return false; }
        const nested = result.result ?? result.data;
        if (!nested || typeof nested !== 'object' || Array.isArray(nested)) { return true; }
        data = nested;
      }
      return false;
    } catch (error) {
      throwIfCancelled(signal);
      if (isCancelled(error)) {
        throw error;
      }
      if (axios.isAxiosError(error) && [404, 405].includes(error.response?.status || 0)) {
        continue;
      }
      return false;
    }
  }
  return false;
}
