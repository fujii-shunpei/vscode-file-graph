import { type GraphEdge, type StructureAnalysis } from "../types/graph";
import { edgeId } from "./display";

/**
 * What a wire is being flagged for, beyond the kind of dependency it is.
 *
 * The three are ranked: a dependency that breaks a rule is reported as the breach
 * even when it also closes a cycle, because the rule is what the reader declared
 * and therefore what they asked to be told about.
 */
export type EdgeAccent = "error" | "warning" | "cycle";

/**
 * Colour of each accent.
 *
 * Deliberately more saturated than the pastel palette the dependency kinds use, so
 * that the vivid red reads as "broken rule" rather than as the pink of a class
 * reference, and the vivid orange as a breach rather than the amber of a `use`.
 * The cycle violet is absent from the kind palette altogether.
 */
export const STRUCTURE_COLORS: Record<EdgeAccent, string> = {
  error: "#ff1744",
  warning: "#ff9100",
  cycle: "#7c4dff",
};

const ACCENT_RANK: Record<EdgeAccent, number> = {
  error: 3,
  warning: 2,
  cycle: 1,
};

function keep(
  accents: Map<string, EdgeAccent>,
  id: string,
  accent: EdgeAccent,
): void {
  const current = accents.get(id);
  if (current !== undefined && ACCENT_RANK[current] >= ACCENT_RANK[accent]) {
    return;
  }
  accents.set(id, accent);
}

/**
 * Lay the structural findings onto the wires that are drawn for them.
 *
 * Both findings are stated about file dependencies, while a wire may stand for a
 * whole bundle of them once a group is folded, so the ends of every finding are
 * put through the same rewriting the wires went through. A bundle therefore
 * carries an accent as soon as one dependency inside it earned one, and a finding
 * that ends up inside a single folded group has no wire left to sit on and is
 * dropped.
 *
 * A file belongs to at most one cycle - cycles are strongly connected components,
 * which are disjoint - so a dependency closes a cycle exactly when both of its
 * ends belong to the same one.
 *
 * @param edges The file dependencies as the host stated them, before folding.
 * @param endpointByFileId `DisplayGraph.endpointByFileId` of the same render.
 */
export function deriveEdgeAccents(
  structure: StructureAnalysis,
  edges: GraphEdge[],
  endpointByFileId: Map<string, string>,
): Map<string, EdgeAccent> {
  const accents = new Map<string, EdgeAccent>();

  const cycleOfFile = new Map<string, string>();
  for (const cycle of structure.cycles) {
    for (const memberId of cycle.memberIds) cycleOfFile.set(memberId, cycle.id);
  }

  const drawnId = (source: string, target: string): string | null => {
    const from = endpointByFileId.get(source);
    const to = endpointByFileId.get(target);
    if (from === undefined || to === undefined || from === to) return null;
    return edgeId(from, to);
  };

  for (const edge of edges) {
    const cycle = cycleOfFile.get(edge.source);
    if (cycle === undefined || cycle !== cycleOfFile.get(edge.target)) continue;
    const id = drawnId(edge.source, edge.target);
    if (id !== null) keep(accents, id, "cycle");
  }

  for (const violation of structure.violations) {
    const id = drawnId(violation.source, violation.target);
    if (id !== null) keep(accents, id, violation.severity);
  }

  return accents;
}

/** Ids of the groups that take part in a cycle between groups. */
export function deriveCyclicGroupIds(structure: StructureAnalysis): Set<string> {
  const ids = new Set<string>();
  for (const cycle of structure.groupCycles) {
    for (const memberId of cycle.memberIds) ids.add(memberId);
  }
  return ids;
}
