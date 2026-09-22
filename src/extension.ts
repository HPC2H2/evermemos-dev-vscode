import * as vscode from 'vscode';
import { EvermemConfigViewProvider } from './sidebar';
import { configError, EXTENSION_NAME, isCancelled, outputChannel, readConfig, testConnection, withCancellation } from './config';
import { handleAddMemory, handleDeleteMemory, handleError, handleProjectOverview, handleQuickRecap } from './commands';
import { clearApiRouteCache } from './api';
import { disposeResults, insertSnippet } from './results';
import { t } from './i18n';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new EvermemConfigViewProvider({
    testConnection: async () => {
      const config = readConfig();
      const message = configError(config);
      if (message) { return { ok: false, message }; }
      try {
        const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${EXTENSION_NAME}: ${t('statusTesting')}`, cancellable: true },
          (_progress, token) => withCancellation(token, signal => testConnection(config, signal)));
        return { ok, message: t(ok ? 'connectionOk' : 'connectionFail') };
      } catch (error) {
        return isCancelled(error) ? { ok: false, cancelled: true, message: t('cancelled') } : { ok: false, message: t('connectionFail') };
      }
    },
    addMemory: handleAddMemory, quickRecap: handleQuickRecap, projectOverview: handleProjectOverview, deleteMemory: handleDeleteMemory,
  });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(database) EverMemOS';
  statusBar.tooltip = t('openSidebar');
  statusBar.command = 'evermem.openSidebar';
  statusBar.show();
  context.subscriptions.push(
    outputChannel, statusBar, provider,
    vscode.window.registerWebviewViewProvider(EvermemConfigViewProvider.viewId, provider),
    vscode.commands.registerCommand('evermem.addMemory', () => handleAddMemory()),
    vscode.commands.registerCommand('evermem.quickRecap', () => handleQuickRecap()),
    vscode.commands.registerCommand('evermem.projectOverview', () => handleProjectOverview()),
    vscode.commands.registerCommand('evermem.deleteMemory', () => handleDeleteMemory()),
    vscode.commands.registerCommand('evermem.openSidebar', () => vscode.commands.executeCommand('workbench.view.extension.evermemViewContainer')),
    vscode.commands.registerCommand('evermem.insertSnippet', async (_event: unknown, code?: string) => {
      if (typeof code !== 'string') { return; }
      try { await insertSnippet(code, 'plaintext'); } catch (error) { handleError(error); }
    }),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('evermem')) { clearApiRouteCache(); } }),
  );
  // Opening the sidebar should not show an error or send network traffic before the user acts.
}

export function deactivate(): void { disposeResults(); clearApiRouteCache(); }
