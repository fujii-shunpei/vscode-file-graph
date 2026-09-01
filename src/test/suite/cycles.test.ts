import * as assert from "assert";
import { analyzeStructure } from "../../cycles";
import type {
  DependencyCycle,
  GraphData,
  GraphEdge,
  GraphNode,
  GroupDependency,
} from "../../shared/graphTypes";

function node(id: string, groupPath: string[] = []): GraphNode {
  return { id, label: id, layer: "Other", isFocused: false, groupPath };
}

function edge(source: string, target: string): GraphEdge {
  return { source, target, type: "import" };
}

/** Cycles carry no order of their own, so they are lined up before being compared. */
function membersOf(cycles: DependencyCycle[]): string[][] {
  return cycles
    .map((cycle) => cycle.memberIds)
    .sort((a, b) => a.join().localeCompare(b.join()));
}

function sorted(dependencies: GroupDependency[]): GroupDependency[] {
  return [...dependencies].sort((a, b) =>
    `${a.source}->${a.target}`.localeCompare(`${b.source}->${b.target}`)
  );
}

suite("analyzeStructure", () => {
  suite("cycles between files", () => {
    test("a graph without a cycle reports none", () => {
      const data: GraphData = {
        nodes: [node("a"), node("b"), node("c")],
        edges: [edge("a", "b"), edge("b", "c"), edge("a", "c")],
      };

      assert.deepStrictEqual(analyzeStructure(data).cycles, []);
    });

    test("two files depending on each other are one cycle", () => {
      const data: GraphData = {
        nodes: [node("a"), node("b")],
        edges: [edge("a", "b"), edge("b", "a")],
      };

      assert.deepStrictEqual(membersOf(analyzeStructure(data).cycles), [
        ["a", "b"],
      ]);
    });

    test("a cycle spanning three files is one cycle", () => {
      const data: GraphData = {
        nodes: [node("a"), node("b"), node("c"), node("d")],
        edges: [
          edge("a", "b"),
          edge("b", "c"),
          edge("c", "a"),
          edge("c", "d"),
        ],
      };

      assert.deepStrictEqual(membersOf(analyzeStructure(data).cycles), [
        ["a", "b", "c"],
      ]);
    });

    test("separate cycles are reported separately", () => {
      const data: GraphData = {
        nodes: [node("a"), node("b"), node("c"), node("d"), node("e")],
        edges: [
          edge("a", "b"),
          edge("b", "a"),
          edge("c", "d"),
          edge("d", "c"),
          edge("a", "e"),
          edge("e", "c"),
        ],
      };

      assert.deepStrictEqual(membersOf(analyzeStructure(data).cycles), [
        ["a", "b"],
        ["c", "d"],
      ]);
    });

    test("a file depending on itself is not a cycle", () => {
      const data: GraphData = {
        nodes: [node("a"), node("b")],
        edges: [edge("a", "a"), edge("a", "b")],
      };

      assert.deepStrictEqual(analyzeStructure(data).cycles, []);
    });

    test("the id does not depend on the order the cycle is walked", () => {
      const forwards: GraphData = {
        nodes: [node("a"), node("b"), node("c")],
        edges: [edge("a", "b"), edge("b", "c"), edge("c", "a")],
      };
      const backwards: GraphData = {
        nodes: [node("c"), node("b"), node("a")],
        edges: [edge("c", "a"), edge("b", "c"), edge("a", "b")],
      };

      assert.strictEqual(
        analyzeStructure(forwards).cycles[0].id,
        analyzeStructure(backwards).cycles[0].id
      );
    });

    test("two different cycles do not share an id", () => {
      const data: GraphData = {
        nodes: [node("a"), node("b"), node("c"), node("d")],
        edges: [
          edge("a", "b"),
          edge("b", "a"),
          edge("c", "d"),
          edge("d", "c"),
        ],
      };
      const ids = analyzeStructure(data).cycles.map((cycle) => cycle.id);

      assert.strictEqual(new Set(ids).size, 2);
    });
  });

  suite("dependencies between groups", () => {
    test("the deepest group of the chain is the one that depends", () => {
      const data: GraphData = {
        nodes: [node("a", ["src", "src/x"]), node("b", ["src", "src/y"])],
        edges: [edge("a", "b")],
      };

      assert.deepStrictEqual(analyzeStructure(data).groupDependencies, [
        { source: "src/x", target: "src/y", weight: 1 },
      ]);
    });

    test("a file outside every group is not part of a group dependency", () => {
      const data: GraphData = {
        nodes: [node("a", ["X"]), node("b")],
        edges: [edge("a", "b"), edge("b", "a")],
      };
      const structure = analyzeStructure(data);

      assert.deepStrictEqual(structure.groupDependencies, []);
      assert.deepStrictEqual(structure.groupCycles, []);
    });

    test("an edge that stays inside one group is not a group dependency", () => {
      const data: GraphData = {
        nodes: [node("a", ["X"]), node("b", ["X"]), node("c", ["Y"])],
        edges: [edge("a", "b"), edge("b", "c")],
      };

      assert.deepStrictEqual(analyzeStructure(data).groupDependencies, [
        { source: "X", target: "Y", weight: 1 },
      ]);
    });

    test("the weight counts the file dependencies behind the group pair", () => {
      const data: GraphData = {
        nodes: [
          node("a1", ["X"]),
          node("a2", ["X"]),
          node("b1", ["Y"]),
          node("b2", ["Y"]),
        ],
        edges: [
          edge("a1", "b1"),
          edge("a2", "b1"),
          edge("a2", "b2"),
          edge("a1", "a2"),
        ],
      };

      assert.deepStrictEqual(analyzeStructure(data).groupDependencies, [
        { source: "X", target: "Y", weight: 3 },
      ]);
    });

    test("each direction of a group pair is counted on its own", () => {
      const data: GraphData = {
        nodes: [node("a", ["X"]), node("b", ["Y"]), node("c", ["Y"])],
        edges: [edge("a", "b"), edge("b", "a"), edge("c", "a")],
      };

      assert.deepStrictEqual(sorted(analyzeStructure(data).groupDependencies), [
        { source: "X", target: "Y", weight: 1 },
        { source: "Y", target: "X", weight: 2 },
      ]);
    });
  });

  suite("cycles between groups", () => {
    test("files that never depend in a circle can still put their groups in one", () => {
      const data: GraphData = {
        nodes: [
          node("a.ts", ["X"]),
          node("b.ts", ["Y"]),
          node("c.ts", ["Y"]),
          node("d.ts", ["X"]),
        ],
        edges: [edge("a.ts", "b.ts"), edge("c.ts", "d.ts")],
      };
      const structure = analyzeStructure(data);

      assert.deepStrictEqual(structure.cycles, []);
      assert.deepStrictEqual(membersOf(structure.groupCycles), [["X", "Y"]]);
    });

    test("groups that only depend downwards report no cycle", () => {
      const data: GraphData = {
        nodes: [node("a", ["X"]), node("b", ["Y"]), node("c", ["Z"])],
        edges: [edge("a", "b"), edge("b", "c"), edge("a", "c")],
      };

      assert.deepStrictEqual(analyzeStructure(data).groupCycles, []);
    });

    test("a cycle between files inside one group is no cycle between groups", () => {
      const data: GraphData = {
        nodes: [node("a", ["X"]), node("b", ["X"])],
        edges: [edge("a", "b"), edge("b", "a")],
      };
      const structure = analyzeStructure(data);

      assert.deepStrictEqual(membersOf(structure.cycles), [["a", "b"]]);
      assert.deepStrictEqual(structure.groupCycles, []);
    });

    test("a cycle spanning three groups is one cycle", () => {
      const data: GraphData = {
        nodes: [node("a", ["X"]), node("b", ["Y"]), node("c", ["Z"])],
        edges: [edge("a", "b"), edge("b", "c"), edge("c", "a")],
      };

      assert.deepStrictEqual(membersOf(analyzeStructure(data).groupCycles), [
        ["X", "Y", "Z"],
      ]);
    });
  });

  suite("large graphs", () => {
    const SIZE = 5000;

    function chain(): GraphData {
      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      for (let i = 0; i < SIZE; i++) {
        nodes.push(node(`file${i}`, [`group${i}`]));
        if (i > 0) edges.push(edge(`file${i - 1}`, `file${i}`));
      }
      return { nodes, edges };
    }

    test("a chain of five thousand files is walked without overflowing the stack", () => {
      const structure = analyzeStructure(chain());

      assert.deepStrictEqual(structure.cycles, []);
      assert.deepStrictEqual(structure.groupCycles, []);
      assert.strictEqual(structure.groupDependencies.length, SIZE - 1);
    });

    test("a cycle of five thousand files is reported as one cycle", () => {
      const data = chain();
      data.edges.push(edge(`file${SIZE - 1}`, "file0"));
      const structure = analyzeStructure(data);

      assert.strictEqual(structure.cycles.length, 1);
      assert.strictEqual(structure.cycles[0].memberIds.length, SIZE);
      assert.strictEqual(structure.groupCycles.length, 1);
      assert.strictEqual(structure.groupCycles[0].memberIds.length, SIZE);
    });
  });
});
