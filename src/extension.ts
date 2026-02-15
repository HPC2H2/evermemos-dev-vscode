/**
 * @file        extension.ts
 * @description VS Code 扩展主入口文件，包含核心功能实现和命令注册
 * @module      extension

 * @author      HPC2H2
 * @version     1.0.0
 * @date        2026-02-14
 * @lastModified 2026-02-16 by HPC2H2
 * 
 * @copyright   Copyright (c) 2026
 * @license     MIT
 */

import * as vscode from 'vscode'; // VS Code API
import axios, { AxiosInstance, AxiosError } from 'axios'; // http服务器通信   

// ==================== 接口定义 ====================
// ts问号表示可选属性，| undefined 是冗余的，可以省略

// Evemem插件的全局配置
interface EvermemConfig {
  apiBaseUrl: string;
  authToken?: string;
} 

// 单条记忆（memory）的数据结构
interface MemoryItem {
  id?: string;
  memory_id?: string; // memory的唯一标识
  content: string; // memory的内容
  created_at?: string; // 服务器返回的创建时间
  meta?: Record<string, any>; // 服务器返回的元数据，结构不固定
}

// 查询记忆列表的响应结构
interface MemoryListResponse {
  items: MemoryItem[];
  total?: number; // 总条数（可选）
  has_more?: boolean;
  next_cursor?: string;
}

// 快速回顾（recap）的响应结构
interface RecapResponse {
  recap: string;
  summary?: string;
  question?: string;
  created_at?: string;
}

// 项目概览（Overiew）的响应结构
interface OverviewResponse {
  overview: string;
  project_count?: number;
  memory_count?: number;
  last_updated?: string;
}

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  status?: number;
}

// ==================== 常量定义 ====================
// 所有后端API路径，优先使用 v1（本地 apiv1 正常），并提供回退路径以兼容不同部署
const API_PATHS = {
  MEMORIES: ['/api/v1/memories', '/api/v0/memories', '/api/memories', '/memories'],
  MEMORIES_SEARCH: ['/api/v1/memories/search', '/api/v0/memories/search', '/api/memories/search', '/memories/search'],
  CONVERSATION_META: ['/api/v1/memories/conversation-meta', '/api/v0/memories/conversation-meta', '/api/memories/conversation-meta', '/memories/conversation-meta'],
  REQUEST_STATUS: ['/api/v1/status/request', '/api/v0/status/request', '/api/status/request', '/status/request'],
  HEALTH: ['/health', '/'],
} as const;

// 扩展在UI中的名
const EXTENSION_NAME = 'EverMemOS';
// 配置项前缀，也就是setting.json中对应的key
const EXTENSION_ID = 'evermem';

