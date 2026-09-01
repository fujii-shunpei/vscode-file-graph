import * as assert from "assert";
import { attachGroups, globToRegExp, resolveGroupPath } from "../../grouping";
import type { GroupConfig } from "../../grouping";
import type { GraphData } from "../../shared/graphTypes";

const WORKSPACE_ROOT = "/ws";

function config(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return { rules: [], autoDepth: 0, ...overrides };
}

suite("globToRegExp", () => {
  test("a single asterisk does not cross a separator", () => {
    const regex = globToRegExp("src/*.ts");
    assert.strictEqual(regex.test("src/App.ts"), true);
    assert.strictEqual(regex.test("src/domain/App.ts"), false);
  });

  test("a double asterisk crosses separators", () => {
    const regex = globToRegExp("src/domain/**");
    assert.strictEqual(regex.test("src/domain/User.ts"), true);
    assert.strictEqual(regex.test("src/domain/user/detail/User.ts"), true);
    assert.strictEqual(regex.test("src/app/User.ts"), false);
  });

  test("a leading double asterisk also matches zero directories", () => {
    const regex = globToRegExp("**/*.test.ts");
    assert.strictEqual(regex.test("App.test.ts"), true);
    assert.strictEqual(regex.test("src/domain/App.test.ts"), true);
    assert.strictEqual(regex.test("src/domain/App.ts"), false);
  });

  test("a question mark matches exactly one character", () => {
    const regex = globToRegExp("src/a?.ts");
    assert.strictEqual(regex.test("src/ab.ts"), true);
    assert.strictEqual(regex.test("src/a.ts"), false);
    assert.strictEqual(regex.test("src/abc.ts"), false);
    assert.strictEqual(regex.test("src/a/.ts"), false);
  });

  test("regular expression metacharacters are escaped", () => {
    assert.strictEqual(globToRegExp("src/a.ts").test("src/axts"), false);
    assert.strictEqual(globToRegExp("src/a+.ts").test("src/a+.ts"), true);
    assert.strictEqual(globToRegExp("src/a+.ts").test("src/aa.ts"), false);
    assert.strictEqual(globToRegExp("src/(x).ts").test("src/(x).ts"), true);
    assert.strictEqual(globToRegExp("src/(x).ts").test("src/x.ts"), false);
    assert.strictEqual(globToRegExp("src/[id].ts").test("src/[id].ts"), true);
    assert.strictEqual(globToRegExp("src/[id].ts").test("src/i.ts"), false);
    assert.strictEqual(globToRegExp("src/a{1}$^|.ts").test("src/a{1}$^|.ts"), true);
  });

  test("the pattern is anchored at both ends", () => {
    const regex = globToRegExp("src/*.ts");
    assert.strictEqual(regex.test("lib/src/App.ts"), false);
    assert.strictEqual(regex.test("src/App.ts.map"), false);
  });

  // 65 characters holding 32 separators. Every separator is another place a
  // `**` group can try to split the path, so a path shaped like this is what a
  // run of them costs the most to reject.
  const DEEPLY_NESTED_PATH =
    "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z/a/b/c/d/e/f/g";

  test("a long run of double asterisks is rejected in reasonable time", () => {
    const regex = globToRegExp("**/".repeat(12) + "nothing.ts");

    const startedAt = Date.now();
    assert.strictEqual(regex.test(DEEPLY_NESTED_PATH), false);
    const elapsed = Date.now() - startedAt;

    // One group per `**` made this single call take over 30 seconds, and the
    // extension runs every rule against every node. The budget is orders of
    // magnitude above what the folded pattern needs on any machine and orders of
    // magnitude below what the unfolded one ever managed, so it can only fail if
    // the exponential comes back.
    assert.ok(elapsed < 1000, `rejecting the path took ${elapsed}ms`);
  });

  test("a run of double asterisks matches what a single one matches", () => {
    const folded = globToRegExp("**/**/**/x.ts");
    const single = globToRegExp("**/x.ts");

    for (const candidate of [
      "x.ts",
      "src/x.ts",
      "src/domain/user/x.ts",
      "src/x.tsx",
      "src/y.ts",
      "xx.ts",
      "",
    ]) {
      assert.strictEqual(
        folded.test(candidate),
        single.test(candidate),
        `disagreed on ${JSON.stringify(candidate)}`
      );
    }
    assert.strictEqual(folded.test("src/domain/user/x.ts"), true);
  });

  test("a bare double asterisk in a run keeps the run free of separators", () => {
    const folded = globToRegExp("src/**/**");
    const single = globToRegExp("src/**");

    for (const candidate of [
      "src/User.ts",
      "src/domain/user/User.ts",
      "src/",
      "srcUser.ts",
      "lib/src/User.ts",
    ]) {
      assert.strictEqual(
        folded.test(candidate),
        single.test(candidate),
        `disagreed on ${JSON.stringify(candidate)}`
      );
    }
    assert.strictEqual(folded.test("src/domain/user/User.ts"), true);
    assert.strictEqual(folded.test("lib/src/User.ts"), false);
  });

  test("a run of double asterisks mixed with a single one keeps its meaning", () => {
    const folded = globToRegExp("src/**/**/*.ts");
    const single = globToRegExp("src/**/*.ts");

    for (const candidate of [
      "src/App.ts",
      "src/domain/App.ts",
      "src/domain/user/App.ts",
      "src/App.tsx",
      "lib/App.ts",
    ]) {
      assert.strictEqual(
        folded.test(candidate),
        single.test(candidate),
        `disagreed on ${JSON.stringify(candidate)}`
      );
    }
    assert.strictEqual(folded.test("src/domain/user/App.ts"), true);
    assert.strictEqual(folded.test("src/App.tsx"), false);
  });
});

