import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CommentSyntax,
  PHP_COMMENT_SYNTAX,
  PYTHON_COMMENT_SYNTAX,
  stripComments,
  TS_COMMENT_SYNTAX,
} from "../../resolvers/comments";
import { clearPathIdCache } from "../../paths/pathId";
import { PhpResolver } from "../../resolvers/php";
import { PythonResolver } from "../../resolvers/python";
import { TypeScriptResolver } from "../../resolvers/typescript";

suite("stripComments", () => {
  function strip(source: string, syntax: CommentSyntax): string {
    return stripComments(source, syntax).source;
  }

  test("a comment is replaced by spaces, not removed", () => {
    const source = `const a = 1; // gone\nconst b = 2;`;

    const stripped = strip(source, TS_COMMENT_SYNTAX);

    assert.strictEqual(
      stripped,
      `const a = 1; ` + " ".repeat("// gone".length) + `\nconst b = 2;`
    );
    assert.strictEqual(stripped.length, source.length);
  });

  test("a block comment keeps its newlines, so line numbers survive", () => {
    const source = `a\n/* one\ntwo */\nb`;

    const stripped = strip(source, TS_COMMENT_SYNTAX);

    assert.strictEqual(
      stripped,
      `a\n` + " ".repeat("/* one".length) + `\n` + " ".repeat("two */".length) + `\nb`
    );
    assert.strictEqual(stripped.split("\n").length, source.split("\n").length);
  });

  test("a comment marker inside a string literal starts no comment", () => {
    assert.strictEqual(
      strip(`const url = "https://example.com/a"; const b = 1;`, TS_COMMENT_SYNTAX),
      `const url = "https://example.com/a"; const b = 1;`
    );
    assert.strictEqual(
      strip(`$url = 'http://example.com/a'; $b = 1;`, PHP_COMMENT_SYNTAX),
      `$url = 'http://example.com/a'; $b = 1;`
    );
    assert.strictEqual(
      strip(`url = "https://example.com/#frag"`, PYTHON_COMMENT_SYNTAX),
      `url = "https://example.com/#frag"`
    );
  });

  test("an unterminated string literal costs at most one line", () => {
    const source = `<p>It's here</p>\n// gone`;

    assert.strictEqual(
      strip(source, TS_COMMENT_SYNTAX),
      `<p>It's here</p>\n` + " ".repeat("// gone".length)
    );
  });

  test("a template literal spanning lines is blanked whole, and the code after it is not", () => {
    // Read line by line, the second line onwards would be taken for code: the `/*`
    // there would open a block comment that nothing closes, blanking the rest of the
    // file and with it everything written after the literal.
    const source = "const s = `\n  a /* b\n`;\nconst t = 1;\n";

    const stripped = strip(source, TS_COMMENT_SYNTAX);

    assert.strictEqual(
      stripped,
      "const s =  \n" + " ".repeat("  a /* b".length) + "\n ;\nconst t = 1;\n"
    );
    assert.strictEqual(stripped.split("\n").length, source.split("\n").length);
  });

  test("a language with no multiline quote keeps every literal verbatim", () => {
    // Nothing outside TypeScript declares one, so PHP and Python are untouched by
    // the blanking above.
    assert.strictEqual(strip(`$a = '#one';`, PHP_COMMENT_SYNTAX), `$a = '#one';`);
    assert.strictEqual(strip(`a = "#one"`, PYTHON_COMMENT_SYNTAX), `a = "#one"`);
  });

  test("PHP treats a hash as a comment but an attribute as code", () => {
    assert.strictEqual(
      strip(`$a = 1; # gone`, PHP_COMMENT_SYNTAX),
      `$a = 1; ` + " ".repeat("# gone".length)
    );
    assert.strictEqual(strip(`#[Route('/home')]`, PHP_COMMENT_SYNTAX), `#[Route('/home')]`);
  });

  test("Python leaves a docstring in place", () => {
    const source = `"""\nModule doc\n"""\nimport real\n`;

    assert.strictEqual(strip(source, PYTHON_COMMENT_SYNTAX), source);
  });

  test("a hash inside a docstring spanning lines is blanked, and no dependency is lost", () => {
    // The third quote opens a literal that ends at the first newline, so the lines
    // after it are read as code and a `#` there does start a comment. A docstring
    // holds prose, never an executed import, so the blanking can only remove text
    // that was never a dependency.
    assert.strictEqual(
      strip(`"""\nDoc # text\n"""`, PYTHON_COMMENT_SYNTAX),
      `"""\nDoc ` + " ".repeat("# text".length) + `\n"""`
    );
  });

  test("a hash inside a single line docstring is kept", () => {
    // The opposite of the case above, and for the same reason: the third quote opens
    // a literal that here reaches the closing quote, so the whole text is one string
    // and nothing in it is read as code. Prose either way, so nothing is at stake.
    assert.strictEqual(strip(`"""Doc # text"""`, PYTHON_COMMENT_SYNTAX), `"""Doc # text"""`);
    assert.strictEqual(strip(`'''Doc # text'''`, PYTHON_COMMENT_SYNTAX), `'''Doc # text'''`);
  });
});