// ==================== 辅助函数 ====================
/**
 * 根据用户配置，创建并返回一个配置好的 Axios实例，用于与EverMemOS服务器通信
 * - 自动处理 baseURL尾部斜杠
 * - 如有 authToken，则在请求头中添加Authorization字段
 * - 添加请求和响应拦截器，记录日志并处理错误
**/
function createClient(config: EvermemConfig): AxiosInstance {
  // 清理 URL，移除末尾的斜杠，并兼容用户填了 "/api"、"/api/v0"、"/api/v1" 前缀，避免生成重复路径
  const trimmedBase = config.apiBaseUrl.trim().replace(/\/+$/, '');
  const baseURL = trimmedBase.replace(/\/api(?:\/v\d+)?$/, '');
  
  const instance = axios.create({
    baseURL,
    timeout: 30000, // 30秒超时
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  });

  // 请求拦截器
  instance.interceptors.request.use(
    (request) => {
      // 如果配置了Bearer Token，则添加到请求头
      if (config.authToken) {
        request.headers = request.headers ?? {};
        request.headers['Authorization'] = `Bearer ${config.authToken}`;
      }
      
      // 记录请求日志（仅开发模式）
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

  // 响应拦截器
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

/**
 * 包装一次请求，支持指数退避的自动重试。 
 * @param requestFn 实际执行请求的函数，应该返回一个 Promise
 * @param maxRetries 最大重试次数，默认2次
 * @param baseDelay 基础延迟时间，单位毫秒，默认1000ms
 * @returns 请求成功时的响应数据
 * @throws 最后一次请求失败的错误
*/
async function requestWithRetry<T>(
  requestFn: () => Promise<T>,
  maxRetries = 2,
  baseDelay = 1000
): Promise<T> {
  let lastError: any;
  
  // 循环次数：0（初始尝试） + maxRetries（重试次数）
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // 调用真正的请求函数，若成功则直接返回结果
      return await requestFn();
    } catch (err) {
      // 捕获异常，记录下来以便在全部尝试结束后抛出
      lastError = err;
      
      // 判断是否为网络错误
      const isNetworkError = axios.isAxiosError(err) && 
        (!err.response || // 没有收到服务器响应
          err.code === 'ECONNABORTED' || // 超时
          err.code === 'ECONNREFUSED'); // 连接被拒绝
      
          // 若是网络错误，且还有剩余重试次数，则执行指数退避
      if (isNetworkError && attempt < maxRetries) {
        // 计算本次等待时间: baseDelay * 2^attempt
        // 第一次失败等待 1 s（baseDelay），第二次失败等待 2 s，第三次失败等待 4 s，以此类推
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(
          `[EverMemOS] Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`)
          ;
        // 使用 Promise + setTimeout 实现异步等待
        await new Promise(resolve => setTimeout(resolve, delay));
        // 继续下一轮循环（再次调用 requestFn）
        continue;
      }
      break;
    }
  }
  // 所有尝试都失败了，抛出最后一次失误给调用方
  throw lastError;
}

/**
 * 读取 VS Code 设置，返回插件运行所需的配置对象。
 * 若缺少必填项或格式错误，会弹窗提示并返回 null。
 */
function getConfig(): EvermemConfig | null {
  const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
  const apiBaseUrl = cfg.get<string>('apiBaseUrl', '').trim();
  const authToken = cfg.get<string>('authToken', '').trim();

  // 必填校验：API Base URL
  if (!apiBaseUrl) {
    vscode.window.showErrorMessage(
      `${EXTENSION_NAME}: API base URL is not configured. Please set "${EXTENSION_ID}.apiBaseUrl" in settings.`,
      'Open Settings'
    ).then(selection => {
      if (selection === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', `${EXTENSION_ID}.apiBaseUrl`);
      }
    });
    return null;
  }

  // URL 格式校验
  try {
    new URL(apiBaseUrl);
  } catch (error) {
    vscode.window.showErrorMessage(
      `${EXTENSION_NAME}: Invalid API base URL format. Please check your settings.`,
      'Open Settings'
    ).then(selection => {
      if (selection === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', `${EXTENSION_ID}.apiBaseUrl`);
      }
    });
    return null;
  }

  return {
    apiBaseUrl,
    authToken: authToken || undefined,
  };
}

/**
 * 统一的错误处理函数，负责：
 * - 控制台打印错误堆栈
 * - 根据错误类型，构造用户友好的提示信息
 * - 提供“打开设置”或“重试”等可选操作按钮
 */
function handleError(err: unknown, context: string): void {
  console.error(`[${EXTENSION_NAME}] ${context} failed:`, err);

  let message = `${EXTENSION_NAME}: ${context} failed`;
  let actions: string[] = [];

  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data as any;
    // 2.15 尝试从响应数据中提取错误详情，如果是对象则格式化为字符串
    const serializedData = data
      ? (typeof data === 'string' ? data : JSON.stringify(data, null, 2))
      : undefined;

    console.error(`[${EXTENSION_NAME}] HTTP error detail:`, {
      url: err.config?.url,
      method: err.config?.method,
      status,
      headers: err.response?.headers,
      data,
    });
    
    // 根据不同的 HTTP 状态码，给出对应的提示
    if (status === 401) {
      message = `${EXTENSION_NAME}: Authentication failed. Please check your auth token.`;
      actions = ['Open Settings'];
    } else if (status === 404) {
      message = `${EXTENSION_NAME}: API endpoint not found. Please check your API base URL.`;
      actions = ['Open Settings'];
    } else if (status === 500) {
      message = `${EXTENSION_NAME}: Server error. Please check your EverMemOS server.`;
    } else if (status) {
      message = `${EXTENSION_NAME}: HTTP ${status}`;
    }

    // 若后端返回了错误描述字段，将其追加到提示中
    if (data) {
      const errorMsg = data.message || data.error || data.detail || data.msg;
      if (errorMsg) {
        message += `: ${errorMsg}`;
      } else if (serializedData) {
        message += ` | Detail: ${serializedData}`;
      }
    }

    // 处理网络层面的错误代码
    if (err.code === 'ECONNREFUSED') {
      message = `${EXTENSION_NAME}: Cannot connect to EverMemOS server. Please ensure it's running at ${err.config?.baseURL}`;
      actions = ['Open Settings', 'Retry'];
    } else if (err.code === 'ETIMEDOUT') {
      message = `${EXTENSION_NAME}: Connection timeout. Server may be unresponsive.`;
      actions = ['Retry'];
    }
  } else if (err instanceof Error) {
    // 非 Axios错误，直接使用错误对象的 message
    message += `: ${err.message}`;
  }

  // 显示错误弹窗并处理用户选择
  vscode.window.showErrorMessage(message, ...actions).then(selection => {
    if (selection === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', EXTENSION_ID);
    } else if (selection === 'Retry') {
      // 根据上下文重试相应的命令
      const commandMap: Record<string, string> = {
        'addmemory': 'evermem.addMemory',
        'quickrecap': 'evermem.quickRecap',
        'projectoverview': 'evermem.projectOverview',
        'deletememory': 'evermem.deleteMemory',
      };

      const commandKey = context.toLowerCase().replace(/\s+/g, '');
      const command = commandMap[commandKey];
      if (command) {
        vscode.commands.executeCommand(command);
      }
    }
  });
}

