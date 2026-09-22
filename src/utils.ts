import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function safeTruncate(text: string, maxLength: number): string {
  const cleanText = text.replace(/[\r\n]+/g, ' ');
  if (cleanText.length <= maxLength) {
    return cleanText;
  }
  const truncated = cleanText.substring(0, maxLength);
  const boundary = Math.max(truncated.lastIndexOf(' '), truncated.lastIndexOf('.'), truncated.lastIndexOf(','));
  return (boundary > maxLength * 0.6 ? truncated.substring(0, boundary + 1) : truncated).trimEnd() + '...';
}

export interface CapturedFile {
  text: string;
  uri: vscode.Uri;
  fileInfo: { path: string; language: string; startLine: number; endLine: number; totalLines: number; selected: boolean };
}

// Read the selection only when requested; keep whitespace and escape sequences intact.
export function getCurrentSelectionOrFile(): CapturedFile | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return null;
  }
  const { document, selection } = editor;
  const text = selection.isEmpty ? document.getText() : document.getText(selection);
  if (!text.trim()) {
    return null;
  }
  return {
    text,
    uri: document.uri,
    fileInfo: {
      path: document.uri.fsPath,
      language: document.languageId,
      startLine: selection.isEmpty ? 0 : selection.start.line,
      endLine: selection.isEmpty ? document.lineCount - 1 : Math.max(selection.start.line, selection.end.line - (selection.end.character === 0 ? 1 : 0)),
      totalLines: document.lineCount,
      selected: !selection.isEmpty,
    },
  };
}

const execFileAsync = promisify(execFile);
export async function getGitBranch(uri?: vscode.Uri): Promise<string | undefined> {
  const folder = uri ? vscode.workspace.getWorkspaceFolder(uri) : vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== 'file') {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: folder.uri.fsPath, timeout: 1500, maxBuffer: 4096, windowsHide: true,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
