import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { clearPathIdCache, toNodeId } from "../../paths/pathId";

suite("toNodeId", () => {
  let root: string;

  suiteSetup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "file-graph-pathid-"));
  });

  suiteTeardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
    clearPathIdCache();
  });

  test("the id is the spelling the file system stores", () => {
    const file = path.join(root, "Stored.ts");
    fs.writeFileSync(file, "export const value = 1;\n");

    assert.strictEqual(toNodeId(file), fs.realpathSync.native(file));
  });

  test("two spellings of one file share a single id", () => {
    const stored = path.join(root, "Cased.ts");
    fs.writeFileSync(stored, "export const value = 1;\n");
    const otherCase = path.join(root, "cased.ts");

    // On a case sensitive volume there is no second spelling to reconcile: the
    // lower case path is a different file, and one that does not exist.
    if (!fs.existsSync(otherCase)) return;

    assert.strictEqual(toNodeId(otherCase), toNodeId(stored));
  });

  test("a symlink and its target share a single id", () => {
    const target = path.join(root, "target.ts");
    const link = path.join(root, "link.ts");
    fs.writeFileSync(target, "export const value = 1;\n");
    fs.symlinkSync(target, link);

    assert.strictEqual(toNodeId(link), toNodeId(target));
  });

  test("a path that does not exist is handed back unchanged", () => {
    const missing = path.join(root, "missing.ts");

    assert.strictEqual(toNodeId(missing), missing);
  });

  test("a repeated lookup answers the same id", () => {
    const file = path.join(root, "Repeated.ts");
    fs.writeFileSync(file, "export const value = 1;\n");

    assert.strictEqual(toNodeId(file), toNodeId(file));
  });
});
