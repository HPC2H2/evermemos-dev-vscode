/**
 * @file        extension.ts
 * @description VS Code 扩展主入口文件，包含核心功能实现和命令注册
 * @module      extension

 * @author      HPC2H2
 * @version     1.0.0
 * @date        2026-02-14
 * @lastModified 2026-02-14 by HPC2H2
 * 
 * @copyright   Copyright (c) 2026
 * @license     MIT
 */

import * as vscode from 'vscode'; // VS Code API
import axios, { AxiosInstance, AxiosError } from 'axios'; // http服务器通信
import { v4 as uuidv4 } from 'uuid';
   

   


// ==================== 接口定义 ====================
// ts问号表示可选属性，| undefined 是冗余的，可以省略
interface EvermemConfig {
  apiBaseUrl: string;
  authToken?: string;
} 

interface MemoryItem {
  id: string;
  memory_id?: string;
  content: string;
  created_at?: string;
  createdAt?: string;
  meta?: Record<string, any>;
}

interface MemoryListResponse {
  items: MemoryItem[];
  total?: number;
  has_more?: boolean;
  next_cursor?: string;
}

interface RecapResponse {
  recap: string;
  summary?: string;
  question?: string;
  created_at?: string;
}

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
const API_ENDPOINTS = {
  MEMORIES: '/api/v1/memories',
  RECAP: '/api/v1/memories/recap',
  OVERVIEW: '/api/v1/memories/overview',
  HEALTH: '/health',
  MEMORIES_SEARCH: '/api/v1/memories/search',
} as const;

const EXTENSION_NAME = 'EverMemOS';
const EXTENSION_ID = 'evermem';

// ==================== 辅助函数 ====================
function createClient(config: EvermemConfig): AxiosInstance {
  // 清理 URL，移除末尾的斜杠
  const baseURL = config.apiBaseUrl.trim().replace(/\/+$/, '');
  
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

async function requestWithRetry<T>(
  client: AxiosInstance,
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
      
      // 如果是网络错误，等待后重试
      const isNetworkError = axios.isAxiosError(err) && 
        (!err.response || err.code === 'ECONNABORTED' || err.code === 'ECONNREFUSED');
      
      if (isNetworkError && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt); // 指数退避
        console.log(`[EverMemOS] Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      break;
    }
  }
  throw lastError;
}

function getConfig(): EvermemConfig | null {
  const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
  const apiBaseUrl = cfg.get<string>('apiBaseUrl', '').trim();
  const authToken = cfg.get<string>('authToken', '').trim();

  // 验证必填配置
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

  // 验证 URL 格式
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

function handleError(err: unknown, context: string): void {
  console.error(`[${EXTENSION_NAME}] ${context} failed:`, err);

  let message = `${EXTENSION_NAME}: ${context} failed`;
  let actions: string[] = [];

  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data as any;
    
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

    if (data) {
      const errorMsg = data.message || data.error || data.detail || data.msg;
      if (errorMsg) {
        message += `: ${errorMsg}`;
      }
    }

    if (err.code === 'ECONNREFUSED') {
      message = `${EXTENSION_NAME}: Cannot connect to EverMemOS server. Please ensure it's running at ${err.config?.baseURL}`;
      actions = ['Open Settings', 'Retry'];
    } else if (err.code === 'ETIMEDOUT') {
      message = `${EXTENSION_NAME}: Connection timeout. Server may be unresponsive.`;
      actions = ['Retry'];
    }
  } else if (err instanceof Error) {
    message += `: ${err.message}`;
  }

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

async function testConnection(config: EvermemConfig): Promise<boolean> {
  try {
    const client = createClient(config);
    // 正确使用常量 API_ENDPOINTS.HEALTH
    const response = await requestWithRetry(
      client,
      () => client.get(API_ENDPOINTS.HEALTH, { timeout: 5000 })
    );
    return response.status === 200;
  } catch (error) {
    // 如果 /health 端点不存在，尝试访问根路径作为兜底
    try {
      const client = createClient(config);
      const response = await requestWithRetry(
        client,
        () => client.get('/', { timeout: 5000 })
      );
      return response.status < 500;
    } catch {
      return false;
    }
  }
}


// ==================== 类型守卫 ====================
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
function safeTruncate(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) {return text || '';}
  
  // 移除换行符
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
  
  if (breakPoint > maxLength * 0.6) { // 如果有合适的断点
    return truncated.substring(0, breakPoint + 1).trim() + '...';
  }
  
  return truncated.trim() + '...';
}

// ==================== 核心功能 ====================
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
  
  // 获取文本内容
  const fullText = document.getText();
  const selectedText = selection.isEmpty ? '' : document.getText(selection);
  const text = (selectedText || fullText).trim();

  if (!text) {
    vscode.window.showWarningMessage(
      `${EXTENSION_NAME}: File or selection is empty. Nothing to add as memory.`
    );
    return null;
  }

  // 收集文件元数据
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