/**
 * 检测后端健康（health）接口是否可达。
 * 首先尝试访问 /health
 * 若改短点不存在，则回退请求根路径 /。
 */
async function testConnection(config: EvermemConfig): Promise<boolean> {
  const client = createClient(config);
  for (const path of API_PATHS.HEALTH) {
    try {
      const response = await requestWithRetry(
        () => client.get(path, { timeout: 5000 })
      );
      if (response.status < 500) {
        return true;
      }
    } catch (error) {
      // ignore and try next
    }
  }
  return false;
}


// ==================== 类型守卫 ====================
// 下面的函数用于在运行时判断对象是否符合特定接口， 帮助ts正确推导类型
function isApiResponse<T>(obj: any): obj is ApiResponse<T> {
  return obj && typeof obj === 'object' && 'success' in obj;
}

function isMemoryItem(obj: any): obj is MemoryItem {
  return obj && typeof obj === 'object' && 'content' in obj;
}

function isMemoryListResponse(obj: any): obj is MemoryListResponse {
  return obj && typeof obj === 'object' && 'items' in obj;
}

function isRecapResponse(obj: any): obj is RecapResponse {
  return obj && typeof obj === 'object' && 'recap' in obj;
}

function isOverviewResponse(obj: any): obj is OverviewResponse {
  return obj && typeof obj === 'object' && 'overview' in obj;
}

// ==================== 文本处理函数 ====================
/**
 * 对文本进行安全截断，确保不会在单词中间断开。
* - 删除换行符后再截断
* - 优先在标点符号或空格处断开
* - 超过阈值时，在截断点后追加省略号
 */
function safeTruncate(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) {return text || '';}
  
  // 移除换行符，避免多行内容导致意外截断
  const cleanText = text.replace(/[\r\n]+/g, ' ');
  
  if (cleanText.length <= maxLength) {return cleanText;}
  
  // 尝试在单词边界处截断
  const truncated = cleanText.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  const lastPunctuation = Math.max(
    truncated.lastIndexOf('.'),
    truncated.lastIndexOf('!'),
    truncated.lastIndexOf('?'),
    truncated.lastIndexOf(','),
    truncated.lastIndexOf(';'),
    truncated.lastIndexOf(':')
  );
  
  const breakPoint = Math.max(lastPunctuation, lastSpace);
  
  if (breakPoint > maxLength * 0.6) { // 如果有合适的断点，则在其后添加省略号
    return truncated.substring(0, breakPoint + 1).trim() + '...';
  }
  
  return truncated.trim() + '...';
}

