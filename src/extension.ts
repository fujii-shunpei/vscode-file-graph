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
    // Before the panel check: the settings that hold a reported fault have just
    // been edited, so the fault is worth stating again whether or not the edit
    // is followed by a redraw.
    reportedConfigWarnings.clear();
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

// The settings are read again for every redraw, and a redraw follows every
// editor switch while live tracking is on, so a fault reported per read stacks
// one toast per switch. The fault belongs to the settings, not to the redraw
// that happened to read them, so each message is shown once and the record is
// dropped when the settings that could hold the fault change.
const reportedConfigWarnings = new Set<string>();

/** Report a settings fault unless the same one has already been reported. */
function reportConfigWarning(message: string): void {
  if (reportedConfigWarnings.has(message)) return;
  reportedConfigWarnings.add(message);
  vscode.window.showWarningMessage(message);
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
    reportConfigWarning(
      "fileGraph.groups.rules must be an array. The setting was ignored."
    );
    return [];
  }

  const rules: GroupRule[] = [];
  const rejected: unknown[] = [];
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
      rejected.push(entry);
    }
  }

  // The offending entry is named, because a count alone leaves the reader to
  // search a list that can be long for the one that was dropped.
  if (rejected.length > 0) {
    reportConfigWarning(
      `fileGraph.groups.rules: ${rejected.length} rule(s) without a string "pattern" and "name" were ignored, starting with ${JSON.stringify(rejected[0])}.`
    );
  }
  return rules;
}

// The range `fileGraph.groups.autoDepth` is declared with in `contributes`, kept
// beside the check that has to hold it: the schema in package.json is the copy
// the settings editor reads, and this one is the copy that decides.
const AUTO_DEPTH_DEFAULT = 2;
const AUTO_DEPTH_MAX = 6;

/**
 * Keep `fileGraph.groups.autoDepth` when it reads as a depth and report it otherwise.
 *
 * Written to the same contract as `validateRules`: the schema in `contributes`
 * cannot stop a hand written settings.json, so the value arrives unchecked.
 *
 * An unchecked one is worse than merely wrong. `attachGroups` feeds it to
 * `Math.min`, where a negative, a `null` or an unparsable value yields an empty
 * group path for every node. The graph then has no groups, the forbidden rules
 * are read against groups that are not there and match nothing, and the result
 * reads as a graph with no violations rather than as a graph that was never
 * checked. Falling back to the default keeps the grouping the user would
 * recognise, and the report keeps the reason for it visible.
 */
function validateAutoDepth(raw: unknown): number {
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > AUTO_DEPTH_MAX
  ) {
    reportConfigWarning(
      `fileGraph.groups.autoDepth must be a whole number between 0 and ${AUTO_DEPTH_MAX}. ${JSON.stringify(raw)} was ignored and ${AUTO_DEPTH_DEFAULT} used instead.`
    );
    return AUTO_DEPTH_DEFAULT;
  }
  return raw;
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
    autoDepth: validateAutoDepth(
      config.get<unknown>("groups.autoDepth", AUTO_DEPTH_DEFAULT)
    ),
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
    reportConfigWarning(
      "fileGraph.rules.forbidden must be an array. The setting was ignored."
    );
    return [];
  }

  const rules: DependencyRule[] = [];
  const rejected: unknown[] = [];
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
      rejected.push(entry);
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

  if (rejected.length > 0) {
    reportConfigWarning(
      `fileGraph.rules.forbidden: ${rejected.length} rule(s) that are not { from: string, to: string, name?: string, severity?: "error" | "warning" } were ignored, starting with ${JSON.stringify(rejected[0])}.`
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

/**
 * The folder a graph centred on `filePath` is measured against, or `null` once the
 * reason it has none has been reported.
 *
 * Everything the local view says about a file it says relative to one root: the
 * label is the path from it, `attachGroups` reads the group a file belongs to from
 * it, and the settings driving both are declared `"scope": "resource"`, so the
 * folder also decides which `.vscode/settings.json` answers. In a multi-root
 * workspace only the folder holding the file can play that part. Measured from a
 * folder beside it, `path.relative` yields a `..` chain, which grouping reads as
 * outside the workspace: the file and everything it reaches lose their groups, the
 * forbidden rules are then checked against groups that are not there, and the view
 * reads as a workspace that breaks no rule rather than one that was never checked.
 *
 * A file no folder holds has no such root and nothing that can stand in for one.
 * The first folder is what puts those `..` chains there, and the file's own
 * directory is a root the user never declared - one the incoming scan would then
 * walk. So the view is refused and the reason said, rather than drawn against a
 * root that does not hold the file.
 */
function resolveGraphFolder(filePath: string): vscode.WorkspaceFolder | null {
  // Looked up by the path as VS Code spells it, ahead of the canonicalization
  // below: a workspace opened through a symlink has folder uris spelled that way
  // too, and a canonical path would match none of them.
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
  if (folder) return folder;

  vscode.window.showWarningMessage(
    vscode.workspace.workspaceFolders?.length
      ? `${path.basename(filePath)} is outside every open workspace folder. Add the folder holding it to the workspace to graph it.`
      : "No workspace folder is open."
  );
  return null;
}

function showGraph(filePath: string): void {
  const workspaceFolder = resolveGraphFolder(filePath);
  if (!workspaceFolder) return;

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
    {
      view: "local",
      data: graphData,
      structure,
      unresolved: result.unresolved,
      unreadable: result.unreadable,
    },
    label,
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
    }
  );
}

function showOverview(): void {
  // The first folder and no other, unlike the local view, which takes the folder
  // holding the file it is centred on. This view is centred on nothing, so there is
  // no file to name the folder that should answer for it, and the graph it builds
  // counts from a single root: labels, groups and the rules read against them are
  // all measured from one. In a multi-root workspace the folders after the first
  // are therefore left out of the overview.
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
    {
      view: "overview",
      data: graphData,
      structure,
      unresolved: result.unresolved,
      unreadable: result.unreadable,
    },
    "Overview",
    {}
  );
}

export function deactivate() {}
