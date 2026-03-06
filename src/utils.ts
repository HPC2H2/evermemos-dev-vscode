import * as vscode from 'vscode';
import { EXTENSION_NAME, logOutput } from './config';

export function isApiResponse<T>(obj: any): obj is { success: boolean; data?: T } {
  return obj && typeof obj === 'object' && 'success' in obj;
}

export function safeTruncate(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) {
    return text || '';
  }
  const cleanText = text.replace(/[\r\n]+/g, ' ');
  if (cleanText.length <= maxLength) {
    return cleanText;
  }
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
  if (breakPoint > maxLength * 0.6) {
    return truncated.substring(0, breakPoint + 1).trim() + '...';
  }
  return truncated.trim() + '...';
}

export function getCurrentSelectionOrFile():
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
    vscode.window.showWarningMessage(`${EXTENSION_NAME}: No active editor. Open a file to add memory.`);
    return null;
  }
  const document = editor.document;
  const selection = editor.selection;
  const fullText = document.getText();
  const selectedText = selection.isEmpty ? '' : document.getText(selection);
  const text = (selectedText || fullText).trim();
  if (!text) {
    vscode.window.showWarningMessage(`${EXTENSION_NAME}: File or selection is empty. Nothing to add as memory.`);
    return null;
  }
  const fileInfo = {
    path: document.uri.fsPath,
    language: document.languageId,
    startLine: selection.isEmpty ? 0 : selection.start.line,
    endLine: selection.isEmpty ? document.lineCount - 1 : selection.end.line,
    totalLines: document.lineCount,
    selected: !selection.isEmpty,
    workspace: vscode.workspace.name || undefined,
    workspaceFolders: vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [],
  };
  const meta = {
    source: 'vscode-extension',
    extension_version: '0.1.0',
    captured_at: new Date().toISOString(),
    file_info: fileInfo,
    context: {
      selected_lines: fileInfo.endLine - fileInfo.startLine + 1,
      selection_range: selection.isEmpty
        ? undefined
        : {
            start: { line: selection.start.line, character: selection.start.character },
            end: { line: selection.end.line, character: selection.end.character },
          },
    },
  };
  return { text, meta, fileInfo };
}

export function logUserNote(note?: string) {
  logOutput(`[${EXTENSION_NAME}] optional user note input result`, note ?? '(empty)');
}