// ==================== 核心功能 ====================
/**
 * 获取当前编辑器的选区或整个文件内容，并收集相关的元信息。
 * - 当没有打开编辑器的时候返回 null
 * - 当选区或文件为空时，弹出提示并返回 null
 * - 返回对象包括纯文本/元数据（meta）以及文件信息（fileInfo）
 */
function getCurrentSelectionOrFile():
  | {
      text: string;
      meta: Record<string, any>;
      fileInfo: {
        path: string;
        language: string;
        startLine: number;
        endLine: number;
        totalLines: number;
      };
    }
  | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage(
      `${EXTENSION_NAME}: No active editor. Open a file to add memory.`
    );
    return null;
  }

  const document = editor.document;
  const selection = editor.selection;
  
  // 获取全文件文本或选中的文本
  const fullText = document.getText();
  const selectedText = selection.isEmpty ? '' : document.getText(selection);
  const text = (selectedText || fullText).trim();

  if (!text) {
    vscode.window.showWarningMessage(
      `${EXTENSION_NAME}: File or selection is empty. Nothing to add as memory.`
    );
    return null;
  }

  // 收集文件级别的元信息，供后端存储和后续检索使用
  const fileInfo = {
    path: document.uri.fsPath,
    language: document.languageId,
    startLine: selection.isEmpty ? 0 : selection.start.line,
    endLine: selection.isEmpty ? document.lineCount - 1 : selection.end.line,
    totalLines: document.lineCount,
    selected: !selection.isEmpty,
    workspace: vscode.workspace.name || undefined,
    workspaceFolders: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [],
  };

  const meta = {
    source: 'vscode-extension',
    extension_version: '0.0.1',
    captured_at: new Date().toISOString(),
    file_info: fileInfo,
    context: {
      selected_lines: fileInfo.endLine - fileInfo.startLine + 1,
      selection_range: selection.isEmpty ? undefined : {
        start: { line: selection.start.line, character: selection.start.character },
        end: { line: selection.end.line, character: selection.end.character },
      },
    },
  };

  return { text, meta, fileInfo };
}

/**
 * "添加记忆"主流程：
 * 1. 读取并校验配置
 * 2. 检查服务器连通性
 * 3. 获取当前编辑器的内容及元数据
 * 4. 发送 POST 请求创建记忆
 * 5. 根据返回的 MemoryItem 显示成功提示并提供跳转链接
 * @returns 
 */
