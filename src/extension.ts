import * as vscode from "vscode";
import * as path from "path";
import { DependencyAnalyzer } from "./analyzer";
import { PhpResolver } from "./resolvers/php";
import { TypeScriptResolver } from "./resolvers/typescript";
import { PythonResolver } from "./resolvers/python";
import { GraphPanel } from "./graphPanel";
import { toNodeId } from "./paths/pathId";
import { attachGroups } from "./grouping";
import { analyzeStructure } from "./cycles";
import type { GroupConfig } from "./grouping";
import type {
  DependencyRule,
  GraphPayload,
  GroupRule,
} from "./shared/graphTypes";

let analyzer: DependencyAnalyzer;
let extensionUri: vscode.Uri;
let isLive = false;
let currentDepth = 2;
let lastFilePath: string | null = null;
let currentView: GraphPayload["view"] = "local";

export function activate(context: vscode.ExtensionContext) {
  extensionUri = context.extensionUri;
  analyzer = new DependencyAnalyzer();
  analyzer.registerResolver(new PhpResolver());
  analyzer.registerResolver(new TypeScriptResolver());
  analyzer.registerResolver(new PythonResolver());

  const supportedExtensions = new Set([
    ".php", ".ts", ".tsx", ".js", ".jsx", ".py",
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
        filters: { "Source Files": ["php", "ts", "tsx", "js", "jsx", "py"] },
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

  // Show the whole workspace at once
  const showOverviewCommand = vscode.commands.registerCommand(
    "fileGraph.showOverview",
    () => showOverview()
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

  // Grouping and the rules read against it are resolved at render time, so a
  // settings change needs a redraw
  const onConfigChange = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      !event.affectsConfiguration("fileGraph.groups") &&
      !event.affectsConfiguration("fileGraph.rules")
    ) {
      return;
    }
    if (!GraphPanel.currentPanel) return;

    if (currentView === "overview") {
      showOverview();
    } else if (lastFilePath) {
      showGraph(lastFilePath);
    }
  });

  context.subscriptions.push(
    showFromFile,
    showWithPicker,
    showOverviewCommand,
    onEditorChange,
    onSave,
    onConfigChange
  );
}

/**
 * Keep the well formed entries of `fileGraph.groups.rules` and report the rest.
 *
 * The JSON schema in `contributes` only advises the settings editor, so a hand
 * written settings.json can hold anything. Reporting instead of throwing keeps
 * the cause visible even when the read is triggered by a settings change, where
 * an exception would surface nowhere.
 */
function validateRules(raw: unknown): GroupRule[] {
  if (!Array.isArray(raw)) {
    vscode.window.showWarningMessage(
      "fileGraph.groups.rules must be an array. The setting was ignored."
    );
    return [];
  }

  const rules: GroupRule[] = [];
  let rejected = 0;
  for (const entry of raw) {
    const rule = entry as Partial<GroupRule> | null;
    if (
      typeof rule === "object" &&
      rule !== null &&
      typeof rule.pattern === "string" &&
      typeof rule.name === "string"
    ) {
      rules.push({ pattern: rule.pattern, name: rule.name });
    } else {
      rejected++;
    }
  }

  if (rejected > 0) {
    vscode.window.showWarningMessage(
      `fileGraph.groups.rules: ${rejected} rule(s) without a string "pattern" and "name" were ignored.`
    );
  }
  return rules;
}

/**
 * Read the grouping settings that drive `attachGroups`.
 *
 * @param scope Folder the graph is analysed for. Both settings are declared with
 * `"scope": "resource"`, so the folder has to be passed for its `.vscode/settings.json`
 * to win in a multi-root workspace.
 */
function readGroupConfig(scope: vscode.Uri): GroupConfig {
  const config = vscode.workspace.getConfiguration("fileGraph", scope);
  return {
    rules: validateRules(config.get<unknown>("groups.rules", [])),
    autoDepth: config.get<number>("groups.autoDepth", 2),
  };
}

