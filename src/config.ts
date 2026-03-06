import * as vscode from 'vscode';
import axios, { AxiosInstance, AxiosError, AxiosResponse } from 'axios';

export interface EvermemConfig {
  apiBaseUrl: string;
  apiKey?: string;
  authToken?: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  status?: number;
}

export interface ActionResult<T = any> {
  ok: boolean;
  message?: string;
  data?: T;
}

export type SidebarActionPayload =
  | { type: 'addMemory'; payload?: { text?: string; note?: string; useSelection?: boolean } }
  | { type: 'quickRecap'; payload?: { query?: string } }
  | { type: 'projectOverview' }
  | { type: 'deleteMemory' }
  | { type: 'testConnection' }
  | { type: 'openSettings' };

export const DEFAULT_API_BASE_URL = 'https://api.evermind.ai';
export const API_PATHS = {
  MEMORIES: ['/api/v0/memories', '/api/memories', '/memories'],
  MEMORIES_SEARCH: ['/api/v0/memories/search', '/api/memories/search', '/memories/search'],
  CONVERSATION_META: ['/api/v0/memories/conversation-meta', '/api/memories/conversation-meta', '/memories/conversation-meta'],
  REQUEST_STATUS: ['/api/v1/stats/request', '/api/v0/stats/request', '/api/stats/request', '/stats/request'],
  HEALTH: ['/health', '/'],
} as const;

export const EXTENSION_NAME = 'EverMemOS';
export const EXTENSION_ID = 'evermem';
export const outputChannel = vscode.window.createOutputChannel(EXTENSION_NAME);

export function logOutput(message: string, data?: any) {
  const text = data !== undefined ? `${message} ${JSON.stringify(data, null, 2)}` : message;
  outputChannel.show(true);
  outputChannel.appendLine(text);
}

export function createClient(config: EvermemConfig): AxiosInstance {
  const trimmedBase = (config.apiBaseUrl || DEFAULT_API_BASE_URL).trim().replace(/\/+$/, '');
  const baseURL = trimmedBase.replace(/\/api(?:\/v\d+)?$/, '');
  const authValue = config.apiKey || config.authToken;

  const instance = axios.create({
    baseURL,
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(authValue ? { Authorization: `Bearer ${authValue}` } : {}),
      'User-Agent': `${EXTENSION_NAME}/VSCode`,
    },
  });

  instance.interceptors.request.use(
    (request) => {
      if (authValue) {
        request.headers = request.headers ?? {};
        request.headers['Authorization'] = `Bearer ${authValue}`;
      }
      if (process.env.NODE_ENV === 'development') {
        console.log(`[EverMemOS] Request: ${request.method?.toUpperCase()} ${request.baseURL}${request.url}`);
      }
      return request;
    },
    (error) => {
      console.error('[EverMemOS] Request interceptor error:', error);
      return Promise.reject(error);
    }
  );

  instance.interceptors.response.use(
    (response) => {
      if (process.env.NODE_ENV === 'development') {
        console.log(`[EverMemOS] Response: ${response.status} ${response.config.url}`);
      }
      return response;
    },
    (error: AxiosError) => {
      console.error('[EverMemOS] Response error:', {
        url: error.config?.url,
        method: error.config?.method,
        status: error.response?.status,
        message: error.message,
      });
      return Promise.reject(error);
    }
  );

  return instance;
}

export async function requestWithRetry<T>(
  requestFn: () => Promise<T>,
  maxRetries = 2,
  baseDelay = 1000
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (err) {
      lastError = err;
      const code = (err as any)?.code;
      const hasResponse = (err as any)?.response;
      const isAxiosNetwork = axios.isAxiosError(err) && (
        !err.response ||
        code === 'ECONNABORTED' ||
        code === 'ECONNREFUSED'
      );
      const isGenericNetwork = !axios.isAxiosError(err) && !hasResponse && (code === 'ECONNABORTED' || code === 'ECONNREFUSED');
      const isNetworkError = isAxiosNetwork || isGenericNetwork;
      if (isNetworkError && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`[EverMemOS] Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      break;
    }
  }
  throw lastError;
}

export function getConfig(): EvermemConfig | null {
  const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
  const apiBaseUrl = (cfg.get<string>('apiBaseUrl', DEFAULT_API_BASE_URL) || DEFAULT_API_BASE_URL).trim();
  const apiKeySetting = cfg.get<string>('apiKey', '')?.trim();
  const authTokenSetting = cfg.get<string>('authToken', '')?.trim();
  const envApiKey = process.env.EVERMEM_API_KEY?.trim();
  const apiKey = apiKeySetting || envApiKey || authTokenSetting;

  if (!apiBaseUrl) {
    vscode.window
      .showErrorMessage(
        `${EXTENSION_NAME}: API base URL is not configured. Please set "${EXTENSION_ID}.apiBaseUrl" in settings.`,
        'Open Settings'
      )
      .then((selection) => {
        if (selection === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', `${EXTENSION_ID}.apiBaseUrl`);
        }
      });
    return null;
  }

  try {
    new URL(apiBaseUrl);
  } catch (error) {
    vscode.window
      .showErrorMessage(
        `${EXTENSION_NAME}: Invalid API base URL format. Please check your settings.`,
        'Open Settings'
      )
      .then((selection) => {
        if (selection === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', `${EXTENSION_ID}.apiBaseUrl`);
        }
      });
    return null;
  }

  if (!apiKey) {
    vscode.window
      .showErrorMessage(
        `${EXTENSION_NAME}: 缺少 API Key，请在设置中配置 "${EXTENSION_ID}.apiKey" 或设置环境变量 EVERMEM_API_KEY。`,
        'Open Settings'
      )
      .then((selection) => {
        if (selection === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', `${EXTENSION_ID}.apiKey`);
        }
      });
    return null;
  }

  return {
    apiBaseUrl,
    apiKey,
    authToken: authTokenSetting || undefined,
  };
}

export async function testConnection(config: EvermemConfig): Promise<boolean> {
  const client = createClient(config);
  for (const path of API_PATHS.HEALTH) {
    try {
      const response = await requestWithRetry<AxiosResponse>(() => client.get(path, { timeout: 5000 }));
      if (response.status < 500) {
        return true;
      }
    } catch (error) {
      // try next
    }
  }
  return false;
}
