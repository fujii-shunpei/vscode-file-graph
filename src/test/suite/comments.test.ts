import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  PHP_COMMENT_SYNTAX,
  PYTHON_COMMENT_SYNTAX,
  stripComments,
  TS_COMMENT_SYNTAX,
} from "../../resolvers/comments";
import { PhpResolver } from "../../resolvers/php";
import { PythonResolver } from "../../resolvers/python";
import { TypeScriptResolver } from "../../resolvers/typescript";

suite("stripComments", () => {
  test("a comment is replaced by spaces, not removed", () => {
    const source = `const a = 1; // gone\nconst b = 2;`;

    const stripped = stripComments(source, TS_COMMENT_SYNTAX);

    assert.strictEqual(
      stripped,
      `const a = 1; ` + " ".repeat("// gone".length) + `\nconst b = 2;`
    );
    assert.strictEqual(stripped.length, source.length);
  });

  test("a block comment keeps its newlines, so line numbers survive", () => {
    const source = `a\n/* one\ntwo */\nb`;

    const stripped = stripComments(source, TS_COMMENT_SYNTAX);

    assert.strictEqual(
      stripped,
      `a\n` + " ".repeat("/* one".length) + `\n` + " ".repeat("two */".length) + `\nb`
    );
    assert.strictEqual(stripped.split("\n").length, source.split("\n").length);
  });

  test("a comment marker inside a string literal starts no comment", () => {
    assert.strictEqual(
      stripComments(`const url = "https://example.com/a"; const b = 1;`, TS_COMMENT_SYNTAX),
      `const url = "https://example.com/a"; const b = 1;`
    );
    assert.strictEqual(
      stripComments(`$url = 'http://example.com/a'; $b = 1;`, PHP_COMMENT_SYNTAX),
      `$url = 'http://example.com/a'; $b = 1;`
    );
    assert.strictEqual(
      stripComments(`url = "https://example.com/#frag"`, PYTHON_COMMENT_SYNTAX),
      `url = "https://example.com/#frag"`
    );
  });

  test("an unterminated string literal costs at most one line", () => {
    const source = `<p>It's here</p>\n// gone`;

    assert.strictEqual(
      stripComments(source, TS_COMMENT_SYNTAX),
      `<p>It's here</p>\n` + " ".repeat("// gone".length)
    );
  });

  test("PHP treats a hash as a comment but an attribute as code", () => {
    assert.strictEqual(
      stripComments(`$a = 1; # gone`, PHP_COMMENT_SYNTAX),
      `$a = 1; ` + " ".repeat("# gone".length)
    );
    assert.strictEqual(
      stripComments(`#[Route('/home')]`, PHP_COMMENT_SYNTAX),
      `#[Route('/home')]`
    );
  });

  test("Python leaves a docstring in place", () => {
    const source = `"""\nModule doc\n"""\nimport real\n`;

    assert.strictEqual(stripComments(source, PYTHON_COMMENT_SYNTAX), source);
  });

  test("a hash inside a docstring is blanked, and no dependency is lost", () => {
    // The lines of a docstring are read as code, so a `#` there does start a
    // comment. A docstring holds prose, never an executed import, so the blanking
    // can only remove text that was never a dependency.
    assert.strictEqual(
      stripComments(`"""\nDoc # text\n"""`, PYTHON_COMMENT_SYNTAX),
      `"""\nDoc ` + " ".repeat("# text".length) + `\n"""`
    );
  });
});