/**
 * Keep the well formed entries of `fileGraph.rules.forbidden` and report the rest.
 *
 * Written to the same contract as `validateRules`: the schema in `contributes`
 * cannot stop a hand written settings.json, and a rule that cannot be read is
 * dropped alone and reported rather than thrown, so one bad entry does not cost
 * the reader the rules beside it.
 *
 * `name` and `severity` are optional in the schema, so an absent one takes the
 * documented default; a present one that reads as neither is a rule the user
 * meant differently than it would behave, and is dropped with the rest.
 */
function validateForbiddenRules(raw: unknown): DependencyRule[] {
  if (!Array.isArray(raw)) {
    vscode.window.showWarningMessage(
      "fileGraph.rules.forbidden must be an array. The setting was ignored."
    );
    return [];
  }

  const rules: DependencyRule[] = [];
  let rejected = 0;
  for (const entry of raw) {
    const rule = entry as Partial<DependencyRule> | null;
    if (
      typeof rule !== "object" ||
      rule === null ||
      typeof rule.from !== "string" ||
      typeof rule.to !== "string" ||
      (rule.name !== undefined && typeof rule.name !== "string") ||
      (rule.severity !== undefined &&
        rule.severity !== "error" &&
        rule.severity !== "warning")
    ) {
      rejected++;
      continue;
    }

    rules.push({
      // A rule without a name is still readable as the dependency it forbids.
      name: rule.name ?? `${rule.from} -> ${rule.to}`,
      from: rule.from,
      to: rule.to,
      severity: rule.severity ?? "error",
    });
  }

  if (rejected > 0) {
    vscode.window.showWarningMessage(
      `fileGraph.rules.forbidden: ${rejected} rule(s) that are not { from: string, to: string, name?: string, severity?: "error" | "warning" } were ignored.`
    );
  }
  return rules;
}

/**
 * Read the forbidden dependencies that `analyzeStructure` checks the graph against.
 *
 * @param scope Folder the graph is analysed for, for the same reason as in
 * `readGroupConfig`.
 */
function readForbiddenRules(scope: vscode.Uri): DependencyRule[] {
  const config = vscode.workspace.getConfiguration("fileGraph", scope);
  return validateForbiddenRules(config.get<unknown>("rules.forbidden", []));
}

function showGraph(filePath: string): void {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showWarningMessage("No workspace folder is open.");
    return;
  }

  lastFilePath = filePath;
  currentView = "local";
  // Canonical, because the analyzer names its nodes by canonical path: grouping and
  // the label both measure against the root, and a root spelled differently (a
  // symlinked checkout, another casing) would put every node outside the workspace.
  const workspaceRoot = toNodeId(workspaceFolder.uri.fsPath);
  const focusPath = toNodeId(filePath);
  const result = analyzer.analyze(focusPath, workspaceRoot, currentDepth);
  const graphData = attachGroups(
    result.graph,
    workspaceRoot,
    readGroupConfig(workspaceFolder.uri)
  );
  const label = path.relative(workspaceRoot, focusPath);

  const structure = analyzeStructure(
    graphData,
    readForbiddenRules(workspaceFolder.uri)
  );

  GraphPanel.show(
    extensionUri,
    graphData,
    structure,
    result.unresolved,
    label,
    "local",
    {
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

function showOverview(): void {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showWarningMessage("No workspace folder is open.");
    return;
  }

  isLive = false;
  currentView = "overview";
  const workspaceRoot = toNodeId(workspaceFolder.uri.fsPath);
  const result = analyzer.analyzeOverview(workspaceRoot);
  const graphData = attachGroups(
    result.graph,
    workspaceRoot,
    readGroupConfig(workspaceFolder.uri)
  );

  const structure = analyzeStructure(
    graphData,
    readForbiddenRules(workspaceFolder.uri)
  );

  // Empty callbacks replace the local view's ones: the overview has no focus
  // file, so depth changes and live tracking must not fire here.
  GraphPanel.show(
    extensionUri,
    graphData,
    structure,
    result.unresolved,
    "Overview",
    "overview",
    {}
  );
}

export function deactivate() {}
