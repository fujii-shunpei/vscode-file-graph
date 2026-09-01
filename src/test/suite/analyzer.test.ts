import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DependencyAnalyzer } from "../../analyzer";
import { clearPathIdCache } from "../../paths/pathId";
import { TypeScriptResolver } from "../../resolvers/typescript";

function newAnalyzer(): DependencyAnalyzer {
  const analyzer = new DependencyAnalyzer();
  analyzer.registerResolver(new TypeScriptResolver());
  return analyzer;
}

/**
 * Whether dropping the permissions of a path really keeps this process from reading it.
 *
 * Root is refused nothing, and neither is a volume that does not carry permission
 * bits at all, so on such a machine there is no locked path to observe and the tests
 * about them have nothing to check. They say so out loud with `this.skip()` rather
 * than returning quietly, because a test that reports "passed" for a guarantee it
 * never reached is worse than no test.
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

suite("DependencyAnalyzer", () => {
  /** Holds the workspace and anything kept beside it, such as another spelling of it. */
  let tmp: string;
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

  /** Take away every permission on a path, so the analyzer meets it and cannot open it. */
  function lock(relativePath: string): void {
    const target = path.join(root, relativePath);
    locked.push(target);
    fs.chmodSync(target, 0o000);
  }

  setup(() => {
    // Node ids are canonical paths held in a cache that outlives a suite, so a run
    // that came before must not be able to answer for a path created here.
    clearPathIdCache();
    tmp = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "file-graph-analyzer-"))
    );
    // The root is canonical, so that every test but the one about a differently
    // spelled root reaches the workspace by the same path on every platform.
    root = path.join(tmp, "workspace");
    fs.mkdirSync(root);
    locked = [];
  });

  teardown(() => {
    for (const target of locked) {
      fs.chmodSync(target, 0o755);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  suite("node identity", () => {
    test("imports spelled with different case reach one node", () => {
      write("src/Target.ts", "export const value = 1;\n");
      write(
        "src/entry.ts",
        `import { value } from "./Target";\nimport { value as alias } from "./target";\n`
      );

      const { graph } = newAnalyzer().analyzeOverview(root);

      assert.deepStrictEqual(
        graph.nodes.map((node) => node.label).sort(),
        ["src/Target.ts", "src/entry.ts"]
      );
      assert.deepStrictEqual(
        [...new Set(graph.edges.map((edge) => edge.target))],
        [id("src/Target.ts")]
      );
    });

    test("a file reached through a symlinked directory is not a second node", () => {
      write("src/Target.ts", "export const value = 1;\n");
      write("src/entry.ts", `import { value } from "../link/Target";\n`);
      fs.symlinkSync(path.join(root, "src"), path.join(root, "link"));

      const { graph } = newAnalyzer().analyzeOverview(root);

      assert.deepStrictEqual(
        graph.nodes.map((node) => node.label).sort(),
        ["src/Target.ts", "src/entry.ts"]
      );
    });

    test("the focused file keeps the id its dependants point at", () => {
      write("src/Target.ts", "export const value = 1;\n");
      write("src/entry.ts", `import { value } from "./Target";\n`);
      // The workspace as the caller spells it rather than as the file system stores
      // it: a checkout reached through a symlink, which is what a macOS temporary
      // directory is and what a linked worktree is anywhere. The link is built here
      // instead of being left to the platform, so that the case is met on every one.
      const asSpelledByTheCaller = path.join(tmp, "alias");
      fs.symlinkSync(root, asSpelledByTheCaller);

      const { graph } = newAnalyzer().analyze(
        path.join(asSpelledByTheCaller, "src", "Target.ts"),
        asSpelledByTheCaller,
        2
      );

      assert.deepStrictEqual(
        graph.nodes.map((node) => node.label).sort(),
        ["src/Target.ts", "src/entry.ts"]
      );
      assert.strictEqual(graph.nodes.filter((node) => node.isFocused).length, 1);
      assert.strictEqual(graph.edges.length, 1);
    });
  });

  suite("layer detection", () => {
    test("only the path inside the workspace decides the layer", () => {
      // The absolute path carries `api/` and `tests/`, which the layer patterns
      // would otherwise read as architecture.
      const nested = path.join(root, "api", "tests", "project");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, "Thing.ts"), "export const value = 1;\n");
      fs.mkdirSync(path.join(nested, "src", "controllers"), { recursive: true });
      fs.writeFileSync(
        path.join(nested, "src", "controllers", "Home.ts"),
        "export const value = 1;\n"
      );

      const { graph } = newAnalyzer().analyzeOverview(nested);
      const layerOf = new Map(graph.nodes.map((node) => [node.label, node.layer]));

      assert.strictEqual(layerOf.get("Thing.ts"), "Other");
      assert.strictEqual(layerOf.get("src/controllers/Home.ts"), "Controller");
    });
  });

  suite("file collection", () => {
    test("generated and tooling directories are not scanned", () => {
      write("src/app.ts", "export const value = 1;\n");
      const skipped = [
        ".vscode-test", ".venv", "venv", "__pycache__", ".pytest_cache",
        "target", ".gradle", ".mvn", "node_modules",
      ];
      for (const dir of skipped) {
        write(path.join(dir, "buried.ts"), "export const value = 1;\n");
      }

      const { graph } = newAnalyzer().analyzeOverview(root);

      assert.deepStrictEqual(graph.nodes.map((node) => node.label), ["src/app.ts"]);
    });

    test("a tmp directory is scanned", () => {
      // `tmp` is an ordinary directory name a project may keep its own sources
      // under, unlike the tooling output the skip list is made of.
      write("tmp/app.ts", "export const value = 1;\n");

      const { graph } = newAnalyzer().analyzeOverview(root);

      assert.deepStrictEqual(graph.nodes.map((node) => node.label), ["tmp/app.ts"]);
    });

    test("a file deeper than ten directories still becomes a node", () => {
      const deep = Array.from({ length: 12 }, (_, i) => `level${i}`).join("/");
      write(`${deep}/Deep.ts`, "export const value = 1;\n");

      const { graph } = newAnalyzer().analyzeOverview(root);

      assert.deepStrictEqual(
        graph.nodes.map((node) => node.label),
        [`${deep}/Deep.ts`]
      );
    });
  });

  suite("imports that reached no file", () => {
    test("an import naming something outside the workspace is counted and named", () => {
      write("src/domain/entry.ts", `import * as React from "react";\n`);

      const { unresolved } = newAnalyzer().analyzeOverview(root);

      assert.strictEqual(unresolved.count, 1);
      assert.deepStrictEqual(unresolved.samples, [
        { file: path.join("src", "domain", "entry.ts"), raw: "react" },
      ]);
    });

    test("a sample names the file the way the workspace does, not the machine", () => {
      write("src/domain/entry.ts", `import * as React from "react";\n`);

      const { unresolved } = newAnalyzer().analyzeOverview(root);

      // The reader is looking at a workspace, and an absolute path would carry the
      // temporary directory this test happens to run in into what is shown.
      assert.strictEqual(path.isAbsolute(unresolved.samples[0].file), false);
      assert.strictEqual(unresolved.samples[0].file.includes(root), false);
    });

    test("past the tenth, an import is counted without being named", () => {
      const specifiers = Array.from({ length: 25 }, (_, i) => `package-${i}`);
      write(
        "src/entry.ts",
        specifiers.map((s, i) => `import m${i} from "${s}";`).join("\n") + "\n"
      );

      const { unresolved } = newAnalyzer().analyzeOverview(root);

      // The count is the whole answer; the samples are the first ten of it, so that
      // what is missing can be named and not only counted.
      assert.strictEqual(unresolved.count, 25);
      assert.deepStrictEqual(
        unresolved.samples.map((sample) => sample.raw),
        specifiers.slice(0, 10)
      );
    });

    test("the imports of the files that point at the focus are not counted against it", () => {
      // The incoming pass reads every file in the workspace to find the few that
      // reach the focused one. What the rest of them failed to resolve is an answer
      // to a question this view never asked, and counting it would make the number
      // beside a one file view grow with the size of the workspace around it.
      write("src/Target.ts", `import cloneDeep from "lodash";\n`);
      write(
        "src/entry.ts",
        `import { value } from "./Target";\nimport * as React from "react";\n`
      );

      const { unresolved } = newAnalyzer().analyze(id("src/Target.ts"), root, 2);

      assert.strictEqual(unresolved.count, 1);
      assert.deepStrictEqual(unresolved.samples, [
        { file: path.join("src", "Target.ts"), raw: "lodash" },
      ]);
    });
  });

  suite("paths that could not be opened", () => {
    test("a file that will not open keeps its node and is counted", function (this: Mocha.Context) {
      if (!permissionsAreEnforced(root)) this.skip();
      write("src/locked.ts", `import { value } from "./other";\n`);
      write("src/other.ts", "export const value = 1;\n");
      lock("src/locked.ts");

      const { graph, unreadable } = newAnalyzer().analyzeOverview(root);

      // The node is there and nothing leaves it: exactly the shape of a file that
      // imports nothing, which is why the count beside the graph is the only thing
      // that can tell the reader which of the two this is.
      assert.deepStrictEqual(
        graph.nodes.map((node) => node.label).sort(),
        ["src/locked.ts", "src/other.ts"]
      );
      assert.deepStrictEqual(graph.edges, []);
      assert.strictEqual(unreadable.count, 1);
      assert.deepStrictEqual(unreadable.samples, [
        { path: path.join("src", "locked.ts"), kind: "file", reason: "EACCES" },
      ]);
    });

    test("a directory that will not list is counted apart from a file", function (this: Mocha.Context) {
      if (!permissionsAreEnforced(root)) this.skip();
      write("src/app.ts", "export const value = 1;\n");
      write("src/secret/Hidden.ts", "export const value = 1;\n");
      lock("src/secret");

      const { graph, unreadable } = newAnalyzer().analyzeOverview(root);

      // The file inside leaves nothing behind at all, not even the empty node an
      // unreadable file leaves, so the two failures are held apart rather than
      // added up: one number could not say which of them a reader is looking at.
      assert.deepStrictEqual(graph.nodes.map((node) => node.label), ["src/app.ts"]);
      assert.deepStrictEqual(unreadable.samples, [
        { path: path.join("src", "secret"), kind: "directory", reason: "EACCES" },
      ]);
    });

    test("the view centred on one file counts what it could not open looking for its dependants", function (this: Mocha.Context) {
      if (!permissionsAreEnforced(root)) this.skip();
      write("src/Target.ts", "export const value = 1;\n");
      write("src/locked.ts", `import { value } from "./Target";\n`);
      lock("src/locked.ts");

      const { unreadable } = newAnalyzer().analyze(id("src/Target.ts"), root, 2);

      // A file that never opened may be one that imports the focus, so its absence
      // is an answer to what this view asks - unlike the imports of the files that
      // do open, which are not counted here.
      assert.strictEqual(unreadable.count, 1);
      assert.deepStrictEqual(unreadable.samples, [
        { path: path.join("src", "locked.ts"), kind: "file", reason: "EACCES" },
      ]);
    });

    test("past the tenth, a path is counted without being named", function (this: Mocha.Context) {
      if (!permissionsAreEnforced(root)) this.skip();
      for (let i = 0; i < 25; i++) {
        write(`src/locked${i}.ts`, "export const value = 1;\n");
        lock(`src/locked${i}.ts`);
      }

      const { unreadable } = newAnalyzer().analyzeOverview(root);

      assert.strictEqual(unreadable.count, 25);
      assert.strictEqual(unreadable.samples.length, 10);
    });

    test("a file both passes walked over is one thing missing, not two", function (this: Mocha.Context) {
      if (!permissionsAreEnforced(root)) this.skip();
      write("src/Target.ts", `import { value } from "./locked";\n`);
      write("src/locked.ts", "export const value = 1;\n");
      lock("src/locked.ts");

      const { unreadable } = newAnalyzer().analyze(id("src/Target.ts"), root, 2);

      // The outgoing pass follows the import into it and the incoming pass reads the
      // whole workspace over it again.
      assert.strictEqual(unreadable.count, 1);
      assert.strictEqual(unreadable.samples.length, 1);
    });
  });

  suite("what a second run remembers", () => {
    /** Where the dependencies of the workspace point, relative to its root. */
    function targetsOf(analyzer: DependencyAnalyzer): string[] {
      return analyzer
        .analyzeOverview(root)
        .graph.edges.map((edge) => path.relative(root, edge.target));
    }

    test("a file edited after it was read keeps its old dependencies until the cache is cleared", () => {
      write("src/a.ts", "export const value = 1;\n");
      write("src/b.ts", "export const value = 2;\n");
      write("src/entry.ts", `import { value } from "./a";\n`);
      const analyzer = newAnalyzer();

      assert.deepStrictEqual(targetsOf(analyzer), [path.join("src", "a.ts")]);

      write("src/entry.ts", `import { value } from "./b";\n`);

      // Held in memory: the file was read once and its contents were kept.
      assert.deepStrictEqual(targetsOf(analyzer), [path.join("src", "a.ts")]);

      analyzer.clearCache();

      // Forgotten, so the edit reaches the graph. Without this the user saves a file
      // and the picture keeps showing the dependency the file no longer declares.
      assert.deepStrictEqual(targetsOf(analyzer), [path.join("src", "b.ts")]);
    });
  });
});