async function handleAddMemory(): Promise<void> {
  const config = getConfig();
  if (!config) {
    return;
  }

  // 验证连接
  const isConnected = await testConnection(config);
  if (!isConnected) {
    vscode.window.showErrorMessage(
      `${EXTENSION_NAME}: Cannot connect to server at ${config.apiBaseUrl}. Please check your configuration.`,
      'Open Settings'
    );
    return;
  }

  const selection = getCurrentSelectionOrFile();
  if (!selection) {
    return;
  }

  const { text, meta } = selection;
  const client = createClient(config);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${EXTENSION_NAME}: Adding memory...`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ increment: 30 });
        
        const response = await requestWithRetry(client, () =>
          client.post(API_ENDPOINTS.MEMORIES, {
            content: text,
            meta,
            tags: ['vscode', meta.file_info.language || 'unknown'],
            source: 'vscode-extension',
          })
        );

        progress.report({ increment: 70 });

        const responseData = response.data;
        let memory: MemoryItem | undefined;
        let memoryId = 'unknown';

        // 安全地提取内存数据
        if (isApiResponse<MemoryItem>(responseData) && responseData.data) {
          memory = responseData.data;
        } else if (isMemoryItem(responseData)) {
          memory = responseData;
        }

        if (memory) {
          memoryId = memory.id || memory.memory_id || 'unknown';
        }

        const memoryUrl = `${config.apiBaseUrl}/memories/${memoryId}`;

        vscode.window.showInformationMessage(
          `${EXTENSION_NAME}: Memory added successfully!`,
          'View Details'
        ).then(selection => {
          if (selection === 'View Details') {
            vscode.env.openExternal(vscode.Uri.parse(memoryUrl));
          }
        });
      }
    );
  } catch (error) {
    handleError(error, 'Add memory');
  }
}

async function handleQuickRecap(): Promise<void> {
  const config = getConfig();
  if (!config) {
    return;
  }

  const client = createClient(config);

  // 获取用户输入的问题
  const question = await vscode.window.showInputBox({
    title: `${EXTENSION_NAME}: Quick Recap`,
    prompt: 'Optional: Ask a specific question (leave empty for general recap)',
    placeHolder: 'e.g., What did I work on yesterday? What are my recent discoveries?',
    ignoreFocusOut: true,
  });

  // 用户取消输入
  if (question === undefined) {
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${EXTENSION_NAME}: Generating recap...`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ increment: 20, message: 'Connecting to server...' });

        const response = await requestWithRetry(
          client,
          () =>
            client.post(API_ENDPOINTS.RECAP, {
              question: question?.trim() || undefined,
              context: {
                workspace: vscode.workspace.name,
                timestamp: new Date().toISOString(),
              },
            }),
          2,
          1000
        );

        if (token.isCancellationRequested) {
          return;
        }

        progress.report({ increment: 60, message: 'Processing response...' });

        const responseData = response.data;
        let recap = 'No recap content available.';

        // 安全地提取recap数据
        if (isApiResponse<RecapResponse>(responseData) && responseData.data) {
          const recapData = responseData.data;
          recap = recapData.recap || recapData.summary || JSON.stringify(recapData, null, 2);
        } else if (isRecapResponse(responseData)) {
          recap = responseData.recap || responseData.summary || JSON.stringify(responseData, null, 2);
        } else if (typeof responseData === 'string') {
          recap = responseData;
        } else if (responseData && typeof responseData === 'object') {
          recap = JSON.stringify(responseData, null, 2);
        }

        progress.report({ increment: 20, message: 'Opening recap...' });

        // 创建并显示 markdown 文档
        const markdownContent = `# ${EXTENSION_NAME} Recap\n\n${
          question ? `## Question: ${question}\n\n` : ''
        }${recap}\n\n---\n*Generated at ${new Date().toLocaleString()}*`;

        const doc = await vscode.workspace.openTextDocument({
          content: markdownContent,
          language: 'markdown',
        });

        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
          preview: true,
          preserveFocus: false,
        });

        vscode.window.showInformationMessage(
          `${EXTENSION_NAME}: Recap generated successfully!`
        );
      }
    );
  } catch (error) {
    handleError(error, 'Quick recap');
  }
}

async function handleProjectOverview(): Promise<void> {
  const config = getConfig();
  if (!config) {
    return;
  }

  const client = createClient(config);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${EXTENSION_NAME}: Fetching project overview...`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ increment: 30 });

        const response = await requestWithRetry(client, () =>
          client.get(API_ENDPOINTS.OVERVIEW, {
            params: {
              workspace: vscode.workspace.name,
              include_stats: true,
            },
          })
        );

        if (token.isCancellationRequested) {
          return;
        }

        progress.report({ increment: 50 });

        const responseData = response.data;
        let overview = 'No overview content available.';
        let stats: { project_count?: number; memory_count?: number; last_updated?: string } = {};

        // 安全地提取overview数据
        if (isApiResponse<OverviewResponse>(responseData) && responseData.data) {
          const overviewData = responseData.data;
          overview = overviewData.overview || JSON.stringify(overviewData, null, 2);
          stats = {
            project_count: overviewData.project_count,
            memory_count: overviewData.memory_count,
            last_updated: overviewData.last_updated,
          };
        } else if (isOverviewResponse(responseData)) {
          overview = responseData.overview || JSON.stringify(responseData, null, 2);
          stats = {
            project_count: responseData.project_count,
            memory_count: responseData.memory_count,
            last_updated: responseData.last_updated,
          };
        } else if (typeof responseData === 'string') {
          overview = responseData;
        } else if (responseData && typeof responseData === 'object') {
          overview = JSON.stringify(responseData, null, 2);
        }

        progress.report({ increment: 20 });

        // 创建 markdown 内容
        let markdownContent = `# ${EXTENSION_NAME} Project Overview\n\n`;

        if (stats.project_count !== undefined || stats.memory_count !== undefined) {
          markdownContent += `## Statistics\n`;
          if (stats.project_count !== undefined) {
            markdownContent += `- Total Projects: ${stats.project_count}\n`;
          }
          if (stats.memory_count !== undefined) {
            markdownContent += `- Total Memories: ${stats.memory_count}\n`;
          }
          if (stats.last_updated) {
            markdownContent += `- Last Updated: ${new Date(stats.last_updated).toLocaleString()}\n`;
          }
          markdownContent += '\n';
        }

        markdownContent += `## Overview\n${overview}\n\n---\n*Generated at ${new Date().toLocaleString()}*`;

        const doc = await vscode.workspace.openTextDocument({
          content: markdownContent,
          language: 'markdown',
        });

        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
          preview: true,
          preserveFocus: false,
        });

        vscode.window.showInformationMessage(
          `${EXTENSION_NAME}: Project overview loaded successfully!`
        );
      }
    );
  } catch (error) {
    handleError(error, 'Project overview');
  }
}

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
    let params: Record<string, any> = { limit: 100 };

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
        params.search = searchTerm.trim();
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

        const response = await requestWithRetry(client, () =>
          client.get(API_ENDPOINTS.MEMORIES, { params })
        );

        if (token.isCancellationRequested) {
          return;
        }

        progress.report({ increment: 40 });

        const responseData = response.data;
        let memories: MemoryItem[] = [];

        // 安全地提取记忆列表
        if (isApiResponse<MemoryListResponse | MemoryItem[]>(responseData)) {
          const data = responseData.data || responseData;
          if (Array.isArray(data)) {
            memories = data;
          } else if (isMemoryListResponse(data)) {
            memories = data.items || [];
          }
        } else if (Array.isArray(responseData)) {
          memories = responseData;
        } else if (isMemoryListResponse(responseData)) {
          memories = responseData.items || [];
        }

        if (!memories.length) {
          const message = searchTerm
            ? `No memories found matching "${searchTerm}"`
            : 'No memories found';
          vscode.window.showInformationMessage(`${EXTENSION_NAME}: ${message}`);
          return;
        }

        progress.report({ increment: 30 });

        // 格式化显示项 - 修复变量名错误
        const pickItems = memories.map((memory, index) => {
          const memoryId = memory.id || memory.memory_id || `memory-${index}`;
          const dateStr = memory.created_at || memory.createdAt || '';
          const date = dateStr ? new Date(dateStr) : null;
          
          // 提取内容预览
          const content = memory.content || '';
          const preview = safeTruncate(content, 100);
          
          const filePath = memory.meta?.file_info?.path;
          const fileName = filePath ? ` - ${filePath.split(/[\\/]/).pop()}` : '';

          return {
            label: `$(note) ${preview || '(empty content)'}${fileName}`,
            description: date ? date.toLocaleDateString() + ' ' + date.toLocaleTimeString() : '',
            detail: `ID: ${memoryId}`, // ✅ 修复：使用 memoryId 而不是未定义的 id
            memory,
            alwaysShow: true,
          };
        });

        // 添加查看更多选项（如果有分页）
        const hasMore = isMemoryListResponse(responseData) && responseData.has_more;
        if (hasMore) {
          pickItems.push({
            label: '$(ellipsis) Load more...',
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

        // 处理"加载更多"
        if (picked.label === '$(ellipsis) Load more...') {
          vscode.window.showInformationMessage(`${EXTENSION_NAME}: Pagination not implemented yet`);
          return;
        }

        // 确认删除
        const memory = picked.memory;
        const memoryId = memory.id || memory.memory_id; // ✅ 重新获取 memoryId
        
        if (!memoryId) {
          vscode.window.showErrorMessage(`${EXTENSION_NAME}: Memory ID not found`);
          return;
        }

        const confirmMessage = memory.content
          ? `Delete memory: "${safeTruncate(memory.content, 50)}"?`
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
              await client.delete(`${API_ENDPOINTS.MEMORIES}/${encodeURIComponent(memoryId)}`);
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