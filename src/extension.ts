import * as vscode from 'vscode';
import { ManulAiChatProvider } from './ManulAiChatProvider';

class ManulAiLauncherProvider implements vscode.TreeDataProvider<string> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<string | undefined>();

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public getTreeItem(element: string): vscode.TreeItem {
    return new vscode.TreeItem(element);
  }

  public getChildren(): string[] {
    return [];
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ManulAiChatProvider(context);
  const launcherProvider = new ManulAiLauncherProvider();

  const openSecondarySidebar = async (): Promise<void> => {
    const commandsToTry = [
      'workbench.action.focusAuxiliaryBar',
      'workbench.view.extension.manulai'
    ];

    for (const command of commandsToTry) {
      try {
        await vscode.commands.executeCommand(command);
      } catch {
        // Ignore unavailable commands and keep trying the next way to reveal the sidebar.
      }
    }
  };

  const openChat = async (): Promise<void> => {
    await openSecondarySidebar();

    try {
      await vscode.commands.executeCommand('manulai.chatView.focus');
    } catch {
      // Ignore and fall back to the provider reveal.
    }

    provider.reveal(false);
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ManulAiChatProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );

  context.subscriptions.push(vscode.window.registerTreeDataProvider('manulai.launcherView', launcherProvider));

  context.subscriptions.push(
    vscode.commands.registerCommand('manulai.openChat', async () => {
      await openChat();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manulai.openSecondarySidebar', async () => {
      await openSecondarySidebar();
      provider.reveal(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manulai.attachFile', async (...args: unknown[]) => {
      let uris: vscode.Uri[] = [];

      // When invoked from Explorer context menu, VS Code passes the clicked URI as the first arg
      // and all selected URIs as the second arg.
      if (args.length >= 2 && Array.isArray(args[1])) {
        uris = (args[1] as vscode.Uri[]).filter(u => u instanceof vscode.Uri);
      } else if (args.length >= 1 && args[0] instanceof vscode.Uri) {
        uris = [args[0]];
      }

      if (uris.length === 0) {
        // Fallback: attach active editor file
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        if (activeUri) {
          uris = [activeUri];
        }
      }

      if (uris.length === 0) {
        void vscode.window.showWarningMessage('No file selected to attach.');
        return;
      }

      await provider.attachFilesByUri(uris);
      await openChat();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manulai.attachActiveFile', async () => {
      await provider.attachActiveEditorFile();
      await openChat();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manulai.attachExplorerSelection', async () => {
      await provider.attachExplorerSelectionFromClipboard();
      await openChat();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manulai.attachFolder', async (...args: unknown[]) => {
      let uri: vscode.Uri | undefined;
      if (args.length >= 1 && args[0] instanceof vscode.Uri) {
        uri = args[0];
      }
      if (uri) {
        await provider.attachFolderByUri(uri);
      }
      await openChat();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manulai.selectModel', async () => {
      await provider.refreshModelCatalog(true);

      const currentModel = provider.getSelectedModel();
      const availableModels = provider.getAvailableModels().map(model => ({
        label: model,
        description: model === currentModel ? 'Current model' : undefined
      }));

      if (availableModels.length === 0) {
        void vscode.window.showWarningMessage('No Ollama models were found. Check the local Ollama server and try again.');
        return;
      }

      const selected = await vscode.window.showQuickPick(availableModels, {
        title: 'Select Ollama model for ManulAI',
        placeHolder: 'Choose a local Ollama model'
      });

      if (!selected) {
        return;
      }

      await provider.setSelectedModel(selected.label);
      await openChat();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async event => {
      if (event.affectsConfiguration('manulai.ollamaBaseUrl') || event.affectsConfiguration('manulai.ollamaModel') || event.affectsConfiguration('manulai.agentMode') || event.affectsConfiguration('manulai.autoApprove')) {
        await provider.handleConfigurationChange();
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      provider.handleActiveEditorChange();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      provider.handleActiveEditorChange();
    })
  );

  void openChat();
}

export function deactivate(): void {
  // Nothing to tear down explicitly.
}