import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { clearPathIdCache, toNodeId } from "../../paths/pathId";

suite("toNodeId", () => {
  let root: string;

  suiteSetup(() => {
    // Deliberately not canonicalised: on macOS this reaches the temporary directory
    // through a symlink, which is what makes the assertions below say something.
    root = fs.mkdtempSync(path.join(os.tmpdir(), "file-graph-pathid-"));
  });

  suiteTeardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
    clearPathIdCache();
  });

  setup(() => {
    // The cache is module global and outlives every suite, so each test starts by
    // forgetting what the ones before it looked up. Otherwise the independence of
    // these tests rests on `mkdtempSync` never handing back a name twice.
    clearPathIdCache();
  });

  test("the id is the spelling the file system stores", () => {
    const file = path.join(root, "Stored.ts");
    fs.writeFileSync(file, "export const value = 1;\n");

    assert.strictEqual(toNodeId(file), fs.realpathSync.native(file));
  });

  test("what the volume treats as one file gets one id", () => {
    const stored = path.join(root, "Cased.ts");
    fs.writeFileSync(stored, "export const value = 1;\n");
    const otherCase = path.join(root, "cased.ts");

    if (fs.existsSync(otherCase)) {
      // A case insensitive volume: both spellings reach the one file, and one file
      // is one node however an import happened to write its path.
      assert.strictEqual(toNodeId(otherCase), toNodeId(stored));
    } else {
      // A case sensitive volume: the lower case path names a different file, and one
      // that does not exist. It has no canonical form to be folded into, so it keeps
      // the spelling it was given and stays apart from the stored file.
      assert.strictEqual(toNodeId(otherCase), otherCase);
      assert.notStrictEqual(toNodeId(otherCase), toNodeId(stored));
    }
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

  suite("what a lookup remembers", () => {
    /** A file, a second file, and a link that starts out pointing at the first. */
    function threeFiles(name: string): { a: string; b: string; link: string } {
      const a = path.join(root, `${name}-a.ts`);
      const b = path.join(root, `${name}-b.ts`);
      const link = path.join(root, `${name}-link.ts`);
      fs.writeFileSync(a, "export const value = 1;\n");
      fs.writeFileSync(b, "export const value = 2;\n");
      fs.symlinkSync(a, link);
      return { a, b, link };
    }

    function pointAt(link: string, target: string): void {
      fs.unlinkSync(link);
      fs.symlinkSync(target, link);
    }

    test("a path already looked up is answered from memory, not from the file system", () => {
      const { a, b, link } = threeFiles("remembered");
      assert.strictEqual(toNodeId(link), fs.realpathSync.native(a));

      pointAt(link, b);

      // The file system now answers differently and the id does not, which is the
      // whole of what the cache buys: `realpathSync` is a syscall, and the same
      // paths are asked for once while collecting files and again for every import
      // that reaches them.
      assert.strictEqual(toNodeId(link), fs.realpathSync.native(a));
    });

    test("a path that now leads elsewhere is looked up again once the cache is cleared", () => {
      const { a, b, link } = threeFiles("forgotten");
      assert.strictEqual(toNodeId(link), fs.realpathSync.native(a));
      pointAt(link, b);

      clearPathIdCache();

      // What a clear that forgets nothing would look like to the user: a file is
      // moved and saved, and the graph keeps naming the node it used to point at.
      assert.strictEqual(toNodeId(link), fs.realpathSync.native(b));
    });
  });
});
