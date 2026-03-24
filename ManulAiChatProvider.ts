import * as vscode from 'vscode';
import { WebviewView, WebviewViewProvider, WebviewOptions, Disposable } from 'vscode';

export class ManulAiChatProvider implements WebviewViewProvider {
    private _view?: WebviewView;
    private readonly _onDidChangeViewState = new vscode.EventEmitter<void>();
    public readonly onDidChangeViewState = this._onDidChangeViewState.event;

    public resolveWebviewView(webviewView: WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken): void {
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(this.extensionPath)],
        };

        this._view = webviewView;
    }

    // Other methods and properties...
}