suite("stripComments reports what it never found the end of", () => {
  test("a file read whole reports nothing", () => {
    const source = `/* one */\nconst s = "two";\nimport a from './a';\n`;

    assert.deepStrictEqual(stripComments(source, TS_COMMENT_SYNTAX).unterminated, []);
  });

  test("a string closed on the last character of the file is not unterminated", () => {
    // The literal ends exactly where the file does, which is not the same as running
    // off the end of it.
    assert.deepStrictEqual(
      stripComments(`const a = "x"`, TS_COMMENT_SYNTAX).unterminated,
      []
    );
  });

  test("an unclosed block comment is reported, along with the import it swallowed", () => {
    const source = `import a from './a';\n/* never closed\nimport b from './b';\n`;

    const stripped = stripComments(source, TS_COMMENT_SYNTAX);

    assert.deepStrictEqual(stripped.unterminated, [
      { kind: "block-comment", offset: source.indexOf("/*") },
    ]);
    assert.ok(!stripped.source.includes("./b"), "the import after it was blanked");
  });

  test("an unclosed literal spanning lines is reported", () => {
    const source = "const s = `\n  never closed\n";

    assert.deepStrictEqual(stripComments(source, TS_COMMENT_SYNTAX).unterminated, [
      { kind: "string", offset: source.indexOf("`") },
    ]);
  });

  test("a literal ended by a newline is not reported", () => {
    // Accepted and bounded: a stray apostrophe costs the rest of its line, no more,
    // so there is nothing to warn about.
    assert.deepStrictEqual(
      stripComments(`<p>It's here</p>\nconst a = 1;\n`, TS_COMMENT_SYNTAX).unterminated,
      []
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

  test("an import written inside a template literal is not reported", () => {
    // The counterpart of the case above, and the reason the two differ: a specifier
    // is spelled between `'` or `"`, never between backticks, so a template literal
    // can be blanked without losing one. A code sample or a fixture written in one
    // is prose about a file, not a dependency on it.
    assert.deepStrictEqual(rawImports('const doc = `\n  import { fake } from "./fake";\n`;\n'), []);
  });

  test("an unclosed block comment inside a template literal deletes no import", () => {
    // Read line by line, the `/*` inside the literal would open a comment that
    // nothing closes, blanking every import after it.
    assert.deepStrictEqual(
      rawImports("const s = `\n  a /* b\n`;\nimport a from './a';\n"),
      ["./a"]
    );
  });

  test("a dynamic import inside an interpolation is not seen", () => {
    // Accepted, not a bug: an interpolation is code, but it is blanked along with
    // the literal that holds it. The price of blanking template literals, paid
    // because writing an import there is rare and a phantom edge costs more than a
    // missing one.
    assert.deepStrictEqual(rawImports('const x = `${(await import("./real")).x}`;\n'), []);
  });
});

suite("PHP imports are read past comments", () => {
  let root: string;

  setup(() => {
    // Node ids are canonical paths held in a cache that outlives a suite, so a run
    // that came before must not be able to answer for a path created here.
    clearPathIdCache();
  });

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
