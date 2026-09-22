import * as vscode from 'vscode';
import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { ActionResult, EXTENSION_ID, EXTENSION_NAME, getConfig, isCancelled, logOutput, throwIfCancelled, withCancellation } from './config';
import { Memory, MemoryApi, memoryScope, record, stringValue, unwrap } from './api';
import { getCurrentSelectionOrFile, getGitBranch, safeTruncate } from './utils';
import { showResults } from './results';
import { MessageKey, t } from './i18n';

const cancelled = (): ActionResult => ({ ok: false, cancelled: true, message: t('cancelled') });
const success = (message: string): ActionResult => {
  void vscode.window.showInformationMessage(`${EXTENSION_NAME}: ${message}`);
  return { ok: true, message };
};

export function handleError(error: unknown): ActionResult {
  if (isCancelled(error)) { return cancelled(); }
  let message = error instanceof Error ? error.message : t('actionFailed');
  let settings = false;
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 401 || status === 403) { message = t('authFailed'); settings = true; }
    else if (status === 404 || status === 405) { message = t('endpointMissing'); }
    else if (status) { message = t('httpError', status); }
    else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') { message = t('timeout'); }
    else { message = t('connectionFailed'); }
    logOutput(t('actionFailed'), { status, code: error.code });
  }
  const action = t('openSettings');
  void vscode.window.showErrorMessage(`${EXTENSION_NAME}: ${message}`, ...(settings ? [action] : [])).then(choice => {
    if (choice === action) { void vscode.commands.executeCommand('workbench.action.openSettings', EXTENSION_ID); }
  });
  return { ok: false, message };
}

function progress<T>(title: MessageKey, fn: (signal: AbortSignal) => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${EXTENSION_NAME}: ${t(title)}`, cancellable: true },
    (_progress, token) => withCancellation(token, fn));
}

export interface AddMemoryOptions { text?: string; note?: string; useSelection?: boolean }
export async function handleAddMemory(options?: AddMemoryOptions): Promise<ActionResult> {
  const config = getConfig();
  if (!config) { return { ok: false, message: t('configMissing') }; }
  try {
    let text = options?.text || '';
    // Explicit text wins. No editor reads or file metadata when capture is disabled.
    const captured = !text.trim() && options?.useSelection !== false ? getCurrentSelectionOrFile() : null;
    if (captured) { text = captured.text; }
    if (!text.trim()) {
      const input = await vscode.window.showInputBox({ title: t('addMemory'), prompt: t('enterContent'), ignoreFocusOut: true });
      if (input === undefined) { return cancelled(); }
      text = input;
      if (!text.trim()) { return { ok: false, message: t('emptyContent') }; }
    }
    const note = options?.note ?? await vscode.window.showInputBox({
      title: t('optionalNote'), prompt: t('notePrompt'), placeHolder: t('notePlaceholder'), ignoreFocusOut: true,
    });
    if (note === undefined) { return cancelled(); }
    if (note.trim()) { text += `\n\n[${t('userNote')}]\n${note.trim()}`; }
    const branch = captured ? await getGitBranch(captured.uri) : undefined;
    const scope = memoryScope();
    const payload = {
      message_id: `vscode-${randomUUID()}`, create_time: new Date().toISOString(), sender: scope.user_id,
      content: text, group_id: scope.group_id, group_name: scope.group_id, role: 'user', flush: true,
      metadata: {
        branch, workspace: vscode.workspace.name,
        ...(captured ? {
          file_info: captured.fileInfo,
          mem_cell: {
            type: /error|exception/i.test(text) ? 'bug' : 'code',
            filePath: captured.fileInfo.path, language: captured.fileInfo.language, codeSnippet: captured.text,
            startLine: captured.fileInfo.startLine, endLine: captured.fileInfo.endLine,
            branch, workspace: vscode.workspace.name, selected: captured.fileInfo.selected,
          },
        } : {}),
      },
    };
    // Writes are not cancellable/retried: a timeout does not prove the write failed.
    const data = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${EXTENSION_NAME}: ${t('adding')}`, cancellable: false }, () => new MemoryApi(config).add(payload));
    const result = unwrap(data);
    const outer = record(data);
    const envelope = record(outer.data);
    const requestId = stringValue(outer.request_id || envelope.request_id || result.request_id);
    const queued = result.status_info === 'accumulated' || result.count === 0 || /queued|processing|accepted/i.test(stringValue(result.message));
    logOutput(t('submitted'), { requestId });
    return success(queued && requestId ? t('queued', requestId) : t('submitted'));
  } catch (error) { return handleError(error); }
}

export async function handleQuickRecap(options?: { query?: string; openDocument?: boolean }): Promise<ActionResult> {
  const config = getConfig();
  if (!config) { return { ok: false, message: t('configMissing') }; }
  const query = options?.query ?? await vscode.window.showInputBox({ title: t('searchMemories'), prompt: t('queryPrompt'), placeHolder: t('queryPlaceholder'), ignoreFocusOut: true });
  if (query === undefined) { return cancelled(); }
  try {
    const page = await progress('searching', async signal => {
      const result = await new MemoryApi(config).search(query, signal);
      throwIfCancelled(signal);
      if (options?.openDocument !== false) { showResults(result.memories); }
      return result;
    });
    return success(t('searchDone', page.memories.length));
  } catch (error) { return handleError(error); }
}