suite("resolveGroupPath", () => {
  test("the first matching rule wins", () => {
    const rules = [
      { pattern: "src/domain/**", name: "Domain" },
      { pattern: "src/**", name: "Source" },
    ];
    assert.deepStrictEqual(
      resolveGroupPath("/ws/src/domain/user/User.ts", WORKSPACE_ROOT, config({ rules, autoDepth: 2 })),
      ["Domain"]
    );
    assert.deepStrictEqual(
      resolveGroupPath("/ws/src/App.tsx", WORKSPACE_ROOT, config({ rules, autoDepth: 2 })),
      ["Source"]
    );
  });

  test("rule order changes which rule is adopted", () => {
    const rules = [
      { pattern: "src/**", name: "Source" },
      { pattern: "src/domain/**", name: "Domain" },
    ];
    assert.deepStrictEqual(
      resolveGroupPath("/ws/src/domain/user/User.ts", WORKSPACE_ROOT, config({ rules })),
      ["Source"]
    );
  });

  test("unmatched files fall back to a cumulative directory chain (autoDepth 1)", () => {
    assert.deepStrictEqual(
      resolveGroupPath("/ws/src/domain/user/User.ts", WORKSPACE_ROOT, config({ autoDepth: 1 })),
      ["src"]
    );
  });

  test("unmatched files fall back to a cumulative directory chain (autoDepth 2)", () => {
    assert.deepStrictEqual(
      resolveGroupPath("/ws/src/domain/user/User.ts", WORKSPACE_ROOT, config({ autoDepth: 2 })),
      ["src", "src/domain"]
    );
  });

  test("unmatched files fall back to a cumulative directory chain (autoDepth 3)", () => {
    assert.deepStrictEqual(
      resolveGroupPath("/ws/src/domain/user/User.ts", WORKSPACE_ROOT, config({ autoDepth: 3 })),
      ["src", "src/domain", "src/domain/user"]
    );
  });

  test("the chain is capped by the actual directory depth", () => {
    assert.deepStrictEqual(
      resolveGroupPath("/ws/src/App.tsx", WORKSPACE_ROOT, config({ autoDepth: 2 })),
      ["src"]
    );
  });

  test("autoDepth 0 disables automatic grouping", () => {
    assert.deepStrictEqual(
      resolveGroupPath("/ws/src/domain/user/User.ts", WORKSPACE_ROOT, config({ autoDepth: 0 })),
      []
    );
  });

  test("a file directly under the workspace root belongs to no group", () => {
    assert.deepStrictEqual(
      resolveGroupPath("/ws/index.ts", WORKSPACE_ROOT, config({ autoDepth: 2 })),
      []
    );
  });

  test("a file resolved outside the workspace belongs to no group", () => {
    assert.deepStrictEqual(
      resolveGroupPath("/shared/util.ts", "/ws/packages/app", config({ autoDepth: 2 })),
      []
    );
    assert.deepStrictEqual(
      resolveGroupPath("/ws/shared/util.ts", "/ws/packages/app", config({ autoDepth: 2 })),
      []
    );
  });

  test("a rule does not pull a file outside the workspace into a group", () => {
    assert.deepStrictEqual(
      resolveGroupPath(
        "/ws/shared/util.ts",
        "/ws/packages/app",
        config({ rules: [{ pattern: "**", name: "Everything" }], autoDepth: 2 })
      ),
      []
    );
  });

  test("backslash separated paths are normalized before matching", () => {
    const filePath = "C:\\ws\\src\\domain\\user\\User.ts";
    assert.deepStrictEqual(
      resolveGroupPath(filePath, "C:\\ws", config({ autoDepth: 2 })),
      ["src", "src/domain"]
    );
    assert.deepStrictEqual(
      resolveGroupPath(filePath, "C:\\ws", config({ rules: [{ pattern: "src/domain/**", name: "Domain" }] })),
      ["Domain"]
    );
  });
});