async function handleAddMemory(): Promise<void> {
  // 读取并校验是否有配置
  const config = getConfig();
  if (!config) {
    return;
  }

  // 检测后端可达性
  const isConnected = await testConnection(config);
  if (!isConnected) {
    vscode.window.showErrorMessage(
      `${EXTENSION_NAME}: Cannot connect to server at ${config.apiBaseUrl}. Please check your configuration.`,
      'Open Settings'
    );
    return;
  }

  // 获取当前选区或文件内容，以及相关的元信息；若没有文本，则让用户手动输入
  const selection = getCurrentSelectionOrFile();
  let text = selection?.text || '';
  if (!text) {
    const input = await vscode.window.showInputBox({
      title: `${EXTENSION_NAME}: Add memory`,
      prompt: '输入要添加的内容',
      ignoreFocusOut: true,
    });
    if (!input) { return; }
    text = input.trim();
  }

  // 创建 Axios 客户端实例，以向服务器发起请求
  const client = createClient(config);

  const userId = vscode.env.machineId || 'vscode-user';
  const groupId = vscode.workspace.name ? `vscode-${vscode.workspace.name}` : undefined;

  try {
    // 显示进度条，并尝试连接服务器请求创建记忆
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${EXTENSION_NAME}: Adding memory...`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ increment: 30 });
        
        // https://docs.evermind.ai/api-reference/core-memory-operation/add-memories 字段说明
        const payload: Record<string, any> = {
          message_id: `vscode-${Date.now()}`,
          create_time: new Date().toISOString(),
          sender: userId,
          content: text,
          group_id: groupId,
          group_name: groupId,
          flush: true,
        };
        
        // 尝试多个版本的路径（优先 v1，再回退）
        const memoryPaths = API_PATHS.MEMORIES;

        let response: any; 
        let lastError: any;
        for (const path of memoryPaths) {
          try {
            response = await requestWithRetry(() => client.post(path, payload));
            lastError = undefined;
            break;
          } catch (err) {
            lastError = err;
            if (axios.isAxiosError(err) && err.response?.status === 404) {
              console.warn(`[${EXTENSION_NAME}] ${path} not found, trying next path...`);
              continue;
            }
            throw err;
          }
        }

        if (!response && lastError) {
          throw lastError;
        }

        progress.report({ increment: 70 });

        const responseData = response?.data || {};
        const requestId =
          (responseData as any).request_id ||
          (isApiResponse<any>(responseData) && (responseData as any).data?.request_id) ||
          'unknown';
        const statusText =
          (responseData as any).status ||
          (isApiResponse<any>(responseData) && (responseData as any).data?.status) ||
          'accepted';

        vscode.window.showInformationMessage(
          `${EXTENSION_NAME}: Memory request ${statusText}. request_id: ${requestId}`
        );
      }
    );
  } catch (error) {
    handleError(error, 'Add memory');
  }
}

/**
 * "快速回顾"主流程：
 * 1. 读取并校验配置
 * 2. 获取用户输入的问题（可选）
 * 3. 发送 POST 请求获取回顾内容
 * 4. 根据返回的内容生成 Markdown 文档并在侧边栏显示
 * @returns 
 */
async function handleQuickRecap(): Promise<void> {
  // 读取并校验是否有配置
  const config = getConfig();
  if (!config) {
    return;
  }

  const client = createClient(config);

  const query = await vscode.window.showInputBox({
    title: `${EXTENSION_NAME}: Search memories`,
    prompt: '输入搜索关键词（留空则返回最近的记忆）',
    placeHolder: 'e.g., coffee preference',
    ignoreFocusOut: true,
  });
  if (query === undefined) {
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${EXTENSION_NAME}: Searching memories...`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ increment: 20, message: 'Calling search API...' });

        const searchPayload = {
          query: query?.trim() || undefined,
          user_id: vscode.env.machineId || undefined,
          group_id: vscode.workspace.name ? `vscode-${vscode.workspace.name}` : undefined,
          include_metadata: true,
          top_k: 20,
        };

        let resp: any;
        let lastErr: any;
        for (const path of API_PATHS.MEMORIES_SEARCH) {
          try {
            resp = await requestWithRetry(() => client.get(path, { params: searchPayload }));
            lastErr = undefined;
            break;
          } catch (err) {
            lastErr = err;
            if (axios.isAxiosError(err) && err.response?.status === 404) {
              console.warn(`[${EXTENSION_NAME}] ${path} not found, trying next path...`);
              continue;
            }
            throw err;
          }
        }
        if (!resp && lastErr) {
          throw lastErr;
        }

        if (token.isCancellationRequested) {
          return;
        }

        progress.report({ increment: 50, message: 'Rendering results...' });

        const data = resp?.data || {};
        const result = (data as any).result || (isApiResponse<any>(data) ? (data as any).data : data);
        // 官方 search 返回 memories: [{ episodic_memory: [...] }] 结构，需扁平化
        const rawMemories: any[] = result?.memories || [];
        const flattened: any[] = [];
        rawMemories.forEach(group => {
          if (group?.episodic_memory && Array.isArray(group.episodic_memory)) {
            flattened.push(...group.episodic_memory);
          } else if (Array.isArray(group)) {
            flattened.push(...group);
          } else if (group) {
            flattened.push(group);
          }
        });
        const profiles: any[] = result?.profiles || [];
        const total = result?.total_count ?? flattened.length;

        let md = `# ${EXTENSION_NAME} Search Results\n\n`;
        md += `- Query: ${query || '(recent)'}\n- Total: ${total}\n\n`;

        if (flattened.length) {
          md += `## Memories\n`;
          flattened.forEach((m, idx) => {
            md += `### #${idx + 1}\n- user_id: ${m.user_id || ''}\n- group_id: ${m.group_id || ''}\n- type: ${m.memory_type || ''}\n- timestamp: ${m.timestamp || ''}\n- summary/content: ${m.summary || m.content || ''}\n\n`;
          });
        }

        if (profiles.length) {
          md += `## Profiles\n`;
          profiles.forEach((p, idx) => {
            md += `### Profile #${idx + 1}\n- category: ${p.category || ''}\n- trait: ${p.trait_name || ''}\n- score: ${p.score ?? ''}\n- description: ${p.description || ''}\n\n`;
          });
        }

        const doc = await vscode.workspace.openTextDocument({
          content: md,
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
          preview: true,
          preserveFocus: false,
        });

        vscode.window.showInformationMessage(`${EXTENSION_NAME}: Search completed`);
      }
    );
  } catch (error) {
    handleError(error, 'Quick recap');
  }
}

