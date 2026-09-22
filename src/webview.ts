import { randomBytes } from 'node:crypto';

export const nonce = () => randomBytes(18).toString('base64');
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export const sharedStyles = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; margin: 0; }
  h2 { margin: 0 0 8px; font-size: 1.25em; }
  button { font: inherit; cursor: pointer; border-radius: 5px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 7px 10px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .6; cursor: wait; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .card { min-width: 0; padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; margin-bottom: 12px; background: var(--vscode-editor-background); }
  .hint, .meta { color: var(--vscode-descriptionForeground); font-size: .9em; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
`;