suite("attachGroups", () => {
  function sampleData(): GraphData {
    return {
      nodes: [
        { id: "/ws/src/domain/user/User.ts", label: "src/domain/user/User.ts", layer: "Model", isFocused: true, groupPath: [] },
        { id: "/ws/index.ts", label: "index.ts", layer: "Other", isFocused: false, groupPath: [] },
      ],
      edges: [{ source: "/ws/index.ts", target: "/ws/src/domain/user/User.ts", type: "import" }],
    };
  }

  test("every node gets a resolved groupPath", () => {
    const result = attachGroups(sampleData(), WORKSPACE_ROOT, config({ autoDepth: 2 }));
    assert.deepStrictEqual(result.nodes[0].groupPath, ["src", "src/domain"]);
    assert.deepStrictEqual(result.nodes[1].groupPath, []);
    assert.strictEqual(result.nodes.length, 2);
  });

  test("a node outside the workspace keeps an empty groupPath", () => {
    const data: GraphData = {
      nodes: [
        { id: "/shared/util.ts", label: "../../shared/util.ts", layer: "Util", isFocused: false, groupPath: [] },
      ],
      edges: [],
    };
    const result = attachGroups(data, "/ws/packages/app", config({ autoDepth: 2 }));
    assert.deepStrictEqual(result.nodes[0].groupPath, []);
  });

  test("the input graph is not mutated", () => {
    const data = sampleData();
    const result = attachGroups(data, WORKSPACE_ROOT, config({ autoDepth: 2 }));

    assert.deepStrictEqual(data, sampleData());
    assert.notStrictEqual(result, data);
    assert.notStrictEqual(result.nodes, data.nodes);
    assert.notStrictEqual(result.nodes[0], data.nodes[0]);
  });

  test("edges are passed through unchanged", () => {
    const data = sampleData();
    const result = attachGroups(data, WORKSPACE_ROOT, config({ autoDepth: 2 }));

    assert.deepStrictEqual(result.edges, sampleData().edges);
  });

  test("node fields other than groupPath are preserved", () => {
    const data = sampleData();
    const result = attachGroups(data, WORKSPACE_ROOT, config({ autoDepth: 2 }));

    assert.deepStrictEqual(
      { ...result.nodes[0], groupPath: [] },
      data.nodes[0]
    );
  });
});
