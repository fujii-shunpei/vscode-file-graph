import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { DependencyAnalyzer } from "../../analyzer";
import { analyzeStructure } from "../../cycles";
import { GraphPanel } from "../../graphPanel";
import { attachGroups } from "../../grouping";
import type { GroupConfig } from "../../grouping";
import { clearPathIdCache } from "../../paths/pathId";
import { TypeScriptResolver } from "../../resolvers/typescript";
import type {
  DependencyRule,
  GraphData,
  GraphPayload,
  StructureAnalysis,
  UnreadablePaths,
  UnresolvedImports,
} from "../../shared/graphTypes";

/**
 * The three passes the extension runs over a workspace, in the order it runs them.
 *
 * They are one answer and not three. `analyzeStructure` reads the groups
 * `attachGroups` writes, and a graph whose nodes carry no group has no group
 * dependency, no group cycle and no violation - which is also what a workspace that
 * breaks no rule looks like. Each pass tested on hand written input would stay green
 * with the passes wired in any order at all, so these tests start from files on disk.
 */
function runPipeline(
  workspaceRoot: string,
  groups: GroupConfig,
  rules: DependencyRule[] = []
): {
  data: GraphData;
  structure: StructureAnalysis;
  unresolved: UnresolvedImports;
  unreadable: UnreadablePaths;
} {
  const analyzer = new DependencyAnalyzer();
  analyzer.registerResolver(new TypeScriptResolver());

  const result = analyzer.analyzeOverview(workspaceRoot);
  const data = attachGroups(result.graph, workspaceRoot, groups);

  return {
    data,
    structure: analyzeStructure(data, rules),
    unresolved: result.unresolved,
    unreadable: result.unreadable,
  };
}

/** The same three passes over the view centred on one file. */
function runLocalPipeline(
  focusFilePath: string,
  workspaceRoot: string,
  groups: GroupConfig,
  rules: DependencyRule[] = []
): { data: GraphData; structure: StructureAnalysis } {
  const analyzer = new DependencyAnalyzer();
  analyzer.registerResolver(new TypeScriptResolver());

  const result = analyzer.analyze(focusFilePath, workspaceRoot, 2);
  const data = attachGroups(result.graph, workspaceRoot, groups);

  return { data, structure: analyzeStructure(data, rules) };
}

/**
 * Whether dropping the permissions of a path really keeps this process from reading it.
 *
 * Root is refused nothing, and neither is a volume without permission bits, so on such
 * a machine there is no locked path for the walk to meet. The test says so with
 * `this.skip()` rather than passing quietly on a guarantee it never reached.
 */
function permissionsAreEnforced(directory: string): boolean {
  const probe = path.join(directory, ".permission-probe");
  fs.writeFileSync(probe, "x");
  fs.chmodSync(probe, 0o000);
  try {
    fs.readFileSync(probe);
    return false;
  } catch {
    return true;
  } finally {
    fs.chmodSync(probe, 0o600);
    fs.rmSync(probe);
  }
}

