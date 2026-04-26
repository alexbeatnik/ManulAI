import * as vscode from 'vscode';
import { ManulAiChatParticipant } from './copilotChatParticipant';
import { SettingsPanel } from './settingsPanel';

let output: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('ManulAI Copilot');
  context.subscriptions.push(output);

  // Register Copilot Chat participant (@manulai)
  try {
    const participant = vscode.chat.createChatParticipant(
      'manulai.manulai',
      new ManulAiChatParticipant({ output, extensionContext: context }).buildHandler()
    );
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'manulai-icon.svg');
    participant.followupProvider = {
      provideFollowups: () => [
        { prompt: 'Continue.', label: '$(arrow-right) Continue', command: undefined },
      ],
    };
    context.subscriptions.push(participant);
    output.appendLine('[activate] chat participant registered: manulai.manulai');
  } catch (err: any) {
    output.appendLine(`[activate] chat participant registration failed: ${err?.message || err}`);
  }

  // Register Settings webview view in Activity Bar
  const settingsPanel = new SettingsPanel(context.extensionUri, output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SettingsPanel.viewType, settingsPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manulai.selectModel', async () => {
      await vscode.commands.executeCommand('manulai.settings.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manulai.openSettings', async () => {
      await vscode.commands.executeCommand('manulai.settings.focus');
    })
  );

  // Tool approval buttons
  context.subscriptions.push(
    vscode.commands.registerCommand('manulai.approveTool', async () => {
      await context.globalState.update('manulai.autoApproveState', true);
      await context.globalState.update('manulai.pendingApproval', false);
      vscode.window.showInformationMessage('✅ ManulAI: Auto-approve enabled. Type any message to continue.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manulai.declineTool', async () => {
      await context.globalState.update('manulai.autoApproveState', false);
      await context.globalState.update('manulai.pendingApproval', false);
      vscode.window.showInformationMessage('❌ ManulAI: Tool declined. Auto-approve is off.');
    })
  );
}

export function deactivate(): void {
  // Nothing to tear down explicitly.
}
