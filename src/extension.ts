import * as vscode from 'vscode';
import { EvermemConfigViewProvider } from './sidebar';
import {
  EXTENSION_NAME,
  outputChannel,
} from './config';
import {
  handleAddMemory,
  handleDeleteMemory,
  handleProjectOverview,
  handleQuickRecap,
} from './commands';
import { testConnection, getConfig } from './config';

export function activate(context: vscode.ExtensionContext) {
  console.log(`[${EXTENSION_NAME}] Extension activated`);

  const provider = new EvermemConfigViewProvider(context, {
    testConnection: async () => {
      const config = getConfig();
      if (!config) {
        return false;
      }
      return testConnection(config);
    },
    addMemory: (payload) => handleAddMemory(payload),
    quickRecap: (payload) => handleQuickRecap(payload),
    projectOverview: (payload) => handleProjectOverview(payload),
    deleteMemory: () => handleDeleteMemory(),
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EvermemConfigViewProvider.viewId, provider)
  );

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(outputChannel);
  statusBarItem.text = '$(database) EverMemOS';
  statusBarItem.tooltip = 'Open EverMemOS sidebar';
  statusBarItem.command = 'evermem.openSidebar';
  statusBarItem.show();

  const commands = [
    vscode.commands.registerCommand('evermem.addMemory', () => handleAddMemory()),
    vscode.commands.registerCommand('evermem.quickRecap', () => handleQuickRecap()),
    vscode.commands.registerCommand('evermem.projectOverview', () => handleProjectOverview()),
    vscode.commands.registerCommand('evermem.deleteMemory', () => handleDeleteMemory()),
    vscode.commands.registerCommand('evermem.openSidebar', () => {
      vscode.commands.executeCommand('workbench.view.extension.evermemViewContainer');
    }),
  ];
  commands.forEach((cmd) => context.subscriptions.push(cmd));
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('evermem')) {
        vscode.window
          .showInformationMessage(
            `${EXTENSION_NAME}: Configuration updated. Some changes may require restart.`,
            'Reload Window'
          )
          .then((selection) => {
            if (selection === 'Reload Window') {
              vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
          });
      }
    })
  );

  const config = getConfig();
  if (config) {
    testConnection(config).then((isConnected) => {
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
