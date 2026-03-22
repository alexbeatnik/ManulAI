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
      await vscode.commands.executeCommand('manulai.chatView.focus');
    })
  );
}

export function deactivate(): void {
  // Nothing to tear down explicitly.
}