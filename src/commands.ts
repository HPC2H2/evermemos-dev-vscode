import * as vscode from 'vscode';
import axios from 'axios';
import {
  ActionResult,
  API_PATHS,
  EXTENSION_ID,
  EXTENSION_NAME,
  createClient,
  getConfig,
  getPreferredApiVersion,
  logOutput,
  orderPaths,
  requestWithRetry,
  testConnection,
} from './config';
import { getCurrentSelectionOrFile, isApiResponse, safeTruncate, logUserNote } from './utils';

const isZh = (vscode.env.language || '').toLowerCase().startsWith('zh');
const L = (en: string, zh: string) => (isZh ? zh : en);

function handleError(err: unknown, context: string): void {
  console.error(`[${EXTENSION_NAME}] ${context} failed:`, err);
  let message = `${EXTENSION_NAME}: ${context} failed`;
  let actions: string[] = [];

  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data as any;
    const serializedData = data ? (typeof data === 'string' ? data : JSON.stringify(data, null, 2)) : undefined;

    console.error(`[${EXTENSION_NAME}] HTTP error detail:`, {
      url: err.config?.url,
      method: err.config?.method,
      status,
      headers: err.response?.headers,
      data,
    });

    if (status === 401) {
      message = `${EXTENSION_NAME}: Authentication failed. Please check your API key.`;
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
      } else if (serializedData) {
        message += ` | Detail: ${serializedData}`;
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

  vscode.window.showErrorMessage(message, ...actions).then((selection) => {
    if (selection === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', EXTENSION_ID);
    } else if (selection === 'Retry') {
      const commandMap: Record<string, string> = {
        addmemory: 'evermem.addMemory',
        quickrecap: 'evermem.quickRecap',
        projectoverview: 'evermem.projectOverview',
        deletememory: 'evermem.deleteMemory',
      };
      const commandKey = context.toLowerCase().replace(/\s+/g, '');
      const command = commandMap[commandKey];
      if (command) {
        vscode.commands.executeCommand(command);
      }
    }
  });
}

export async function handleAddMemory(options?: { text?: string; note?: string; useSelection?: boolean }): Promise<ActionResult> {
  const config = getConfig();
  if (!config) {
    return { ok: false, message: L('Configuration missing', '配置缺失') };
  }

  const isConnected = await testConnection(config);
  if (!isConnected) {
    vscode.window.showErrorMessage(
      `${EXTENSION_NAME}: ${L('Cannot connect to server at', '无法连接到服务器')} ${config.apiBaseUrl}. ${L('Please check your configuration.', '请检查配置。')}`,
      L('Open Settings', '打开设置')
    );
    return { ok: false, message: L('Connection failed', '连接失败') };
  }

  let text = options?.text?.trim() || '';
  const useSelection = options?.useSelection !== false;
  const selection = useSelection ? getCurrentSelectionOrFile() : null;
  if (!text && selection?.text) {
    text = selection.text;
  }
  if (!text) {
    const input = await vscode.window.showInputBox({
      title: `${EXTENSION_NAME}: ${L('Add memory', '添加记忆')}`,
      prompt: L('Enter content to add (leave blank to cancel)', '输入要添加的内容（留空取消）'),
      ignoreFocusOut: true,
    });
    if (!input) {
      return { ok: false, message: L('No input', '未输入内容') };
    }
    text = input.trim();
  }

  const extraInput =
    options?.note ??
    (await vscode.window.showInputBox({
      title: `${EXTENSION_NAME}: ${L('Optional note', '可选补充文本')}`,
      prompt: L('Optional; will be submitted with selection/text', '可留空；若填写，将与选中文本一起提交'),
      placeHolder: L('e.g., This code initializes config', '例如：本段代码用于初始化配置'),
      value: '',
      valueSelection: [0, 0],
      ignoreFocusOut: true,
    }) ?? '');
  logUserNote(extraInput);
  if (extraInput && extraInput.trim()) {
    text = `${text}\n\n[User Note]\n${extraInput.trim()}`;
  }

  const client = createClient(config);
  const preferredVersion = getPreferredApiVersion(config.apiBaseUrl);
  const memoriesPaths = orderPaths(API_PATHS.MEMORIES, preferredVersion);
  const userId = vscode.env.machineId || 'vscode-user';
  const groupId = vscode.workspace.name ? `vscode-${vscode.workspace.name}` : undefined;

  try {
    logOutput(`[${EXTENSION_NAME}] start add memory`);
    let tip = `${EXTENSION_NAME}: Memory submitted.`;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${EXTENSION_NAME}: ${L('Adding memory...', '正在添加记忆...')}`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ increment: 30 });
        const payload: Record<string, any> = {
          message_id: `vscode-${Date.now()}`,
          create_time: new Date().toISOString(),
          sender: userId,
          content: text,
          group_id: groupId,
          group_name: groupId,
          role: 'user',
          flush: true,
        };
        logOutput(`[${EXTENSION_NAME}] add payload`, payload);

        let response: any;
        let lastError: any;
        for (const path of memoriesPaths) {
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
        logOutput(`[${EXTENSION_NAME}] add response`, responseData);

        const isApi = isApiResponse<any>(responseData);
        const payloadResult = isApi ? (responseData as any).data?.result : (responseData as any).result;
        const requestId =
          (responseData as any).request_id ||
          (isApi ? (responseData as any).data?.request_id : undefined) ||
          'unknown';
        const statusText =
          (responseData as any).status ||
          (isApi ? (responseData as any).data?.status : undefined) ||
          'accepted';
        const statusInfo = payloadResult?.status_info;
        const count = payloadResult?.count;
        const messageText = isApi ? (responseData as any).data?.message : (responseData as any).message;

        const isQueued =
          statusInfo === 'accumulated' ||
          count === 0 ||
          (typeof messageText === 'string' &&
            (/queued/i.test(messageText) || /processing in background/i.test(messageText) || /accepted/i.test(messageText)));

        tip = isQueued
          ? `${EXTENSION_NAME}: 已排队等待处理。request_id: ${requestId}`
          : `${EXTENSION_NAME}: Memory ${statusText}. request_id: ${requestId}`;

        vscode.window.showInformationMessage(tip);
      }
    );
    return { ok: true, message: L('Memory submitted', '记忆提交成功') };
  } catch (error) {
    handleError(error, 'Add memory');
    return { ok: false, message: (error as Error)?.message };
  }
}

export async function handleQuickRecap(options?: { query?: string; openDocument?: boolean }): Promise<ActionResult> {
  const config = getConfig();
  if (!config) {
    return { ok: false, message: L('Configuration missing', '配置缺失') };
  }

  const client = createClient(config);
  const preferredVersion = getPreferredApiVersion(config.apiBaseUrl);
  const searchPaths = orderPaths(API_PATHS.MEMORIES_SEARCH, preferredVersion);
  const memoriesPaths = orderPaths(API_PATHS.MEMORIES, preferredVersion);
    const query = options?.query ??
      (await vscode.window.showInputBox({
        title: `${EXTENSION_NAME}: ${L('Search memories', '搜索记忆')}`,
        prompt: L('Enter keyword (blank returns recent)', '输入搜索关键词（留空则返回最近的记忆）'),
        placeHolder: L('e.g., coffee preference', '例如：登录失败'),
        ignoreFocusOut: true,
      }));

  if (query === undefined) {
    return { ok: false, message: L('Cancelled', '已取消') };
  }

  try {
    logOutput(`[${EXTENSION_NAME}] start search`, { query: query || '(recent)' });
    let summaryMessage = `${EXTENSION_NAME}: ${L('Search completed', '搜索完成')}`;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${EXTENSION_NAME}: ${L('Searching memories...', '正在搜索记忆...')}`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ increment: 20, message: L('Calling search API...', '正在调用搜索接口...') });

        const groupId = vscode.workspace.name ? `vscode-${vscode.workspace.name}` : undefined;
        const basePayload = {
          query: query?.trim() || undefined,
          user_id: vscode.env.machineId || undefined,
          group_id: groupId,
          group_ids: groupId ? [groupId] : undefined,
          include_metadata: true,
          top_k: 100,
        };

        const payloadCandidates = [basePayload];
        if (basePayload.group_id) {
          payloadCandidates.push({ ...basePayload, group_id: undefined, group_ids: undefined });
        }
        payloadCandidates.push({ ...basePayload, user_id: undefined, group_id: undefined, group_ids: undefined });

        let resp: any;
        let lastErr: any;
        let had404 = false;
        let usedMethod: string = 'GET';
        let usedPayload: any = payloadCandidates[0];
        const extractCount = (data: any) => {
          const result = (data as any)?.result || (isApiResponse<any>(data) ? (data as any).data : data) || {};
          const rawMemories: any[] = result?.memories || [];
          const flattened: any[] = [];
          rawMemories.forEach((group) => {
            if (group?.episodic_memory && Array.isArray(group.episodic_memory)) {
              flattened.push(...group.episodic_memory);
            } else if (Array.isArray(group)) {
              flattened.push(...group);
            } else if (group) {
              flattened.push(group);
            }
          });
          return flattened.length;
        };

        outerSearchAll: for (const candidate of payloadCandidates) {
          resp = undefined;
          lastErr = undefined;

          // GET first
          for (const path of searchPaths) {
            try {
              const r = await requestWithRetry(() => client.get(path, { params: candidate }));
              const count = extractCount(r?.data);
              resp = r;
              usedMethod = 'GET';
              usedPayload = candidate;
              if (count > 0) {
                break outerSearchAll;
              }
              break; // got a response, stop trying other paths for this candidate
            } catch (err) {
              lastErr = err;
              if (axios.isAxiosError(err) && err.response?.status === 404) {
                had404 = true;
                console.warn(`[${EXTENSION_NAME}] ${path} (GET) not found, trying next path...`);
                continue;
              }
              // other errors -> try next candidate or POST
            }
          }

          if (!resp) {
            for (const path of searchPaths) {
              try {
                const r = await requestWithRetry(() => client.post(path, candidate));
                const count = extractCount(r?.data);
                resp = r;
                usedMethod = 'POST';
                usedPayload = candidate;
                if (count > 0) {
                  break outerSearchAll;
                }
                break; // got a response, stop trying other paths for this candidate
              } catch (err) {
                lastErr = err;
                if (axios.isAxiosError(err) && err.response?.status === 404) {
                  had404 = true;
                  console.warn(`[${EXTENSION_NAME}] ${path} (POST) not found, trying next path...`);
                  continue;
                }
                throw err;
              }
            }
          }
        }
        if (!resp && had404) {
          // Fallback: list memories when search endpoint is missing
          for (const path of memoriesPaths) {
            try {
              const listResp = await requestWithRetry(() =>
                client.get(path, {
                  params: {
                    user_id: vscode.env.machineId || undefined,
                    group_id: groupId,
                    group_ids: groupId ? [groupId] : undefined,
                    memory_type: 'episodic_memory',
                    page: 1,
                    page_size: 100,
                  },
                })
              );
              resp = listResp;
              usedMethod = 'GET(memories)';
              usedPayload = { fallback: true };
              break;
            } catch (err) {
              lastErr = err;
              if (axios.isAxiosError(err) && err.response?.status === 404) {
                console.warn(`[${EXTENSION_NAME}] ${path} fallback not found, trying next...`);
                continue;
              }
              throw err;
            }
          }
        }

        if (!resp && lastErr) {
          throw lastErr;
        }
        logOutput(`[${EXTENSION_NAME}] search used`, { method: usedMethod, payload: usedPayload });

        if (token.isCancellationRequested) {
          return;
        }

        progress.report({ increment: 50, message: L('Rendering results...', '正在渲染结果...') });

        const data = resp?.data || {};
        const result = (data as any).result || (isApiResponse<any>(data) ? (data as any).data : data);
        const rawMemories: any[] = result?.memories || [];
        const flattened: any[] = [];
        rawMemories.forEach((group) => {
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

        let md = `# ${EXTENSION_NAME} ${L('Search Results', '搜索结果')}\n\n`;
        md += `- ${L('Query', '查询')}: ${query || L('(recent)', '（最近）')}\n- ${L('Total', '总数')}: ${total}\n\n`;

        if (flattened.length) {
          md += `## ${L('Memories', '记忆')}\n`;
          flattened.forEach((m, idx) => {
            md += `### #${idx + 1}\n- ${L('user_id', '用户ID')}: ${m.user_id || ''}\n- ${L('group_id', '群组ID')}: ${m.group_id || ''}\n- ${L('type', '类型')}: ${m.memory_type || ''}\n- ${L('timestamp', '时间戳')}: ${m.timestamp || ''}\n- ${L('summary/content', '摘要/内容')}: ${m.summary || m.content || ''}\n\n`;
          });
        }

        if (profiles.length) {
          md += `## ${L('Profiles', '画像')}\n`;
          profiles.forEach((p, idx) => {
            md += `### ${L('Profile', '画像')} #${idx + 1}\n- ${L('category', '类别')}: ${p.category || ''}\n- ${L('trait', '特征')}: ${p.trait_name || ''}\n- ${L('score', '得分')}: ${p.score ?? ''}\n- ${L('description', '描述')}: ${p.description || ''}\n\n`;
          });
        }

        summaryMessage = `${EXTENSION_NAME}: ${L(`Search completed, ${flattened.length} memories`, `搜索完成，${flattened.length} 条记忆`)}`;

        if (options?.openDocument !== false) {
          const doc = await vscode.workspace.openTextDocument({
            content: md,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.Beside,
            preview: true,
            preserveFocus: false,
          });
        }

        vscode.window.showInformationMessage(summaryMessage);
      }
    );
    return { ok: true, message: summaryMessage };
  } catch (error) {
    handleError(error, 'Quick recap');
    return { ok: false, message: (error as Error)?.message };
  }
}

