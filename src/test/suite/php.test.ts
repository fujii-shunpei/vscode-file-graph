import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { clearPathIdCache } from "../../paths/pathId";
import { PhpResolver } from "../../resolvers/php";

suite("PHP PSR-4 resolution", () => {
  let root: string;

  function write(relativePath: string, content: string): void {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  function composer(relativePath: string, psr4: Record<string, string>): void {
    write(relativePath, JSON.stringify({ autoload: { "psr-4": psr4 } }));
  }

  /** Where the `use` statements of `entry` resolve to, as paths relative to the root. */
  function resolvedFrom(entry: string, content: string): (string | null)[] {
    return new PhpResolver()
      .resolveImports(content, path.join(root, entry), root)
      .map((imp) =>
        imp.resolvedPath ? path.relative(root, imp.resolvedPath) : null
      );
  }

  setup(() => {
    // Node ids are canonical paths held in a cache that outlives a suite, so a run
    // that came before must not be able to answer for a path created here.
    clearPathIdCache();
    root = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "file-graph-php-psr4-"))
    );
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("an application below the workspace root resolves through its own composer.json", () => {
    // The workspace holds the deployment next to the application, so composer.json
    // sits at `src/` and its `app/` is written relative to that, not to the workspace.
    composer("src/composer.json", { "App\\": "app/" });
    write("docker/Dockerfile", "FROM php:8\n");
    write("src/app/Models/Estimate.php", "<?php\nnamespace App\\Models;\n");

    assert.deepStrictEqual(
      resolvedFrom(
        "src/app/Http/Requests/Admin/Estimate/UpdateRemarkRequest.php",
        `<?php\nnamespace App\\Http\\Requests\\Admin\\Estimate;\nuse App\\Models\\Estimate;\n`
      ),
      [path.join("src", "app", "Models", "Estimate.php")]
    );
  });

  test("a composer.json at the workspace root maps its prefixes from there", () => {
    composer("composer.json", { "App\\": "src/app/" });
    write("src/app/Models/Estimate.php", "<?php\nnamespace App\\Models;\n");

    assert.deepStrictEqual(
      resolvedFrom(
        "src/app/Http/Controllers/EstimateController.php",
        `<?php\nuse App\\Models\\Estimate;\n`
      ),
      [path.join("src", "app", "Models", "Estimate.php")]
    );
  });

  test("the conventional prefixes still apply when no composer.json is present", () => {
    write("app/Models/Estimate.php", "<?php\nnamespace App\\Models;\n");

    assert.deepStrictEqual(
      resolvedFrom(
        "app/Http/Controllers/EstimateController.php",
        `<?php\nuse App\\Models\\Estimate;\n`
      ),
      [path.join("app", "Models", "Estimate.php")]
    );
  });

  test("the conventional prefixes stand beside the ones a composer.json declares", () => {
    // A composer.json that declares its own prefixes does not switch the conventional
    // ones off: a Laravel application writes `App\` nowhere and still means `app/`.
    composer("composer.json", { "Acme\\": "lib/" });
    write("app/Models/Estimate.php", "<?php\nnamespace App\\Models;\n");
    write("lib/Client.php", "<?php\nnamespace Acme;\n");

    assert.deepStrictEqual(
      resolvedFrom(
        "app/Http/Controllers/EstimateController.php",
        `<?php\nuse App\\Models\\Estimate;\nuse Acme\\Client;\n`
      ),
      [path.join("app", "Models", "Estimate.php"), path.join("lib", "Client.php")]
    );
  });

  test("a class outside the package that owns the file resolves nowhere", () => {
    // `App\` is mapped here, by the conventional prefixes if by nothing else - but it
    // is mapped relative to the composer.json that owns the entry, so it names
    // `src/app/`, and the file below sits in the `app/` of the workspace instead. It
    // belongs to another package, so the entry has no dependency on it.
    //
    // The import is still reported, with no path: an import that reached nothing has
    // to stay visible, or a project whose paths all failed to resolve looks exactly
    // like a project with no dependencies.
    composer("src/composer.json", { "Acme\\": "lib/" });
    write("app/Models/Estimate.php", "<?php\nnamespace App\\Models;\n");

    assert.deepStrictEqual(
      resolvedFrom("src/app/Http/Entry.php", `<?php\nuse App\\Models\\Estimate;\n`),
      [null]
    );
  });
});
