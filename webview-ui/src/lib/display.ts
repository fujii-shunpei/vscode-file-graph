import { type GraphEdge, type GraphNode } from "../types/graph";
import {
  type GroupTreeNode,
  buildGroupTree,
  deriveVisibleGraph,
} from "./grouping";

/** Everything the canvas draws for one combination of layer filters and folded groups. */
export interface DisplayGraph {
  /** True when the group frames are drawn instead of a flat canvas. */
  grouped: boolean;
  fileNodes: GraphNode[];
  displayEdges: GraphEdge[];
  /** Group forest behind the frames; empty while ungrouped. */
  tree: GroupTreeNode[];
  /** Groups drawn as a collapsed pill; empty while ungrouped. */
  collapsedGroups: GroupTreeNode[];
  /**
   * File id -> id of the node its wires end on. Identity while ungrouped, and the
   * collapsed stand-in for a folded file otherwise. Lets facts stated about file
   * dependencies - a rule violation, a cycle - be laid onto the wire that is drawn
   * for them even after folding rewrote its ends.
   */
  endpointByFileId: Map<string, string>;
}

/** React Flow id of the wire drawn for a displayed edge. */
export function edgeId(source: string, target: string): string {
  return `${source}->${target}`;
}

/**
 * Keep one edge per endpoint pair among the visible nodes.
 *
 * The analyzer emits one edge per import statement, so the same pair can appear
 * several times. Those repeats would share a React Flow edge id and a pin, which
 * breaks the wire-to-pin pairing, so only the first occurrence is kept.
 */
function uniqueEdges(edges: GraphEdge[], nodeIds: Set<string>): GraphEdge[] {
  const byPair = new Map<string, GraphEdge>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const key = `${edge.source}\0${edge.target}`;
    if (!byPair.has(key)) byPair.set(key, edge);
  }
  return [...byPair.values()];
}

/**
 * Derive what the canvas draws, so that the graph and the status bar report the
 * same set instead of each counting its own.
 *
 * Grouping only kicks in when it is enabled and at least one node carries a group,
 * otherwise the flat set is passed through unchanged.
 */
export function deriveDisplay(
  filteredNodes: GraphNode[],
  edges: GraphEdge[],
  visibleNodeIds: Set<string>,
  groupingEnabled: boolean,
  collapsedGroupIds: Set<string>,
): DisplayGraph {
  const grouped =
    groupingEnabled && filteredNodes.some((n) => n.groupPath.length > 0);

  if (!grouped) {
    return {
      grouped: false,
      fileNodes: filteredNodes,
      displayEdges: uniqueEdges(edges, visibleNodeIds),
      tree: [],
      collapsedGroups: [],
      endpointByFileId: new Map(filteredNodes.map((n) => [n.id, n.id])),
    };
  }

  const tree = buildGroupTree(filteredNodes);
  const { visibleFileNodes, collapsedGroups, visibleEdges, endpointByFileId } =
    deriveVisibleGraph(filteredNodes, edges, tree, collapsedGroupIds);

  return {
    grouped: true,
    fileNodes: visibleFileNodes,
    displayEdges: visibleEdges,
    tree,
    collapsedGroups,
    endpointByFileId,
  };
}