/**
 * “项目概览”主流程：
 * 1. 读取并校验配置
 * 2. 发送 GET 请求获取项目概览数据
 * 3. 根据返回的数据生成 Markdown 文档，包含概览内容和统计信息
 * 4. 在侧边栏显示生成的文档
 * @returns 
 */
async function handleProjectOverview(): Promise<void> {
  // 读取并校验是否有配置
  const config = getConfig();
  if (!config) {
    return;
  }

  const client = createClient(config);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${EXTENSION_NAME}: Fetching memories overview...`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ increment: 30 });

        const params = {
          user_id: vscode.env.machineId || undefined,
          group_id: vscode.workspace.name ? `vscode-${vscode.workspace.name}` : undefined,
          memory_type: 'episodic_memory',
          limit: 40,
          offset: 0,
        };

        let resp: any;
        let lastErr: any;
        for (const path of API_PATHS.MEMORIES) {
          try {
            resp = await requestWithRetry(() => client.get(path, { params }));
            lastErr = undefined;
            break;
          } catch (err) {
            lastErr = err;
            if (axios.isAxiosError(err) && err.response?.status === 404) {
              console.warn(`[${EXTENSION_NAME}] ${path} not found, trying next path...`);
              continue;
            }
            throw err;
          }
        }
        if (!resp && lastErr) {
          throw lastErr;
        }

        if (token.isCancellationRequested) {
          return;
        }

        progress.report({ increment: 50 });

        const data = resp?.data || {};
        const result = (data as any).result || (isApiResponse<any>(data) ? (data as any).data : data);
        const memories: any[] = result?.memories || [];
        const total = result?.total_count ?? memories.length;
        const metadata = result?.metadata || {};

        let md = `# ${EXTENSION_NAME} Memories Overview\n\n`;
        md += `- Total memories: ${total}\n`;
        md += `- User: ${params.user_id || 'n/a'}\n`;
        md += `- Group: ${params.group_id || 'n/a'}\n`;
        if (metadata.memory_type) {
          md += `- memory_type: ${metadata.memory_type}\n`;
        }
        md += '\n## Latest items\n';

        memories.forEach((m, idx) => {
          md += `### #${idx + 1}\n- user_id: ${m.user_id || ''}\n- group_id: ${m.group_id || ''}\n- type: ${m.memory_type || ''}\n- timestamp: ${m.timestamp || ''}\n- summary/content: ${m.summary || m.content || ''}\n\n`;
        });

        const doc = await vscode.workspace.openTextDocument({
          content: md,
          language: 'markdown',
        });

        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
          preview: true,
          preserveFocus: false,
        });

        vscode.window.showInformationMessage(
          `${EXTENSION_NAME}: Memories overview loaded successfully!`
        );
      }
    );
  } catch (error) {
    handleError(error, 'Project overview');
  }
}

/**
 * “删除记忆”主流程：
 * 1. 读取并校验配置
 * 2. 让用户选择搜索记忆的方式（关键词搜索或查看最近记忆）
 * 3. 根据选择的方式获取记忆列表，并让用户选择要删除的记忆
 * 4. 显示删除确认弹窗，若用户确认则发送 DELETE 请求删除记忆
 * 5. 删除成功后显示提示，并提供查看已删除记忆的链接
 * @returns 
 */