suite("TypeScript imports are read past comments", () => {
  function rawImports(content: string): string[] {
    return new TypeScriptResolver()
      .resolveImports(content, "/ws/src/entry.ts", "/ws")
      .map((imp) => imp.raw);
  }

  test("an import inside a line comment is not a dependency", () => {
    assert.deepStrictEqual(
      rawImports(`// import { ghost } from "./ghost";\nimport { real } from "./real";\n`),
      ["./real"]
    );
  });

  test("an import inside a block comment is not a dependency", () => {
    assert.deepStrictEqual(
      rawImports(`/* import { ghost } from "./ghost"; */\nimport { real } from "./real";\n`),
      ["./real"]
    );
  });

  test("an import inside a block comment spanning lines is not a dependency", () => {
    assert.deepStrictEqual(
      rawImports(`/*\nimport { ghost } from "./ghost";\n*/\nimport { real } from "./real";\n`),
      ["./real"]
    );
  });

  test("every import form is ignored inside a comment", () => {
    assert.deepStrictEqual(
      rawImports(
        `// import { a } from "./ghost";\n` +
          `// const b = await import("./ghost");\n` +
          `// const c = require("./ghost");\n` +
          `// export { d } from "./ghost";\n`
      ),
      []
    );
  });

  test("a comment trailing a real import leaves the import alone", () => {
    assert.deepStrictEqual(
      rawImports(`import { real } from "./real"; // import { ghost } from "./ghost";\n`),
      ["./real"]
    );
  });

  test("a url in a string does not swallow the import beside it", () => {
    assert.deepStrictEqual(
      rawImports(`const url = "https://example.com/x"; import { real } from "./real";\n`),
      ["./real"]
    );
  });

  test("an import written inside a string literal is still reported", () => {
    // Accepted: string literals are deliberately left alone, because an import
    // keeps its target inside one.
    assert.deepStrictEqual(rawImports(`const s = "import x from './ghost'";\n`), ["./ghost"]);
  });
});

suite("PHP imports are read past comments", () => {
  let root: string;

  suiteSetup(() => {
    root = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "file-graph-php-"))
    );
    fs.mkdirSync(path.join(root, "app", "Models"), { recursive: true });
    fs.writeFileSync(path.join(root, "app", "Models", "User.php"), "<?php\n");
    fs.writeFileSync(path.join(root, "app", "Models", "Ghost.php"), "<?php\n");
  });

  suiteTeardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function rawImports(content: string): string[] {
    return new PhpResolver()
      .resolveImports(content, path.join(root, "app", "Http", "Entry.php"), root)
      .map((imp) => imp.raw);
  }

  test("a use statement inside a comment is not a dependency", () => {
    assert.deepStrictEqual(
      rawImports(
        `<?php\n` +
          `// use App\\Models\\Ghost;\n` +
          `# use App\\Models\\Ghost;\n` +
          `/* use App\\Models\\Ghost; */\n` +
          `use App\\Models\\User;\n`
      ),
      ["App\\Models\\User"]
    );
  });

  test("a class reference inside a comment is not a dependency", () => {
    assert.deepStrictEqual(
      rawImports(`<?php\nuse App\\Models\\User;\n// App\\Models\\Ghost::class\n`),
      ["App\\Models\\User"]
    );
  });

  test("a comment trailing a use statement leaves the statement alone", () => {
    assert.deepStrictEqual(
      rawImports(`<?php\nuse App\\Models\\User; # use App\\Models\\Ghost;\n`),
      ["App\\Models\\User"]
    );
  });

  test("a class reference inside an attribute is a dependency", () => {
    assert.deepStrictEqual(
      rawImports(`<?php\n#[Isolated(App\\Models\\Ghost::class)]\nclass Entry {}\n`),
      ["App\\Models\\Ghost"]
    );
  });
});

suite("Python imports are read past comments", () => {
  function rawImports(content: string): string[] {
    return new PythonResolver()
      .resolveImports(content, "/ws/pkg/entry.py", "/ws")
      .map((imp) => imp.raw);
  }

  test("an import inside a comment is not a dependency", () => {
    assert.deepStrictEqual(
      rawImports(`# import ghost\n# from ghost_pkg import thing\nimport real\n`),
      ["real"]
    );
  });

  test("a comment trailing a real import leaves the import alone", () => {
    assert.deepStrictEqual(rawImports(`import real  # import ghost\n`), ["real"]);
  });

  test("both import forms survive alongside comments", () => {
    assert.deepStrictEqual(
      rawImports(`# import ghost\nfrom real_pkg import thing\nimport real_mod\n`),
      ["real_pkg", "real_mod"]
    );
  });

  test("an import written inside a docstring is still reported", () => {
    // Accepted: a docstring is an ordinary string literal, and telling one apart
    // from an expression string needs a real parser.
    assert.deepStrictEqual(
      rawImports(`"""\nimport ghost\n"""\nimport real\n`),
      ["ghost", "real"]
    );
  });
});