export async function handleProjectOverview(options?: { pageSize?: number; openDocument?: boolean }): Promise<ActionResult> {
  const config = getConfig();
  if (!config) {
    return { ok: false, message: L('Configuration missing', '配置缺失') };
  }

  const client = createClient(config);
  const preferredVersion = getPreferredApiVersion(config.apiBaseUrl);
  const memoriesPaths = orderPaths(API_PATHS.MEMORIES, preferredVersion);

  try {
    let summaryMessage = `${EXTENSION_NAME}: ${L('Memories overview loaded.', '记忆概览已加载')}`;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${EXTENSION_NAME}: ${L('Fetching memories overview...', '正在获取记忆概览...')}`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ increment: 30 });

        const groupId = vscode.workspace.name ? `vscode-${vscode.workspace.name}` : undefined;
        const pageSize = Math.min(options?.pageSize ?? 100, 100);
        const params = {
          user_id: vscode.env.machineId || undefined,
          group_id: groupId,
          group_ids: groupId ? [groupId] : undefined,
          memory_type: 'episodic_memory',
          page: 1,
          page_size: pageSize,
        } as Record<string, any>;

        const paramsList = [params];
        if (params.group_id) {
          paramsList.push({ ...params, group_id: undefined, group_ids: undefined });
        }

        let resp: any;
        let lastErr: any;
        outer: for (const p of paramsList) {
          for (const path of memoriesPaths) {
            try {
              resp = await requestWithRetry(() => client.get(path, { params: p }));
              lastErr = undefined;
              break outer;
            } catch (err) {
              lastErr = err;
              if (axios.isAxiosError(err) && err.response?.status === 404) {
                console.warn(`[${EXTENSION_NAME}] ${path} not found, trying next path...`);
                continue;
              }
              throw err;
            }
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

        let md = `# ${EXTENSION_NAME} ${L('Memories Overview', '记忆概览')}\n\n`;
        md += `- ${L('Total memories', '记忆总数')}: ${total}\n`;
        md += `- ${L('User', '用户')}: ${params.user_id || 'n/a'}\n`;
        md += `- ${L('Group', '群组')}: ${params.group_id || 'n/a'}\n`;
        if (metadata.memory_type) {
          md += `- ${L('memory_type', '记忆类型')}: ${metadata.memory_type}\n`;
        }
        md += `\n## ${L('Latest items', '最新条目')}\n`;

        memories.forEach((m, idx) => {
          md += `### #${idx + 1}\n- ${L('user_id', '用户ID')}: ${m.user_id || ''}\n- ${L('group_id', '群组ID')}: ${m.group_id || ''}\n- ${L('request_id', '请求ID')}: ${m.request_id || m.message_id || ''}\n- ${L('type', '类型')}: ${m.memory_type || ''}\n- ${L('timestamp', '时间戳')}: ${m.timestamp || ''}\n- ${L('summary/content', '摘要/内容')}: ${m.summary || m.content || ''}\n\n`;
        });

        summaryMessage = `${EXTENSION_NAME}: ${L(`Overview done, ${memories.length} items, Total ${total}`, `概览完成，${memories.length} 条，Total ${total}`)}`;

        if (options?.openDocument !== false) {
          const doc = await vscode.workspace.openTextDocument({
            content: md,
            language: 'markdown',
          });

          await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.Beside,
            preview: true,
            preserveFocus: false,
          });
        }

        vscode.window.showInformationMessage(summaryMessage);
      }
    );
    return { ok: true, message: summaryMessage };
  } catch (error) {
    handleError(error, 'Project overview');
    return { ok: false, message: (error as Error)?.message };
  }
}

