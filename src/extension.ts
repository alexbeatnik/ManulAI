import * as vscode from 'vscode';
import { ManulAiChatProvider } from './ManulAiChatProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ManulAiChatProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ManulAiChatProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manulai.openChat', async () => {
      const commandsToTry = [
        'workbench.view.extension.manulai',
        'workbench.action.focusAuxiliaryBar',
        'manulai.chatView.focus'
      ];

      for (const command of commandsToTry) {
        try {
          await vscode.commands.executeCommand(command);
        } catch {
          // Ignore unavailable commands and keep trying the next way to reveal the chat.
        }
      }

      provider.reveal(false);
    })
  );

  void vscode.commands.executeCommand('manulai.openChat');
}

export function deactivate(): void {
  // Nothing to tear down explicitly.
}