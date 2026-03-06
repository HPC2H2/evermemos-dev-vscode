import * as vscode from 'vscode';
import axios from 'axios';
import {
  ActionResult,
  API_PATHS,
  EXTENSION_ID,
  EXTENSION_NAME,
  createClient,
  getConfig,
  logOutput,
  requestWithRetry,
  testConnection,
} from './config';
import { getCurrentSelectionOrFile, isApiResponse, safeTruncate, logUserNote } from './utils';

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
    return { ok: false, message: '配置缺失' };
  }

  const isConnected = await testConnection(config);
  if (!isConnected) {
    vscode.window.showErrorMessage(
      `${EXTENSION_NAME}: Cannot connect to server at ${config.apiBaseUrl}. Please check your configuration.`,
      'Open Settings'
    );
    return { ok: false, message: '连接失败' };
  }

  let text = options?.text?.trim() || '';
  const useSelection = options?.useSelection !== false;
  const selection = useSelection ? getCurrentSelectionOrFile() : null;
  if (!text && selection?.text) {
    text = selection.text;
  }
  if (!text) {
    const input = await vscode.window.showInputBox({
      title: `${EXTENSION_NAME}: Add memory`,
      prompt: '输入要添加的内容（留空取消）',
      ignoreFocusOut: true,
    });
    if (!input) {
      return { ok: false, message: '未输入内容' };
    }
    text = input.trim();
  }

  const extraInput =
    options?.note ??
    (await vscode.window.showInputBox({
      title: `${EXTENSION_NAME}: 可选补充文本`,
      prompt: '可留空；若填写，将与选中文本一起提交',
      placeHolder: '例如：本段代码用于初始化配置',
      value: '',
      valueSelection: [0, 0],
      ignoreFocusOut: true,
    }) ?? '');
  logUserNote(extraInput);
  if (extraInput && extraInput.trim()) {
    text = `${text}\n\n[User Note]\n${extraInput.trim()}`;
  }

  const client = createClient(config);
  const userId = vscode.env.machineId || 'vscode-user';
  const groupId = vscode.workspace.name ? `vscode-${vscode.workspace.name}` : undefined;

  try {
    logOutput(`[${EXTENSION_NAME}] start add memory`);
    let tip = `${EXTENSION_NAME}: Memory submitted.`;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${EXTENSION_NAME}: Adding memory...`,
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
        for (const path of API_PATHS.MEMORIES) {
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
    return { ok: true, message: '记忆提交成功' };
  } catch (error) {
    handleError(error, 'Add memory');
    return { ok: false, message: (error as Error)?.message };
  }
}

export async function handleQuickRecap(options?: { query?: string; openDocument?: boolean }): Promise<ActionResult> {
  const config = getConfig();
  if (!config) {
    return { ok: false, message: '配置缺失' };
  }

  const client = createClient(config);
  const query = options?.query ??
    (await vscode.window.showInputBox({
      title: `${EXTENSION_NAME}: Search memories`,
      prompt: '输入搜索关键词（留空则返回最近的记忆）',
      placeHolder: 'e.g., coffee preference',
      ignoreFocusOut: true,
    }));
  if (query === undefined) {
    return { ok: false, message: '已取消' };
  }

  try {
    logOutput(`[${EXTENSION_NAME}] start search`, { query: query || '(recent)' });
    let summaryMessage = `${EXTENSION_NAME}: Search completed`;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${EXTENSION_NAME}: Searching memories...`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ increment: 20, message: 'Calling search API...' });

        const groupId = vscode.workspace.name ? `vscode-${vscode.workspace.name}` : undefined;
        const basePayload = {
          query: query?.trim() || undefined,
          user_id: vscode.env.machineId || undefined,
          group_id: groupId,
          group_ids: groupId ? [groupId] : undefined,
          include_metadata: true,
          top_k: 20,
        };

        const payloadCandidates = [basePayload];
        if (basePayload.group_id) {
          payloadCandidates.push({ ...basePayload, group_id: undefined, group_ids: undefined });
        }

        let resp: any;
        let lastErr: any;
        for (const candidate of payloadCandidates) {
          for (const path of API_PATHS.MEMORIES_SEARCH) {
            try {
              resp = await requestWithRetry(() => client.get(path, { params: candidate }));
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
          if (resp) {
            break;
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

        summaryMessage = `${EXTENSION_NAME}: 搜索完成，${flattened.length} 条记忆`;

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
    return { ok: false, message: '配置缺失' };
  }

  const client = createClient(config);

  try {
    let summaryMessage = `${EXTENSION_NAME}: Memories overview loaded.`;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${EXTENSION_NAME}: Fetching memories overview...`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ increment: 30 });

        const groupId = vscode.workspace.name ? `vscode-${vscode.workspace.name}` : undefined;
        const params = {
          user_id: vscode.env.machineId || undefined,
          group_id: groupId,
          group_ids: groupId ? [groupId] : undefined,
          memory_type: 'episodic_memory',
          page: 1,
          page_size: options?.pageSize ?? 40,
        } as Record<string, any>;

        const paramsList = [params];
        if (params.group_id) {
          paramsList.push({ ...params, group_id: undefined, group_ids: undefined });
        }

        let resp: any;
        let lastErr: any;
        outer: for (const p of paramsList) {
          for (const path of API_PATHS.MEMORIES) {
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

        summaryMessage = `${EXTENSION_NAME}: 概览完成，${memories.length} 条，Total ${total}`;

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
    return { ok: false, message: '配置缺失' };
  }

  const client = createClient(config);
  let result: ActionResult = { ok: false, message: '已取消' };

  try {
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
      return result;
    }

    let searchTerm: string | undefined;
    const searchPayload: Record<string, any> = {
      user_id: vscode.env.machineId || undefined,
      group_id: vscode.workspace.name ? `vscode-${vscode.workspace.name}` : undefined,
      top_k: 50,
    };
    const searchPayloads = [searchPayload];
    if (searchPayload.group_id) {
      searchPayloads.push({ ...searchPayload, group_id: undefined });
    }

    if (searchMethod.value === 'search') {
      searchTerm = await vscode.window.showInputBox({
        prompt: 'Enter search term (optional)',
        placeHolder: 'Type to search memories...',
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
        if (!statusResp && had404) {
          vscode.window.showInformationMessage(`${EXTENSION_NAME}: request status API not available on this server`);
        } else {
          const statusData = statusResp?.data?.data || statusResp?.data || {};
          const statusText = statusData.status || 'unknown';
          vscode.window.showInformationMessage(`${EXTENSION_NAME}: request ${reqId} status = ${statusText}`);
        }
      } catch (err) {
        handleError(err, 'Request status');
        return result;
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
        let usedPayload = searchPayloads[0];
        outerSearch: for (const candidate of searchPayloads) {
          for (const path of API_PATHS.MEMORIES_SEARCH) {
            try {
              resp = await requestWithRetry(() => client.get(path, { params: candidate }));
              usedPayload = candidate;
              lastErr = undefined;
              break outerSearch;
            } catch (err) {
              lastErr = err;
              if (axios.isAxiosError(err)) {
                const status = err.response?.status;
                const data = err.response?.data;
                logOutput(`[${EXTENSION_NAME}] search error on ${path} (status ${status ?? 'n/a'})`, data);
                if (status === 404) {
                  console.warn(`[${EXTENSION_NAME}] ${path} not found, trying next path...`);
                  continue;
                }
              }
              throw err;
            }
          }
        }
        if (!resp && lastErr) {
          throw lastErr;
        }
        logOutput(`[${EXTENSION_NAME}] search used payload`, usedPayload);

        if (token.isCancellationRequested) {
          result = { ok: false, message: '已取消' };
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
              content: `# ${EXTENSION_NAME} Pending Messages\n\n${mdPending}`,
              language: 'markdown',
            });
            await vscode.window.showTextDocument(doc, {
              viewColumn: vscode.ViewColumn.Beside,
              preview: true,
              preserveFocus: false,
            });
            vscode.window.showInformationMessage(`${EXTENSION_NAME}: No extracted memories yet, ${pending.length} pending messages.`);
            result = { ok: false, message: '尚无已提取记忆' };
            return;
          }

          const message = searchTerm ? `No memories found matching "${searchTerm}"` : 'No memories found';
          vscode.window.showInformationMessage(`${EXTENSION_NAME}: ${message}`);
          result = { ok: false, message };
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
          placeHolder: 'Select a memory to delete',
          ignoreFocusOut: true,
          matchOnDescription: true,
          matchOnDetail: true,
        });

        if (!picked) {
          result = { ok: false, message: '已取消' };
          return;
        }

        if (picked.label.startsWith('$(ellipsis)')) {
          vscode.window.showInformationMessage(`${EXTENSION_NAME}: Pagination not implemented yet`);
          result = { ok: false, message: '分页未实现' };
          return;
        }

        const memory = picked.memory;
        const memoryId = memory.id || memory.memory_id || memory.event_id;
        if (!memoryId) {
          vscode.window.showErrorMessage(`${EXTENSION_NAME}: Memory ID not found`);
          result = { ok: false, message: 'Memory ID not found' };
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
          result = { ok: false, message: '已取消删除' };
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
              for (const path of API_PATHS.MEMORIES) {
                try {
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

          vscode.window.showInformationMessage(`${EXTENSION_NAME}: Memory deleted successfully.`, { modal: false });
          result = { ok: true, message: 'Memory deleted successfully' };
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