async function handleDeleteMemory(): Promise<void> {
  const config = getConfig();
  if (!config) {
    return;
  }

  const client = createClient(config);

  try {
    // 第一步：选择搜索方式
    const searchMethod = await vscode.window.showQuickPick(
      [
        { label: '$(search) Search memories', description: 'Search by keyword', value: 'search' },
        { label: '$(list-unordered) View recent memories', description: 'Show latest memories', value: 'recent' },
        { label: '$(device-camera) Refresh last add (by request_id)', description: 'Check request status then search', value: 'status' },
      ],
      {
        placeHolder: 'How would you like to find memories?',
        ignoreFocusOut: true,
      }
    );

    if (!searchMethod) {
      return; // 用户取消
    }

    let searchTerm: string | undefined;
    const searchPayload: Record<string, any> = {
      user_id: vscode.env.machineId || undefined,
      group_ids: vscode.workspace.name ? [`vscode-${vscode.workspace.name}`] : undefined,
      top_k: 50,
    };

    if (searchMethod.value === 'search') {
      searchTerm = await vscode.window.showInputBox({
        prompt: 'Enter search term (optional)',
        placeHolder: 'Type to search memories...',
        ignoreFocusOut: true,
      });
      if (searchTerm === undefined) {
        return; // 用户取消
      }
      if (searchTerm.trim()) {
        searchPayload.query = searchTerm.trim();
      }
    }

    // 若选择按 request_id 刷新，则先输入 request_id，查询状态后再搜索
    if (searchMethod.value === 'status') {
      const reqId = await vscode.window.showInputBox({
        prompt: 'Enter request_id returned by Add memory',
        placeHolder: 'req-xxx or uuid',
        ignoreFocusOut: true,
      });
      if (!reqId) {
        return;
      }
      try {
        let statusResp: any;
        for (const path of API_PATHS.REQUEST_STATUS) {
          try {
            statusResp = await requestWithRetry(() => client.get(path, { params: { request_id: reqId } }));
            break;
          } catch (err) {
            if (axios.isAxiosError(err) && err.response?.status === 404) {
              console.warn(`[${EXTENSION_NAME}] ${path} not found, trying next path...`);
              continue;
            }
            throw err;
          }
        }
        console.log(`[${EXTENSION_NAME}] request status`, statusResp?.data);
      } catch (err) {
        handleError(err, 'Request status');
        return;
      }
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${EXTENSION_NAME}: Loading memories...`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ increment: 30 });

        let resp: any;
        let lastErr: any;
        for (const path of API_PATHS.MEMORIES_SEARCH) {
          try {
            resp = await requestWithRetry(() => client.get(path, { params: searchPayload }));
            lastErr = undefined;
            break;
          } catch (err) {
            lastErr = err;
            if (axios.isAxiosError(err) && err.response?.status === 404) {
              console.warn(`[${EXTENSION_NAME}] ${path} not found, trying next path...`);
              continue;
            }
            throw err;
          }
        }
        if (!resp && lastErr) {
          throw lastErr;
        }

        if (token.isCancellationRequested) {
          return;
        }

        progress.report({ increment: 40 });

        const responseData = resp?.data || {};
        const result = (responseData as any).result || (isApiResponse<any>(responseData) ? (responseData as any).data : responseData);
        const rawMemories: any[] = result?.memories || [];
        const flattened: any[] = [];
        rawMemories.forEach(group => {
          if (group?.episodic_memory && Array.isArray(group.episodic_memory)) {
            flattened.push(...group.episodic_memory);
          } else if (Array.isArray(group)) {
            flattened.push(...group);
          } else if (group) {
            flattened.push(group);
          }
        });

        if (!flattened.length) {
          const message = searchTerm
            ? `No memories found matching "${searchTerm}"`
            : 'No memories found';
          vscode.window.showInformationMessage(`${EXTENSION_NAME}: ${message}`);
          return;
        }

        progress.report({ increment: 30 });

        const pickItems = flattened.map((memory, index) => {
          const memoryId = memory.event_id || memory.id || memory.memory_id || `memory-${index}`;
          const dateStr = memory.timestamp || memory.created_at || '';
          const date = dateStr ? new Date(dateStr) : null;
          const content = memory.summary || memory.content || '';
          const preview = safeTruncate(content, 100);

          return {
            label: `$(note) ${preview || '(empty content)'}`,
            description: date ? date.toLocaleDateString() + ' ' + date.toLocaleTimeString() : '',
            detail: `ID: ${memoryId}`,
            memory,
            alwaysShow: true,
          };
        });

        const hasMore = result?.has_more;
        if (hasMore) {
          pickItems.push({
            label: '$(ellipsis) Load more (not implemented)',
            description: '',
            detail: '',
            memory: {} as MemoryItem,
            alwaysShow: true,
          });
        }

        const picked = await vscode.window.showQuickPick(pickItems, {
          placeHolder: 'Select a memory to delete',
          ignoreFocusOut: true,
          matchOnDescription: true,
          matchOnDetail: true,
        });

        if (!picked) {
          return;
        }

        if (picked.label.startsWith('$(ellipsis)')) {
          vscode.window.showInformationMessage(`${EXTENSION_NAME}: Pagination not implemented yet`);
          return;
        }

        const memory = picked.memory;
        const memoryId = memory.id || memory.memory_id || memory.event_id;
        if (!memoryId) {
          vscode.window.showErrorMessage(`${EXTENSION_NAME}: Memory ID not found`);
          return;
        }

        const confirmMessage = memory.summary || memory.content
          ? `Delete memory: "${safeTruncate(memory.summary || memory.content, 50)}"?`
          : `Delete memory ${memoryId}?`;

        const confirm = await vscode.window.showWarningMessage(
          confirmMessage,
          { modal: true, detail: 'This action cannot be undone.' },
          'Delete'
        );
        
        if (confirm !== 'Delete') {
          return;
        }

        // 执行删除
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `${EXTENSION_NAME}: Deleting memory...`,
              cancellable: false,
            },
            async () => {
              let deleteResp: any;
              let delErr: any;
              for (const path of API_PATHS.MEMORIES) {
                try {
                  // 官方 DELETE /memories 采用 event_id/user_id/group_id 过滤
                  const body = {
                    event_id: memoryId,
                    user_id: vscode.env.machineId || undefined,
                    group_id: vscode.workspace.name ? `vscode-${vscode.workspace.name}` : undefined,
                  };
                  deleteResp = await requestWithRetry(() => client.delete(path, { data: body }));
                  delErr = undefined;
                  break;
                } catch (err) {
                  delErr = err;
                  if (axios.isAxiosError(err) && err.response?.status === 404) {
                    console.warn(`[${EXTENSION_NAME}] ${path} not found, trying next path...`);
                    continue;
                  }
                  throw err;
                }
              }
              if (!deleteResp && delErr) {
                throw delErr;
              }
            }
          );
          
          vscode.window.showInformationMessage(
            `${EXTENSION_NAME}: Memory deleted successfully.`,
            { modal: false }
          );
        } catch (err) {
          handleError(err, 'Delete memory');
        }
      }
    );
  } catch (error) {
    handleError(error, 'Delete memory');
  }
}

// ==================== 扩展激活 ====================
export function activate(context: vscode.ExtensionContext) {
  console.log(`[${EXTENSION_NAME}] Extension activated`);

  // 创建状态栏项
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = '$(database) EverMemOS';
  statusBarItem.tooltip = 'Click to check EverMemOS status';
  statusBarItem.command = 'evermem.projectOverview';
  statusBarItem.show();

  // 注册命令
  const commands = [
    vscode.commands.registerCommand('evermem.addMemory', handleAddMemory),
    vscode.commands.registerCommand('evermem.quickRecap', handleQuickRecap),
    vscode.commands.registerCommand('evermem.projectOverview', handleProjectOverview),
    vscode.commands.registerCommand('evermem.deleteMemory', handleDeleteMemory),
  ];

  commands.forEach(cmd => context.subscriptions.push(cmd));
  
  // 添加状态栏项到订阅
  context.subscriptions.push(statusBarItem);

  // 监听配置变更
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(EXTENSION_ID)) {
        vscode.window.showInformationMessage(
          `${EXTENSION_NAME}: Configuration updated. Some changes may require restart.`,
          'Reload Window'
        ).then(selection => {
          if (selection === 'Reload Window') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
      }
    })
  );

  // 可选：启动时测试连接
  const config = getConfig();
  if (config) {
    testConnection(config).then(isConnected => {
      if (isConnected) {
        console.log(`[${EXTENSION_NAME}] Connected to server at ${config.apiBaseUrl}`);
      } else {
        console.warn(`[${EXTENSION_NAME}] Cannot connect to server at ${config.apiBaseUrl}`);
      }
    });
  }
}

export function deactivate() {
  console.log(`[${EXTENSION_NAME}] Extension deactivated`);
}