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