suite("from files on disk to rule violations", () => {
  let root: string;
  /**
   * Paths a test dropped the permissions of. Restored before the tree is removed,
   * because a directory that will not list will not delete either.
   */
  let locked: string[];

  function write(relativePath: string, content: string): void {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  /** The node id of a file that exists: a canonical root makes the join canonical too. */
  function id(relativePath: string): string {
    return path.join(root, relativePath);
  }

  function byDirectory(autoDepth = 2): GroupConfig {
    return { rules: [], autoDepth };
  }

  /** Take away every permission on a path, so the walk meets it and cannot open it. */
  function lock(relativePath: string): void {
    const target = path.join(root, relativePath);
    locked.push(target);
    fs.chmodSync(target, 0o000);
  }

  setup(() => {
    // The ids are canonical paths, so a suite that ran before must not be able to
    // answer for a path this one is about to create at the same name.
    clearPathIdCache();
    root = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "file-graph-pipeline-"))
    );
    locked = [];
  });

  teardown(() => {
    for (const target of locked) {
      fs.chmodSync(target, 0o755);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("a file importing across a forbidden boundary is reported as one violation", () => {
    write("src/infra/Client.ts", "export const send = () => 1;\n");
    write("src/domain/User.ts", `import { send } from "../infra/Client";\n`);
    const rules: DependencyRule[] = [
      {
        name: "domain is independent",
        from: "src/domain",
        to: "src/infra",
        severity: "error",
      },
    ];

    const { structure } = runPipeline(root, byDirectory(), rules);

    assert.deepStrictEqual(structure.violations, [
      {
        ruleName: "domain is independent",
        severity: "error",
        source: id("src/domain/User.ts"),
        target: id("src/infra/Client.ts"),
        fromGroup: "src/domain",
        toGroup: "src/infra",
      },
    ]);
  });

  test("the groups a violation names are the directories the files sit in", () => {
    write("src/infra/Client.ts", "export const send = () => 1;\n");
    write("src/domain/User.ts", `import { send } from "../infra/Client";\n`);
    write("src/domain/Order.ts", `import { send } from "../infra/Client";\n`);

    const { data, structure } = runPipeline(root, byDirectory());
    const groupsOf = new Map(data.nodes.map((node) => [node.label, node.groupPath]));

    assert.deepStrictEqual(groupsOf.get("src/domain/User.ts"), ["src", "src/domain"]);
    assert.deepStrictEqual(groupsOf.get("src/infra/Client.ts"), ["src", "src/infra"]);
    assert.deepStrictEqual(structure.groupDependencies, [
      { source: "src/domain", target: "src/infra", weight: 2 },
    ]);
  });

  test("a dependency running the allowed way leaves the groups visible and the rule unbroken", () => {
    // The reading that must not pass: an empty violation list because the groups
    // never arrived looks exactly like a workspace that breaks no rule. Here the
    // group dependency stands beside the empty list and says which of the two it is.
    write("src/domain/User.ts", "export const user = 1;\n");
    write("src/infra/Client.ts", `import { user } from "../domain/User";\n`);
    const rules: DependencyRule[] = [
      {
        name: "domain is independent",
        from: "src/domain",
        to: "src/infra",
        severity: "error",
      },
    ];

    const { structure } = runPipeline(root, byDirectory(), rules);

    assert.deepStrictEqual(structure.violations, []);
    assert.deepStrictEqual(structure.groupDependencies, [
      { source: "src/infra", target: "src/domain", weight: 1 },
    ]);
  });

  test("a group a pattern names is the group the rule is written against", () => {
    write("src/infra/Client.ts", "export const send = () => 1;\n");
    write("src/domain/User.ts", `import { send } from "../infra/Client";\n`);
    const groups: GroupConfig = {
      rules: [
        { pattern: "src/domain/**", name: "Domain" },
        { pattern: "src/infra/**", name: "Infrastructure" },
      ],
      autoDepth: 2,
    };
    const rules: DependencyRule[] = [
      {
        name: "domain is independent",
        from: "Domain",
        to: "Infrastructure",
        severity: "warning",
      },
    ];

    const { structure } = runPipeline(root, groups, rules);

    assert.deepStrictEqual(
      structure.violations.map((violation) => [
        violation.ruleName,
        violation.severity,
        violation.fromGroup,
        violation.toGroup,
      ]),
      [["domain is independent", "warning", "Domain", "Infrastructure"]]
    );
    assert.deepStrictEqual(structure.groupDependencies, [
      { source: "Domain", target: "Infrastructure", weight: 1 },
    ]);
  });

  test("files that never depend in a circle can still put their directories in one", () => {
    write("src/domain/User.ts", `import { send } from "../infra/Client";\n`);
    write("src/infra/Client.ts", `import { order } from "../domain/Order";\n`);
    write("src/domain/Order.ts", "export const order = 1;\n");

    const { structure } = runPipeline(root, byDirectory());

    assert.deepStrictEqual(structure.cycles, []);
    assert.deepStrictEqual(
      structure.groupCycles.map((cycle) => cycle.memberIds),
      [["src/domain", "src/infra"]]
    );
  });

  test("the view centred on one file is checked against the rules like the whole workspace", () => {
    write("src/infra/Client.ts", "export const send = () => 1;\n");
    write("src/domain/User.ts", `import { send } from "../infra/Client";\n`);
    const rules: DependencyRule[] = [
      {
        name: "domain is independent",
        from: "src/domain",
        to: "src/infra",
        severity: "error",
      },
    ];

    const { structure } = runLocalPipeline(
      id("src/domain/User.ts"),
      root,
      byDirectory(),
      rules
    );

    assert.deepStrictEqual(
      structure.violations.map((violation) => [
        violation.source,
        violation.target,
        violation.fromGroup,
        violation.toGroup,
      ]),
      [
        [
          id("src/domain/User.ts"),
          id("src/infra/Client.ts"),
          "src/domain",
          "src/infra",
        ],
      ]
    );
  });

  test("an import that named no file is still reported when the passes are done", () => {
    write("src/domain/User.ts", `import * as React from "react";\n`);

    const { structure, unresolved } = runPipeline(root, byDirectory());

    assert.strictEqual(unresolved.count, 1);
    assert.deepStrictEqual(unresolved.samples, [
      { file: path.join("src", "domain", "User.ts"), raw: "react" },
    ]);
    // Nothing about it reaches the graph, which is why it has to be carried beside it.
    assert.deepStrictEqual(structure.groupDependencies, []);
  });

  test("a directory that would not open is still reported when the passes are done", function (this: Mocha.Context) {
    if (!permissionsAreEnforced(root)) this.skip();
    write("src/domain/User.ts", "export const user = 1;\n");
    write("src/secret/Hidden.ts", `import { user } from "../domain/User";\n`);
    lock("src/secret");

    const { data, structure, unreadable } = runPipeline(root, byDirectory());

    // The reading that must not pass: a graph with one file and no dependency is
    // also what a workspace of one file looks like. The subtree that was skipped
    // leaves no node, no edge and no group behind, so unless the count survives the
    // grouping and the rule check and comes back with them, nothing on the way out
    // says half the workspace was never looked at.
    assert.deepStrictEqual(data.nodes.map((node) => node.label), ["src/domain/User.ts"]);
    assert.deepStrictEqual(structure.groupDependencies, []);
    assert.strictEqual(unreadable.count, 1);
    assert.deepStrictEqual(unreadable.samples, [
      { path: path.join("src", "secret"), kind: "directory", reason: "EACCES" },
    ]);
  });

  test("what could not be read is in the payload the panel hands the webview", () => {
    write("src/domain/User.ts", "export const user = 1;\n");
    const { data, structure, unresolved } = runPipeline(root, byDirectory());
    const unreadable: UnreadablePaths = {
      count: 12,
      samples: [{ path: path.join("src", "secret"), kind: "directory", reason: "EACCES" }],
    };

    const payload: GraphPayload = {
      view: "overview",
      data,
      structure,
      unresolved,
      unreadable,
    };
    // The last leg the count travels, and the one it used to be dropped on: the
    // analyzer counted, `AnalysisResult` carried, and the envelope left it behind, so
    // a failure gathered for the reader never reached them. Read back off the panel
    // rather than off `payload`, which would only restate what the line above says.
    const html = htmlHandedToWebview(payload, "Overview");

    assert.deepStrictEqual(readInitialData(html).unreadable, unreadable);
  });
});

/**
 * The payload as the webview receives it, taken from the panel's first render.
 *
 * Reaching past `private` for the webview is deliberate: what the panel writes into
 * that document *is* the wire, and there is no other seam between the host and the
 * webview to observe it at. A test that stopped at the argument `show` was given
 * would pass on a panel that dropped every field of it.
 */
function htmlHandedToWebview(payload: GraphPayload, focusLabel: string): string {
  const panel = GraphPanel.show(
    vscode.Uri.file(path.resolve(__dirname, "..", "..", "..")),
    payload,
    focusLabel,
  );
  const webviewPanel = (panel as unknown as { panel: vscode.WebviewPanel }).panel;
  try {
    return webviewPanel.webview.html;
  } finally {
    webviewPanel.dispose();
  }
}

/** The payload the document hands the bundle, parsed back out of it. */
function readInitialData(html: string): GraphPayload {
  const match = /window\.__INITIAL_DATA__ = (.*);/.exec(html);
  assert.ok(match, "the document does not set window.__INITIAL_DATA__");
  return JSON.parse(match[1]) as GraphPayload;
}