function overviewMarkdown(memories: Memory[], total: number): string {
  const scope = memoryScope();
  const lines = [`# ${EXTENSION_NAME}: ${t('overview')}`, '', `- ${t('total')}: ${total}`, `- ${t('user')}: ${scope.user_id}`, `- ${t('group')}: ${scope.group_id || t('none')}`, '', `## ${t('latestItems')}`, ''];
  for (const [index, memory] of memories.entries()) {
    lines.push(`### ${index + 1}`, `- ${t('memoryType')}: ${stringValue(memory.memory_type) || t('unknown')}`,
      `- ${t('timestamp')}: ${stringValue(memory.timestamp || memory.created_at) || t('unknown')}`, '', stringValue(memory.summary || memory.content), '');
  }
  return lines.join('\n');
}
let overviewUri: vscode.Uri | undefined;
let overviewContent: string | undefined;
export async function handleProjectOverview(options?: { pageSize?: number; openDocument?: boolean }): Promise<ActionResult> {
  const config = getConfig();
  if (!config) { return { ok: false, message: t('configMissing') }; }
  try {
    const pageSize = Math.max(1, Math.min(100, Math.floor(options?.pageSize || 100)));
    const page = await progress('loadingOverview', async signal => {
      const result = await new MemoryApi(config).list(1, pageSize, signal);
      throwIfCancelled(signal);
      if (options?.openDocument !== false) {
        const content = overviewMarkdown(result.memories, result.total);
        // Reuse the generated overview when it has not been edited by the user.
        let doc = vscode.workspace.textDocuments.find(document => document.uri.toString() === overviewUri?.toString());
        if (!doc || doc.getText() !== overviewContent) {
          doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
        } else {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
          if (!await vscode.workspace.applyEdit(edit)) { doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' }); }
        }
        overviewUri = doc.uri;
        overviewContent = content;
        throwIfCancelled(signal);
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: true });
      }
      return result;
    });
    return success(t('overviewDone', page.memories.length, page.total));
  } catch (error) { return handleError(error); }
}

function localizedStatus(value: unknown): string {
  const status = stringValue(value);
  const keys: Record<string, MessageKey> = { accepted: 'statusAccepted', queued: 'statusQueued', pending: 'statusQueued', processing: 'statusProcessing', completed: 'statusCompleted', success: 'statusCompleted', failed: 'statusFailed' };
  return keys[status] ? t(keys[status]) : status || t('unknown');
}

export async function handleDeleteMemory(): Promise<ActionResult> {
  const config = getConfig();
  if (!config) { return { ok: false, message: t('configMissing') }; }
  const api = new MemoryApi(config);
  try {
    const method = await vscode.window.showQuickPick([
      { label: `$(search) ${t('searchMemories')}`, description: t('byKeyword'), value: 'search' },
      { label: `$(list-unordered) ${t('recent')}`, description: t('recentHint'), value: 'recent' },
      { label: `$(history) ${t('requestStatus')}`, description: t('requestStatusHint'), value: 'status' },
    ], { placeHolder: t('findToDelete'), ignoreFocusOut: true });
    if (!method) { return cancelled(); }
    let query = '';
    if (method.value === 'search') {
      const input = await vscode.window.showInputBox({ prompt: t('queryPrompt'), placeHolder: t('queryPlaceholder'), ignoreFocusOut: true });
      if (input === undefined) { return cancelled(); }
      query = input.trim();
    } else if (method.value === 'status') {
      const id = await vscode.window.showInputBox({ prompt: t('requestIdPrompt'), ignoreFocusOut: true });
      if (!id?.trim()) { return cancelled(); }
      const status = await progress('checkingStatus', signal => api.status(id.trim(), signal));
      void vscode.window.showInformationMessage(`${EXTENSION_NAME}: ${t('statusResult', id.trim(), localizedStatus(status.status))}`);
    }
    let pageNumber = 1;
    let memory: Memory | undefined;
    while (!memory) {
      const page = await progress('loadingMemories', signal => query ? api.search(query, signal) : api.list(pageNumber, 100, signal));
      if (!page.memories.length) {
        const message = page.pending.length ? t('pending', page.pending.length) : t('noMemories');
        void vscode.window.showInformationMessage(`${EXTENSION_NAME}: ${message}`);
        return { ok: false, message };
      }
      const items: Array<vscode.QuickPickItem & { memory?: Memory; more?: boolean }> = page.memories.map(item => ({
        label: `$(note) ${safeTruncate(stringValue(item.summary || item.content), 100) || t('emptyPreview')}`,
        description: stringValue(item.timestamp || item.created_at),
        detail: `ID: ${stringValue(item.event_id || item.id || item.memory_id) || t('unknown')}`, memory: item,
      }));
      if (page.hasMore && !query) { items.push({ label: `$(ellipsis) ${t('loadMore')}`, more: true }); }
      if (query && page.hasMore) { void vscode.window.showInformationMessage(t('refineSearch', page.memories.length)); }
      const picked = await vscode.window.showQuickPick(items, { placeHolder: t('selectToDelete'), ignoreFocusOut: true, matchOnDescription: true, matchOnDetail: true });
      if (!picked) { return cancelled(); }
      if (picked.more) { pageNumber++; continue; }
      memory = picked.memory;
    }
    const id = stringValue(memory.event_id || memory.id || memory.memory_id);
    if (!id) { throw new Error(t('missingMemoryId')); }
    const preview = safeTruncate(stringValue(memory.summary || memory.content) || id, 80);
    const confirm = t('delete');
    const choice = await vscode.window.showWarningMessage(t('confirmDelete', preview), { modal: true, detail: t('irreversible') }, confirm);
    if (choice !== confirm) { return cancelled(); }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${EXTENSION_NAME}: ${t('deleting')}`, cancellable: false }, () => api.delete(id));
    return success(t('deleted'));
  } catch (error) { return handleError(error); }
}
