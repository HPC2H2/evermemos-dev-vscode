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

// ==================== 接口定义 ====================
// ts问号表示可选属性，| undefined 是冗余的，可以省略

// Evemem插件的全局配置
interface EvermemConfig {
  apiBaseUrl: string;
  authToken?: string;
} 

// 单条记忆（memory）的数据结构
interface MemoryItem {
  id: string;
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
// 所有后端API路径，ts中使用 as const推断为字面量类型（其实就是常量）
const API_ENDPOINTS = {
  MEMORIES: '/api/v1/memories',
  RECAP: '/api/v1/memories/recap',
  OVERVIEW: '/api/v1/memories/overview',
  HEALTH: '/health',
  MEMORIES_SEARCH: '/api/v1/memories/search',
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
 * @param client 已配置的 Axios 实例
 * @param requesrtFn 实际执行请求的函数，应该返回一个 Promise
 * @param maxRetries 最大重试次数，默认2次
 * @param baseDelay 基础延迟时间，单位毫秒，默认1000ms
 * @returns 请求成功时的响应数据
 * @throws 最后一次请求失败的错误
*/
async function requestWithRetry<T>(
  client: AxiosInstance,
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

  // 获取当前选区或文件内容，以及相关的元信息
  const selection = getCurrentSelectionOrFile();
  if (!selection) {
    return;
  }

  // 解构出文本和元信息，准备发送给后端
  const { text, meta } = selection;
  // 创建 Axios 客户端实例，以向服务器发起请求
  const client = createClient(config);

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

  // 创建 Axios 客户端实例，以向服务器发起请求
  const client = createClient(config);

  // 弹出输入框获取用户输入的问题
  const question = await vscode.window.showInputBox({
    title: `${EXTENSION_NAME}: Quick Recap`,
    prompt: 'Optional: Ask a specific question (leave empty for general recap)',
    placeHolder: 'e.g., What did I work on yesterday? What are my recent discoveries?',
    ignoreFocusOut: true,
  });

  // 如果用户取消输入，则直接推出
  if (question === undefined) {
    return;
  }

  try {
    // 显示进度条，并尝试连接服务器请求recap
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${EXTENSION_NAME}: Generating recap...`, // 进度条标题
        cancellable: true, // 用户可取消
      },
      async (progress, token) => {
        // 更新进度，报告当前任务正在连接服务器
        progress.report({ increment: 20, message: 'Connecting to server...' });
        
        // 使用指数退避机制发送请求，来获取 recap 数据
        const response = await requestWithRetry(
          client,
          () =>
            client.post(API_ENDPOINTS.RECAP, { // 向服务区发送 POST 请求
              question: question?.trim() || undefined, // 用户输入的问题，未输入则使用服务端定义的默认值
              context: {
                workspace: vscode.workspace.name, // 当前工作区名称
                timestamp: new Date().toISOString(), // 请求时间戳
              },
            }),
          2, // 最大重试 2 次
          1000 // 基础延迟 1000ms
        );

        // 如果用户取消了操作，直接退出
        if (token.isCancellationRequested) {
          return;
        }

        // 更新进度，报告正在处理服务器响应
        progress.report({ increment: 60, message: 'Processing response...' });

        // 从响应数据中提取 recap 内容，支持多种格式
        const responseData = response.data;
        let recap = 'No recap content available.'; // 默认值，如果没有可用 recap 则显示此文本

        // 尝试通过不同方式提取 recap 数据
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

        //更新进度，报告即将打开生成的 recap
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
          viewColumn: vscode.ViewColumn.Beside, // 在编辑器旁边打开
          preview: true, // 启用预览模式
          preserveFocus: false, // 自动聚焦到新打开的文档上
        });

        //显示信息提示 recap 创建完成
        vscode.window.showInformationMessage(
          `${EXTENSION_NAME}: Recap generated successfully!`
        );
      }
    );
  } catch (error) {
    // 捕获错误并调用错误处理逻辑
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

  // 创建 Axios 客户端实例，以向服务器发起请求
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
          const dateStr = memory.created_at || '';
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