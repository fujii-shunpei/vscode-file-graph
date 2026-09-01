import { type GraphEdge, type GraphNode } from "../types/graph";

/** A node of the group hierarchy derived from the `groupPath` of the file nodes. */
export interface GroupTreeNode {
  /** Cumulative group id, i.e. one element of `GraphNode.groupPath`. */
  id: string;
  /** Display name: the last segment of `id`. */
  name: string;
  depth: number;
  children: GroupTreeNode[];
  /** Files that belong to this group directly, not through a descendant. */
  fileIds: string[];
}

export interface VisibleGraph {
  visibleFileNodes: GraphNode[];
  /** Groups drawn as an expanded frame. */
  visibleGroups: GroupTreeNode[];
  /** Groups drawn as a collapsed pill: collapsed and without a collapsed ancestor. */
  collapsedGroups: GroupTreeNode[];
  visibleEdges: GraphEdge[];
  /**
   * File id -> id of the node that carries its wires: the file itself, or the
   * collapsed group standing in for it. Lets a caller holding file-level facts
   * find the wire they landed on.
   */
  endpointByFileId: Map<string, string>;
}

/** Edge kind assigned to edges whose endpoints were rewritten to a collapsed group. */
export const AGGREGATED_EDGE_TYPE = "grouped";

function lastSegment(groupId: string): string {
  const slash = groupId.lastIndexOf("/");
  return slash >= 0 ? groupId.slice(slash + 1) : groupId;
}

/**
 * Build the group forest out of the `groupPath` chains of the given nodes.
 *
 * A file is registered on the deepest group of its own chain, so every leaf group
 * owns at least one file and every intermediate group owns at least one child.
 * Nodes with an empty `groupPath` contribute nothing to the tree.
 */
export function buildGroupTree(nodes: GraphNode[]): GroupTreeNode[] {
  const roots: GroupTreeNode[] = [];
  const byId = new Map<string, GroupTreeNode>();

  for (const node of nodes) {
    let siblings = roots;
    let owner: GroupTreeNode | null = null;

    for (let depth = 0; depth < node.groupPath.length; depth++) {
      const id = node.groupPath[depth];
      let group = byId.get(id);
      if (!group) {
        group = { id, name: lastSegment(id), depth, children: [], fileIds: [] };
        byId.set(id, group);
        siblings.push(group);
      }
      owner = group;
      siblings = group.children;
    }

    if (owner) owner.fileIds.push(node.id);
  }

  return roots;
}

/**
 * Derive what is actually drawn once `collapsedGroupIds` are folded away.
 *
 * Everything below a collapsed group disappears - descendant groups included - and
 * the collapsed group itself stands in for its whole subtree. Edges that touched a
 * folded file are rewritten onto that stand-in, edges whose two ends land on the same
 * stand-in are dropped, and duplicates of the resulting endpoint pair collapse into
 * one. Only that collapse into a shared stand-in drops an edge: a dependency between
 * two files of an expanded group keeps both its ends and is drawn like any other.
 */
export function deriveVisibleGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  tree: GroupTreeNode[],
  collapsedGroupIds: Set<string>,
): VisibleGraph {
  const visibleGroups: GroupTreeNode[] = [];
  const collapsedGroups: GroupTreeNode[] = [];

  // Group id -> id of the shallowest collapsed group covering it (itself included).
  const standInByGroupId = new Map<string, string>();

  const walk = (group: GroupTreeNode, inheritedStandIn: string | null): void => {
    const standIn =
      inheritedStandIn ?? (collapsedGroupIds.has(group.id) ? group.id : null);

    if (standIn === null) {
      visibleGroups.push(group);
    } else {
      standInByGroupId.set(group.id, standIn);
      if (standIn === group.id) collapsedGroups.push(group);
    }

    for (const child of group.children) walk(child, standIn);
  };

  for (const root of tree) walk(root, null);

  const visibleFileNodes: GraphNode[] = [];
  const endpointByFileId = new Map<string, string>();

  for (const node of nodes) {
    const deepestGroupId = node.groupPath[node.groupPath.length - 1];
    const standIn =
      deepestGroupId === undefined
        ? undefined
        : standInByGroupId.get(deepestGroupId);

    endpointByFileId.set(node.id, standIn ?? node.id);
    if (standIn === undefined) visibleFileNodes.push(node);
  }

  const edgeByEndpoints = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const source = endpointByFileId.get(edge.source);
    const target = endpointByFileId.get(edge.target);
    if (source === undefined || target === undefined) continue;
    if (source === target) continue;

    const key = `${source} ${target}`;
    if (edgeByEndpoints.has(key)) continue;

    const aggregated = source !== edge.source || target !== edge.target;
    edgeByEndpoints.set(key, {
      source,
      target,
      type: aggregated ? AGGREGATED_EDGE_TYPE : edge.type,
    });
  }

  return {
    visibleFileNodes,
    visibleGroups,
    collapsedGroups,
    visibleEdges: [...edgeByEndpoints.values()],
    endpointByFileId,
  };
}
