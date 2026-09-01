import * as assert from "assert";
import { findViolations } from "../../rules";
import { analyzeStructure } from "../../cycles";
import type {
  DependencyRule,
  GraphData,
  GraphEdge,
  GraphNode,
} from "../../shared/graphTypes";

function node(id: string, groupPath: string[] = []): GraphNode {
  return { id, label: id, layer: "Other", isFocused: false, groupPath };
}

function edge(source: string, target: string): GraphEdge {
  return { source, target, type: "import" };
}

function rule(overrides: Partial<DependencyRule> = {}): DependencyRule {
  return {
    name: "forbidden",
    from: "X",
    to: "Y",
    severity: "error",
    ...overrides,
  };
}

suite("findViolations", () => {
  test("a graph checked against no rule reports nothing", () => {
    const data: GraphData = {
      nodes: [node("a", ["X"]), node("b", ["Y"])],
      edges: [edge("a", "b")],
    };

    assert.deepStrictEqual(findViolations(data, []), []);
  });

  test("a dependency between the two ends of a rule is a violation", () => {
    const data: GraphData = {
      nodes: [node("a", ["X"]), node("b", ["Y"])],
      edges: [edge("a", "b")],
    };

    assert.deepStrictEqual(findViolations(data, [rule()]), [
      {
        ruleName: "forbidden",
        severity: "error",
        source: "a",
        target: "b",
        fromGroup: "X",
        toGroup: "Y",
      },
    ]);
  });

  test("a rule forbids one direction, not the pair", () => {
    const data: GraphData = {
      nodes: [node("a", ["X"]), node("b", ["Y"])],
      edges: [edge("b", "a")],
    };

    assert.deepStrictEqual(findViolations(data, [rule()]), []);
  });

  test("naming a group covers the groups nested under it", () => {
    const data: GraphData = {
      nodes: [
        node("User.ts", ["src", "src/domain", "src/domain/user"]),
        node("Client.ts", ["src", "src/infra", "src/infra/http"]),
      ],
      edges: [edge("User.ts", "Client.ts")],
    };
    const rules = [
      rule({ name: "domain is independent", from: "src/domain", to: "src/infra" }),
    ];

    assert.deepStrictEqual(findViolations(data, rules), [
      {
        ruleName: "domain is independent",
        severity: "error",
        source: "User.ts",
        target: "Client.ts",
        fromGroup: "src/domain",
        toGroup: "src/infra",
      },
    ]);
  });

  test("one dependency breaking two rules is reported once per rule", () => {
    const data: GraphData = {
      nodes: [
        node("a", ["src", "src/domain"]),
        node("b", ["src", "src/infra"]),
      ],
      edges: [edge("a", "b")],
    };
    const rules = [
      rule({ name: "narrow", from: "src/domain", to: "src/infra" }),
      rule({ name: "wide", from: "src", to: "src/infra" }),
    ];

    assert.deepStrictEqual(
      findViolations(data, rules).map((violation) => violation.ruleName),
      ["narrow", "wide"]
    );
  });

  test("a file outside every group matches no rule", () => {
    const data: GraphData = {
      nodes: [node("a"), node("b", ["Y"]), node("c", ["X"]), node("d")],
      edges: [edge("a", "b"), edge("c", "d")],
    };

    assert.deepStrictEqual(findViolations(data, [rule()]), []);
  });

  test("a group named by a glob rule is matched like any other", () => {
    const data: GraphData = {
      nodes: [node("a", ["Domain"]), node("b", ["Infrastructure"])],
      edges: [edge("a", "b")],
    };
    const rules = [rule({ from: "Domain", to: "Infrastructure" })];

    assert.deepStrictEqual(
      findViolations(data, rules).map((violation) => [
        violation.fromGroup,
        violation.toGroup,
      ]),
      [["Domain", "Infrastructure"]]
    );
  });

  test("the severity of the rule is the severity of the violation", () => {
    const data: GraphData = {
      nodes: [node("a", ["X"]), node("b", ["Y"])],
      edges: [edge("a", "b")],
    };

    assert.deepStrictEqual(
      findViolations(data, [rule({ severity: "warning" })]).map(
        (violation) => violation.severity
      ),
      ["warning"]
    );
    assert.deepStrictEqual(
      findViolations(data, [rule({ severity: "error" })]).map(
        (violation) => violation.severity
      ),
      ["error"]
    );
  });

  test("a rule naming a group no file belongs to matches nothing", () => {
    const data: GraphData = {
      nodes: [node("a", ["X"]), node("b", ["Y"])],
      edges: [edge("a", "b")],
    };
    const rules = [
      rule({ from: "Nowhere", to: "Y" }),
      rule({ from: "X", to: "Nowhere" }),
    ];

    assert.deepStrictEqual(findViolations(data, rules), []);
  });

  test("a rule with the same group at both ends forbids the dependencies inside it", () => {
    const data: GraphData = {
      nodes: [node("a", ["X"]), node("b", ["X"]), node("c", ["Y"])],
      edges: [edge("a", "b"), edge("a", "c")],
    };
    const rules = [rule({ name: "no sibling imports", from: "X", to: "X" })];

    assert.deepStrictEqual(findViolations(data, rules), [
      {
        ruleName: "no sibling imports",
        severity: "error",
        source: "a",
        target: "b",
        fromGroup: "X",
        toGroup: "X",
      },
    ]);
  });
});

suite("analyzeStructure violations", () => {
  const data: GraphData = {
    nodes: [node("a", ["X"]), node("b", ["Y"])],
    edges: [edge("a", "b")],
  };

  test("a graph analysed without rules has nothing forbidden", () => {
    assert.deepStrictEqual(analyzeStructure(data).violations, []);
  });

  test("the rules reach the analysis", () => {
    assert.deepStrictEqual(
      analyzeStructure(data, [rule()]).violations,
      findViolations(data, [rule()])
    );
    assert.strictEqual(analyzeStructure(data, [rule()]).violations.length, 1);
  });
});
