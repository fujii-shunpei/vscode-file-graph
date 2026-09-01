import { findViolations } from "./rules";
import type {
  DependencyCycle,
  DependencyRule,
  GraphData,
  GraphNode,
  GroupDependency,
  StructureAnalysis,
} from "./shared/graphTypes";

/** A directed graph reduced to what cycle detection needs: a vertex set and its outgoing edges. */
interface DirectedGraph {
  vertexIds: string[];
  outgoing: Map<string, string[]>;
}

function buildDirectedGraph(
  vertexIds: string[],
  edges: readonly { source: string; target: string }[]
): DirectedGraph {
  const outgoing = new Map<string, string[]>(vertexIds.map((id) => [id, []]));

  for (const edge of edges) {
    // A vertex depending on itself is a loop on one vertex, not a cycle between
    // vertices. The analyzer emits no such edge today; dropping it here keeps
    // that assumption out of the algorithm.
    if (edge.source === edge.target) continue;
    outgoing.get(edge.source)?.push(edge.target);
  }

  return { vertexIds, outgoing };
}

/**
 * Group the vertices into strongly connected components with Tarjan's algorithm.
 *
 * The walk carries its own stack instead of recursing: `analyzeOverview` yields a
 * vertex per source file in the workspace, and a chain of a few thousand files
 * would cost one call frame each and overflow the JavaScript stack.
 */
function findStronglyConnectedComponents(graph: DirectedGraph): string[][] {
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let nextIndex = 0;

  const enter = (vertex: string): void => {
    indices.set(vertex, nextIndex);
    lowlinks.set(vertex, nextIndex);
    nextIndex++;
    stack.push(vertex);
    onStack.add(vertex);
  };

  for (const start of graph.vertexIds) {
    if (indices.has(start)) continue;

    enter(start);
    // Each frame remembers how far the outgoing edges of its vertex are explored,
    // which is what the recursive form keeps in the loop variable of a call frame.
    const frames: { vertex: string; edgeIndex: number }[] = [
      { vertex: start, edgeIndex: 0 },
    ];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const targets = graph.outgoing.get(frame.vertex) ?? [];

      if (frame.edgeIndex < targets.length) {
        const target = targets[frame.edgeIndex];
        frame.edgeIndex++;

        if (!indices.has(target)) {
          enter(target);
          frames.push({ vertex: target, edgeIndex: 0 });
        } else if (onStack.has(target)) {
          lowlinks.set(
            frame.vertex,
            Math.min(lowlinks.get(frame.vertex)!, indices.get(target)!)
          );
        }
        continue;
      }

      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) {
        lowlinks.set(
          parent.vertex,
          Math.min(lowlinks.get(parent.vertex)!, lowlinks.get(frame.vertex)!)
        );
      }

      // A vertex that never reached back past itself is the root of a component,
      // so everything stacked above it belongs to that component.
      if (lowlinks.get(frame.vertex) === indices.get(frame.vertex)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.vertex) break;
        }
        components.push(component);
      }
    }
  }

  return components;
}

/**
 * Derive the id of a cycle from its sorted members.
 * JSON encoding rather than a plain join: file paths and user defined group names
 * may hold any character, so a separator could appear inside a member and let two
 * different cycles answer to one id.
 */
function toCycleId(sortedMemberIds: string[]): string {
  return JSON.stringify(sortedMemberIds);
}

/**
 * Keep the components that are cycles.
 * Every vertex sits in a component, so a component of one is only a vertex with no
 * way back to itself. Members are sorted to make the cycle the same value however
 * the walk happened to reach it.
 */
function toCycles(components: string[][]): DependencyCycle[] {
  const cycles: DependencyCycle[] = [];
  for (const component of components) {
    if (component.length < 2) continue;
    const memberIds = [...component].sort();
    cycles.push({ id: toCycleId(memberIds), memberIds });
  }
  return cycles;
}

/** The group a file belongs to: the deepest of its chain, or null when it belongs to none. */
function deepestGroup(node: GraphNode): string | null {
  return node.groupPath.length > 0
    ? node.groupPath[node.groupPath.length - 1]
    : null;
}

/**
 * Collapse the file dependencies into dependencies between groups, counting how many
 * of them stand behind each pair.
 * A file outside every group has no group to speak for it, so an edge touching one is
 * not a group dependency; neither is an edge that stays inside a single group.
 */
function collectGroupDependencies(data: GraphData): GroupDependency[] {
  const groupOfNode = new Map<string, string>();
  for (const node of data.nodes) {
    const group = deepestGroup(node);
    if (group !== null) groupOfNode.set(node.id, group);
  }

  const dependencies: GroupDependency[] = [];
  const bySourceGroup = new Map<string, Map<string, GroupDependency>>();

  for (const edge of data.edges) {
    const source = groupOfNode.get(edge.source);
    const target = groupOfNode.get(edge.target);
    if (source === undefined || target === undefined || source === target) {
      continue;
    }

    let byTargetGroup = bySourceGroup.get(source);
    if (!byTargetGroup) {
      byTargetGroup = new Map();
      bySourceGroup.set(source, byTargetGroup);
    }

    const existing = byTargetGroup.get(target);
    if (existing) {
      existing.weight++;
    } else {
      const dependency: GroupDependency = { source, target, weight: 1 };
      byTargetGroup.set(target, dependency);
      dependencies.push(dependency);
    }
  }

  return dependencies;
}

/**
 * Read the structural properties out of a graph: which files depend on each other in a
 * circle, which groups do, how heavy each group dependency is, and which dependencies
 * break a rule.
 *
 * The two cycle sets are separate answers, not one refined into the other: files that
 * only ever depend downwards can still put their groups in a circle, and a cycle
 * between files inside one group is invisible at group level.
 *
 * Expects the graph to carry the groups already, as `attachGroups` leaves them.
 *
 * @param rules Forbidden dependencies between groups. Everything not declared is
 * allowed, so an empty list is the answer "nothing is forbidden" rather than a
 * missing argument.
 */
export function analyzeStructure(
  data: GraphData,
  rules: DependencyRule[] = []
): StructureAnalysis {
  const fileGraph = buildDirectedGraph(
    data.nodes.map((node) => node.id),
    data.edges
  );

  const groupDependencies = collectGroupDependencies(data);
  const groupIds = [
    ...new Set(
      data.nodes
        .map(deepestGroup)
        .filter((group): group is string => group !== null)
    ),
  ];
  const groupGraph = buildDirectedGraph(groupIds, groupDependencies);

  return {
    cycles: toCycles(findStronglyConnectedComponents(fileGraph)),
    groupCycles: toCycles(findStronglyConnectedComponents(groupGraph)),
    groupDependencies,
    violations: findViolations(data, rules),
  };
}
