import * as vscode from "vscode";
import { GraphData } from "./analyzer";

export interface PanelCallbacks {
  onMessage?: (message: any) => void;
  onDispose?: () => void;
}

export class GraphPanel {
  public static currentPanel: GraphPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private callbacks: PanelCallbacks = {};
  private initialized = false;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message) => {
        if (message.command === "openFile") {
          const uri = vscode.Uri.file(message.filePath);
          vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One });
        }
        this.callbacks.onMessage?.(message);
      },
      null,
      this.disposables
    );
  }

  static show(
    extensionUri: vscode.Uri,
    graphData: GraphData,
    focusLabel: string,
    callbacks?: PanelCallbacks,
  ): GraphPanel {
    const column = vscode.ViewColumn.Beside;

    if (GraphPanel.currentPanel) {
      GraphPanel.currentPanel.panel.reveal(column);
      if (callbacks) GraphPanel.currentPanel.callbacks = callbacks;
      GraphPanel.currentPanel.update(graphData, focusLabel);
      return GraphPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "fileGraph",
      `File Graph: ${focusLabel}`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "out", "webview"),
        ],
      }
    );

    GraphPanel.currentPanel = new GraphPanel(panel, extensionUri);
    if (callbacks) GraphPanel.currentPanel.callbacks = callbacks;
    GraphPanel.currentPanel.update(graphData, focusLabel);
    return GraphPanel.currentPanel;
  }

  private update(graphData: GraphData, focusLabel: string): void {
    this.panel.title = `File Graph: ${focusLabel}`;

    if (!this.initialized) {
      this.panel.webview.html = this.getHtml(graphData);
      this.initialized = true;
    } else {
      this.panel.webview.postMessage({
        command: "updateGraph",
        data: graphData,
      });
    }
  }

  private getHtml(graphData: GraphData): string {
    const webview = this.panel.webview;
    const webviewDir = vscode.Uri.joinPath(this.extensionUri, "out", "webview");

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, "main.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, "main.css"),
    );

    const nonce = getNonce();
    const data = JSON.stringify(graphData);

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>File Graph</title>
  <style>
    html, body, #root {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    window.__INITIAL_DATA__ = ${data};
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    GraphPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.callbacks.onDispose?.();
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
