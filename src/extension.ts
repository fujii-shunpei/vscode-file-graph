import * as vscode from "vscode";
import * as path from "path";
import { DependencyAnalyzer } from "./analyzer";
import { PhpResolver } from "./resolvers/php";
import { TypeScriptResolver } from "./resolvers/typescript";
import { GraphPanel } from "./graphPanel";

let analyzer: DependencyAnalyzer;
let isLive = false;
let currentDepth = 2;
let lastFilePath: string | null = null;

export function activate(context: vscode.ExtensionContext) {
  analyzer = new DependencyAnalyzer();
  analyzer.registerResolver(new PhpResolver());
  analyzer.registerResolver(new TypeScriptResolver());

  const supportedExtensions = new Set([
    ".php", ".ts", ".tsx", ".js", ".jsx",
  ]);

  // Show graph from current file (and start live tracking)
  const showFromFile = vscode.commands.registerCommand(
    "fileGraph.showGraphFromFile",
    () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No file is currently open.");
        return;
      }
      isLive = true;
      showGraph(editor.document.uri.fsPath);
    }
  );

  // Show graph with file picker
  const showWithPicker = vscode.commands.registerCommand(
    "fileGraph.showGraph",
    async () => {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "Source Files": ["php", "ts", "tsx", "js", "jsx"] },
      });
      if (files && files[0]) {
        isLive = true;
        showGraph(files[0].fsPath);
      }
    }
  );

  // Auto-update when active editor changes
  const onEditorChange = vscode.window.onDidChangeActiveTextEditor(
    (editor) => {
      if (!isLive || !editor) return;
      // Don't react to the graph panel itself
      if (editor.document.uri.scheme !== "file") return;
      const ext = path.extname(editor.document.uri.fsPath);
      if (supportedExtensions.has(ext)) {
        showGraph(editor.document.uri.fsPath);
      }
    }
  );

  // Clear cache and refresh on file save
  const onSave = vscode.workspace.onDidSaveTextDocument((doc) => {
    analyzer.clearCache();
    if (isLive && GraphPanel.currentPanel && doc.uri.scheme === "file") {
      const ext = path.extname(doc.uri.fsPath);
      if (supportedExtensions.has(ext)) {
        showGraph(doc.uri.fsPath);
      }
    }
  });

  context.subscriptions.push(showFromFile, showWithPicker, onEditorChange, onSave);
}

function showGraph(filePath: string): void {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showWarningMessage("No workspace folder is open.");
    return;
  }

  lastFilePath = filePath;
  const workspaceRoot = workspaceFolder.uri.fsPath;
  const graphData = analyzer.analyze(filePath, workspaceRoot, currentDepth);
  const label = path.relative(workspaceRoot, filePath);

  GraphPanel.show(graphData, label, {
    onMessage(message) {
      if (message.command === "setDepth" && typeof message.depth === "number") {
        currentDepth = message.depth;
        if (lastFilePath) {
          showGraph(lastFilePath);
        }
      }
    },
    onDispose() {
      isLive = false;
    },
  });
}

export function deactivate() {}
