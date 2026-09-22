import * as vscode from 'vscode';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import sql from 'highlight.js/lib/languages/sql';
import { Memory, record, stringValue } from './api';
import { EXTENSION_NAME } from './config';
import { t, htmlLanguage } from './i18n';
import { safeTruncate } from './utils';
import { escapeHtml as esc, nonce, sharedStyles } from './webview';

for (const [name, grammar] of Object.entries({ javascript, typescript, python, json, xml, css, bash, cpp, java, go, rust, yaml, markdown, sql })) {
  hljs.registerLanguage(name, grammar);
}

export interface SearchItem { title: string; code: string; language: string; filePath: string; line: number; branch: string; timestamp: string }
export function toSearchItems(memories: Memory[]): SearchItem[] {
  return memories.map(memory => {
    const metadata = record(memory.metadata);
    const cell = record(metadata.mem_cell ?? metadata.memCell ?? memory.mem_cell);
    const info = record(memory.file_info ?? metadata.file_info);
    const line = cell.startLine ?? info.startLine;
    return {
      title: safeTruncate(stringValue(memory.summary || memory.content) || t('emptyPreview'), 100),
      code: stringValue(cell.codeSnippet ?? memory.content ?? memory.summary),
      language: stringValue(cell.language || info.language || memory.language) || 'plaintext',
      filePath: stringValue(cell.filePath || info.path),
      line: typeof line === 'number' && Number.isFinite(line) ? Math.max(0, Math.floor(line)) : 0,
      branch: stringValue(cell.branch || metadata.branch),
      timestamp: stringValue(memory.timestamp || memory.created_at),
    };
  });
}

export async function insertSnippet(code: string, language: string, target?: vscode.TextEditor): Promise<void> {
  const editor = target && vscode.window.visibleTextEditors.includes(target) ? target : vscode.window.activeTextEditor;
  if (editor) {
    const inserted = await editor.edit(builder => builder.insert(editor.selection.active, code));
    if (!inserted) { throw new Error(t('insertFailed')); }
    void vscode.window.showInformationMessage(`${EXTENSION_NAME}: ${t('inserted')}`);
  } else {
    const languages = await vscode.languages.getLanguages();
    const doc = await vscode.workspace.openTextDocument({ content: code, language: languages.includes(language) ? language : 'plaintext' });
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
    void vscode.window.showInformationMessage(`${EXTENSION_NAME}: ${t('openedSnippet')}`);
  }
}

export function renderResults(items: SearchItem[], revision: number): string {
  const scriptNonce = nonce();
  const aliases: Record<string, string> = { html: 'xml', jsx: 'javascript', tsx: 'typescript', shellscript: 'bash', c: 'cpp', jsonc: 'json' };
  const cards = items.map((item, index) => {
    const preview = item.code.slice(0, 20000);
    const lang = aliases[item.language] || item.language;
    const highlighted = hljs.getLanguage(lang) ? hljs.highlight(preview, { language: lang, ignoreIllegals: true }).value : esc(preview);
    const date = new Date(item.timestamp);
    const timestamp = item.timestamp && !Number.isNaN(date.valueOf()) ? date.toLocaleString(vscode.env.language) : item.timestamp;
    return `<article class="card"><h3>${esc(item.title)}</h3>
      <div class="meta">${esc([item.branch, timestamp].filter(Boolean).join(' · '))}</div>
      ${item.filePath ? `<div class="meta path">${esc(item.filePath)}</div>` : ''}
      <pre><code>${highlighted}</code></pre>
      ${preview.length < item.code.length ? `<p class="hint">${esc(t('previewTruncated'))}</p>` : ''}
      <div class="actions"><button data-action="insert" data-index="${index}">${esc(t('insert'))}</button>
      ${item.filePath ? `<button class="secondary" data-action="open" data-index="${index}">${esc(t('openFile'))}</button>` : ''}</div></article>`;
  }).join('');
  return `<!DOCTYPE html><html lang="${esc(htmlLanguage())}"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${scriptNonce}'; script-src 'nonce-${scriptNonce}';">
    <style nonce="${scriptNonce}">${sharedStyles}
      h3 { margin: 0 0 6px; font-size: 1em; overflow-wrap: anywhere; }
      .path { margin-top: 4px; }
      pre { overflow-x: auto; padding: 10px; background: var(--vscode-textCodeBlock-background); border-radius: 4px; tab-size: 4; }
      code { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
      body { --evermem-keyword: #569cd6; --evermem-string: #ce9178; --evermem-number: #b5cea8; --evermem-function: #dcdcaa; }
      body.vscode-light, body.vscode-high-contrast-light { --evermem-keyword: #0000ff; --evermem-string: #a31515; --evermem-number: #098658; --evermem-function: #795e26; }
      .hljs-keyword, .hljs-selector-tag, .hljs-literal { color: var(--evermem-keyword); }
      .hljs-string, .hljs-attr, .hljs-template-tag { color: var(--evermem-string); }
      .hljs-number, .hljs-built_in, .hljs-type { color: var(--evermem-number); }
      .hljs-title, .hljs-name { color: var(--evermem-function); }
      .hljs-comment { color: var(--vscode-descriptionForeground); font-style: italic; }
    </style></head><body><h2>${esc(t('searchResults'))}</h2><p class="hint">${esc(t('scopeHint'))}</p>
    ${cards || `<p role="status">${esc(t('noMemories'))}</p>`}
    <script nonce="${scriptNonce}">
      const vscode = acquireVsCodeApi();
      document.addEventListener('click', event => {
        const button = event.target.closest('button[data-action]');
        if (button) vscode.postMessage({ type: button.dataset.action, index: Number(button.dataset.index), revision: ${revision} });
      });
    </script></body></html>`;
}

let panel: vscode.WebviewPanel | undefined;
let items: SearchItem[] = [];
let revision = 0;
let targetEditor: vscode.TextEditor | undefined;
export function disposeResults(): void { panel?.dispose(); }

export function showResults(memories: Memory[]): void {
  const active = vscode.window.activeTextEditor;
  if (active) { targetEditor = active; }
  items = toSearchItems(memories);
  revision++;
  if (!panel) {
    panel = vscode.window.createWebviewPanel('evermem.search', `${EXTENSION_NAME}: ${t('searchResults')}`, vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [] });
    const subscription = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      const msg = record(message);
      if (msg.revision !== revision || !Number.isInteger(msg.index) || typeof msg.index !== 'number' || msg.index < 0 || msg.index >= items.length) { return; }
      const item = items[msg.index];
      try {
        if (msg.type === 'insert') {
          await insertSnippet(item.code, item.language, targetEditor);
        } else if (msg.type === 'open' && item.filePath) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.filePath));
          const editor = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
          targetEditor = editor;
          const position = new vscode.Position(Math.min(item.line, doc.lineCount - 1), 0);
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        }
      } catch (error) {
        const message = msg.type === 'open' ? t('openFailed', item.filePath) : error instanceof Error ? error.message : t('actionFailed');
        void vscode.window.showErrorMessage(`${EXTENSION_NAME}: ${message}`);
      }
    });
    panel.onDidDispose(() => { subscription.dispose(); panel = undefined; items = []; targetEditor = undefined; });
  }
  panel.webview.html = renderResults(items, revision);
  panel.reveal(panel.viewColumn, false);
}