export async function handleDeleteMemory(): Promise<ActionResult> {
  const config = getConfig();
  if (!config) {
    return { ok: false, message: L('Configuration missing', '配置缺失') };
  }

  const client = createClient(config);
  const preferredVersion = getPreferredApiVersion(config.apiBaseUrl);
  const searchPaths = orderPaths(API_PATHS.MEMORIES_SEARCH, preferredVersion);
  const memoriesPaths = orderPaths(API_PATHS.MEMORIES, preferredVersion);
  let result: ActionResult = { ok: false, message: L('Cancelled', '已取消') };

  try {
    const searchMethod = await vscode.window.showQuickPick(
      [
        { label: `$(search) ${L('Search memories', '搜索记忆')}`, description: L('Search by keyword', '按关键词搜索'), value: 'search' },
        { label: `$(list-unordered) ${L('View recent memories', '查看最近记忆')}`, description: L('Show latest memories', '显示最近的记忆'), value: 'recent' },
        { label: `$(device-camera) ${L('Refresh last add (by request_id)', '按 request_id 刷新最近添加')}`, description: L('Check request status then search', '查询请求状态后再搜索'), value: 'status' },
      ],
      {
        placeHolder: L('How would you like to find memories?', '选择查找记忆的方式'),
        ignoreFocusOut: true,
      }
    );

    if (!searchMethod) {
      return result;
    }

    let searchTerm: string | undefined;
    const searchPayload: Record<string, any> = {
      user_id: vscode.env.machineId || undefined,
      group_id: vscode.workspace.name ? `vscode-${vscode.workspace.name}` : undefined,
      group_ids: vscode.workspace.name ? [`vscode-${vscode.workspace.name}`] : undefined,
      top_k: 100,
      include_metadata: true,
    };
    const searchPayloads = [searchPayload];
    if (searchPayload.group_id) {
      searchPayloads.push({ ...searchPayload, group_id: undefined, group_ids: undefined });
    }
    searchPayloads.push({ ...searchPayload, user_id: undefined, group_id: undefined, group_ids: undefined });

    if (searchMethod.value === 'search') {
      searchTerm = await vscode.window.showInputBox({
      prompt: L('Enter search term (optional)', '输入搜索关键词（可选）'),
      placeHolder: L('Type to search memories...', '输入关键词搜索记忆'),

        ignoreFocusOut: true,
      });
      if (searchTerm === undefined) {
        return result;
      }
      if (searchTerm.trim()) {
        searchPayload.query = searchTerm.trim();
      }
    }

    if (searchMethod.value === 'status') {
      const reqId = await vscode.window.showInputBox({
        prompt: 'Enter request_id returned by Add memory',
        placeHolder: 'req-xxx or uuid',
        ignoreFocusOut: true,
      });
      if (!reqId) {
        return result;
      }
      try {
        let statusResp: any;
        let lastStatusErr: any;
        let had404 = false;
        for (const path of API_PATHS.REQUEST_STATUS) {
          try {
            statusResp = await requestWithRetry(() => client.get(path, { params: { request_id: reqId } }));
            lastStatusErr = undefined;
            break;
          } catch (err) {
            lastStatusErr = err;
            if (axios.isAxiosError(err) && err.response?.status === 404) {
              had404 = true;
              console.warn(`[${EXTENSION_NAME}] ${path} not found, trying next path...`);
              continue;
            }
            throw err;
          }
        }
        if (!statusResp && lastStatusErr) {
          throw lastStatusErr;
        }
        if (!statusResp && had404) {
          vscode.window.showInformationMessage(`${EXTENSION_NAME}: ${L('request status API not available on this server', '请求状态接口不可用')}`);
        } else {
          const statusData = statusResp?.data?.data || statusResp?.data || {};
          const statusText = statusData.status || 'unknown';
          vscode.window.showInformationMessage(`${EXTENSION_NAME}: ${L('request', '请求')} ${reqId} ${L('status', '状态')} = ${statusText}`);
        }
      } catch (err) {
        handleError(err, 'Request status');
        return result;
      }
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${EXTENSION_NAME}: ${L('Loading memories...', '正在加载记忆...')}`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ increment: 30 });

        let resp: any;
        let lastErr: any;
        let had404 = false;
        let usedPayload: any = searchPayloads[0];
        let usedMethod: string = 'GET';
        const extractCounts = (data: any) => {
          const responseData = data || {};
          const resultData =
            (responseData as any).result || (isApiResponse<any>(responseData) ? (responseData as any).data : responseData);
          const rawMemories: any[] = resultData?.memories || [];
          const pending: any[] = resultData?.pending_messages || [];
          const flattened: any[] = [];
          rawMemories.forEach((group) => {
            if (group?.episodic_memory && Array.isArray(group.episodic_memory)) {
              flattened.push(...group.episodic_memory);
            } else if (Array.isArray(group)) {
              flattened.push(...group);
            } else if (group) {
              flattened.push(group);
            }
          });
          return { count: flattened.length, pendingCount: Array.isArray(pending) ? pending.length : 0 };
        };

        outerSearch: for (const candidate of searchPayloads) {
          resp = undefined;
          lastErr = undefined;

          // GET first
          for (const path of searchPaths) {
            try {
              const r = await requestWithRetry(() => client.get(path, { params: candidate }));
              const { count, pendingCount } = extractCounts(r?.data);
              resp = r;
              usedPayload = candidate;
              usedMethod = 'GET';
              if (count > 0 || pendingCount > 0) {
                break outerSearch;
              }
              break; // got a response, stop trying other paths for this candidate
            } catch (err) {
              lastErr = err;
              if (axios.isAxiosError(err)) {
                const status = err.response?.status;
                const data = err.response?.data;
                logOutput(`[${EXTENSION_NAME}] search error on ${path} (GET, status ${status ?? 'n/a'})`, data);
                if (status === 404) {
                  had404 = true;
                  console.warn(`[${EXTENSION_NAME}] ${path} not found, trying next path...`);
                  continue;
                }
              }
            }
          }

          if (!resp) {
            for (const path of searchPaths) {
              try {
                const r = await requestWithRetry(() => client.post(path, candidate));
                const { count, pendingCount } = extractCounts(r?.data);
                resp = r;
                usedPayload = candidate;
                usedMethod = 'POST';
                if (count > 0 || pendingCount > 0) {
                  break outerSearch;
                }
                break; // got a response, stop trying other paths for this candidate
              } catch (err) {
                lastErr = err;
                if (axios.isAxiosError(err)) {
                  const status = err.response?.status;
                  const data = err.response?.data;
                  logOutput(`[${EXTENSION_NAME}] search error on ${path} (POST, status ${status ?? 'n/a'})`, data);
                  if (status === 404) {
                    had404 = true;
                    console.warn(`[${EXTENSION_NAME}] ${path} not found, trying next path...`);
                    continue;
                  }
                }
                throw err;
              }
            }
          }
        }
        if (!resp && had404) {
          // Fallback: list memories when search endpoint is missing
          for (const path of memoriesPaths) {
            try {
              const listResp = await requestWithRetry(() =>
                client.get(path, {
                  params: {
                    user_id: vscode.env.machineId || undefined,
                    group_id: vscode.workspace.name ? `vscode-${vscode.workspace.name}` : undefined,
                    group_ids: vscode.workspace.name ? [`vscode-${vscode.workspace.name}`] : undefined,
                    memory_type: 'episodic_memory',
                    page: 1,
                    page_size: 100,
                  },
                })
              );
              resp = listResp;
              usedPayload = { fallback: true };
              usedMethod = 'GET(memories)';
              break;
            } catch (err) {
              lastErr = err;
              if (axios.isAxiosError(err) && err.response?.status === 404) {
                console.warn(`[${EXTENSION_NAME}] ${path} fallback not found, trying next...`);
                continue;
              }
              throw err;
            }
          }
        }

        if (!resp && lastErr) {
          throw lastErr;
        }
        if (!resp) {
          result = { ok: false, message: L('No response from search', '搜索接口无响应') };
          return;
        }
        logOutput(`[${EXTENSION_NAME}] search used payload`, { usedPayload, method: usedMethod });

        if (token.isCancellationRequested) {
          result = { ok: false, message: L('Cancelled', '已取消') };
          return;
        }

        progress.report({ increment: 40 });

        const responseData = resp?.data || {};
        logOutput(`[${EXTENSION_NAME}] search response`, responseData);
        const resultData =
          (responseData as any).result || (isApiResponse<any>(responseData) ? (responseData as any).data : responseData);
        const rawMemories: any[] = resultData?.memories || [];
        const pending: any[] = resultData?.pending_messages || [];
        const flattened: any[] = [];
        rawMemories.forEach((group) => {
          if (group?.episodic_memory && Array.isArray(group.episodic_memory)) {
            flattened.push(...group.episodic_memory);
          } else if (Array.isArray(group)) {
            flattened.push(...group);
          } else if (group) {
            flattened.push(group);
          }
        });

        if (!flattened.length) {
          if (pending.length) {
            const mdPending = pending
              .map(
                (p, idx) =>
                  `### Pending #${idx + 1}\n- request_id: ${p.request_id || ''}\n- message_id: ${p.message_id || ''}\n- group_id: ${p.group_id || ''}\n- user_id: ${p.user_id || ''}\n- content: ${p.content || ''}\n`
              )
              .join('\n');
            const doc = await vscode.workspace.openTextDocument({
              content: `# ${EXTENSION_NAME} ${L('Pending Messages', '待处理消息')}\n\n${mdPending}`,
              language: 'markdown',
            });
            await vscode.window.showTextDocument(doc, {
              viewColumn: vscode.ViewColumn.Beside,
              preview: true,
              preserveFocus: false,
            });
            vscode.window.showInformationMessage(
              `${EXTENSION_NAME}: ${L('No extracted memories yet, pending messages: ', '尚无已提取记忆，待处理条数：')}${pending.length}`
            );
            result = { ok: false, message: L('No extracted memories yet', '尚无已提取记忆') };
            return;
          }

          const message = searchTerm
            ? L(`No memories found matching "${searchTerm}"`, `未找到匹配 "${searchTerm}" 的记忆`)
            : L('No memories found', '未找到记忆');
          vscode.window.showInformationMessage(`${EXTENSION_NAME}: ${message}`);
          result = { ok: false, message };
          return;
        }

        if (!resp) {
          const msg = L('No response from search', '搜索接口无响应');
          result = { ok: false, message: msg };
          vscode.window.showWarningMessage(`${EXTENSION_NAME}: ${msg}`);
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
            label: `$(note) ${preview || L('(empty content)', '（无内容）')}`,
            description: date ? date.toLocaleDateString() + ' ' + date.toLocaleTimeString() : '',
            detail: `ID: ${memoryId}`,
            memory,
            alwaysShow: true,
          };
        });

        const hasMore = resultData?.has_more;
        if (hasMore) {
          pickItems.push({
            label: '$(ellipsis) Load more (not implemented)',
            description: '',
            detail: '',
            memory: {},
            alwaysShow: true,
          });
        }

        const picked = await vscode.window.showQuickPick(pickItems, {
          placeHolder: L('Select a memory to delete', '选择要删除的记忆'),
          ignoreFocusOut: true,
          matchOnDescription: true,
          matchOnDetail: true,
        });

        if (!picked) {
          result = { ok: false, message: L('Cancelled', '已取消') };
          return;
        }

        if (picked.label.startsWith('$(ellipsis)')) {
          const msg = L('Pagination not implemented yet', '分页未实现');
          vscode.window.showInformationMessage(`${EXTENSION_NAME}: ${msg}`);
          result = { ok: false, message: msg };
          return;
        }

        const memory = picked.memory;
        const memoryId = memory.id || memory.memory_id || memory.event_id;
        if (!memoryId) {
          const msg = L('Memory ID not found', '未找到记忆 ID');
          vscode.window.showErrorMessage(`${EXTENSION_NAME}: ${msg}`);
          result = { ok: false, message: msg };
          return;
        }

        const confirmMessage = memory.summary || memory.content
          ? L(`Delete memory: "${safeTruncate(memory.summary || memory.content, 50)}"?`, `删除记忆："${safeTruncate(memory.summary || memory.content, 50)}"？`)
          : L(`Delete memory ${memoryId}?`, `删除记忆 ${memoryId}？`);

        const confirm = await vscode.window.showWarningMessage(
          confirmMessage,
          { modal: true, detail: 'This action cannot be undone.' },
          'Delete'
        );

        if (confirm !== 'Delete') {
          result = { ok: false, message: L('Delete cancelled', '已取消删除') };
          return;
        }

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
              const body = {
                event_id: memoryId,
                user_id: vscode.env.machineId || undefined,
                group_id: vscode.workspace.name ? `vscode-${vscode.workspace.name}` : undefined,
              };
              const logAttempt = (method: string, path: string, note?: string) =>
                logOutput(`[${EXTENSION_NAME}] delete attempt ${method} ${path}${note ? ` (${note})` : ''}`);

              // Official: DELETE /api/v0/memories with body (preferred), fallback to query params
              if (!deleteResp) {
                for (const path of memoriesPaths) {
                  logAttempt('DELETE', path, 'body');
                  try {
                    deleteResp = await requestWithRetry(() => client.delete(path, { data: body }));
                    delErr = undefined;
                    break;
                  } catch (err) {
                    delErr = err;
                    if (axios.isAxiosError(err) && err.response?.status === 404) {
                      console.warn(`[${EXTENSION_NAME}] ${path} (body) not found, trying query...`);
                      continue;
                    }
                  }
                }
              }

              if (!deleteResp) {
                for (const path of memoriesPaths) {
                  logAttempt('DELETE', `${path}?event_id=${memoryId}`, 'query');
                  try {
                    deleteResp = await requestWithRetry(() => client.delete(path, { params: body }));
                    delErr = undefined;
                    break;
                  } catch (err) {
                    delErr = err;
                    if (axios.isAxiosError(err) && err.response?.status === 404) {
                      console.warn(`[${EXTENSION_NAME}] ${path} (query) not found, stopping...`);
                      continue;
                    }
                  }
                }
              }

              if (!deleteResp && delErr) {
                if (axios.isAxiosError(delErr) && delErr.response?.status === 404) {
                  vscode.window.showWarningMessage(
                    `${EXTENSION_NAME}: 删除接口不可用，云端可能未开放删除，请检查服务器版本或配置。`
                  );
                }
                throw delErr;
              }
            }
          );

          const msg = L('Memory deleted successfully', '删除成功');
          vscode.window.showInformationMessage(`${EXTENSION_NAME}: ${msg}`, { modal: false });
          result = { ok: true, message: msg };
        } catch (err) {
          handleError(err, 'Delete memory');
          result = { ok: false, message: (err as Error)?.message };
        }
      }
    );
  } catch (error) {
    handleError(error, 'Delete memory');
    result = { ok: false, message: (error as Error)?.message };
  }

  return result;
}

export { handleError };
