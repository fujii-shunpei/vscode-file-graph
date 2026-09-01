import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DependencyAnalyzer } from "../../analyzer";
import { TypeScriptResolver } from "../../resolvers/typescript";

function newAnalyzer(): DependencyAnalyzer {
  const analyzer = new DependencyAnalyzer();
  analyzer.registerResolver(new TypeScriptResolver());
  return analyzer;
}

suite("DependencyAnalyzer", () => {
  let root: string;

  function write(relativePath: string, content: string): void {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "file-graph-analyzer-"));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  suite("node identity", () => {
    test("imports spelled with different case reach one node", () => {
      write("src/Target.ts", "export const value = 1;\n");
      write(
        "src/entry.ts",
        `import { value } from "./Target";\nimport { value as alias } from "./target";\n`
      );
      const targetId = fs.realpathSync.native(path.join(root, "src", "Target.ts"));

      const { graph } = newAnalyzer().analyzeOverview(root);

      assert.deepStrictEqual(
        graph.nodes.map((node) => node.label).sort(),
        ["src/Target.ts", "src/entry.ts"]
      );
      assert.deepStrictEqual(
        [...new Set(graph.edges.map((edge) => edge.target))],
        [targetId]
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

      // `root` is handed over as the caller spells it, which on macOS reaches the
      // temporary directory through a symlink.
      const { graph } = newAnalyzer().analyze(
        path.join(root, "src", "Target.ts"),
        root,
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
});
