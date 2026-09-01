import { type GraphEdge } from "../types/graph";
import { NODE_HEIGHT } from "./layout";

/**
 * A single UE5-style connection pin on a node.
 *
 * Deliberately holds no handle id: the direction of a pin is which of the two
 * `NodePins` arrays it sits in, and the handle id follows from that plus `peerId`.
 * Carrying the id as well would let an input pin be built bearing an output id, which
 * no type could reject and which React Flow answers by silently dropping the wire.
 */
export interface PinInfo {
  peerId: string;
  edgeType: string;
  peerLabel: string;
}

export interface NodePins {
  incoming: PinInfo[];
  outgoing: PinInfo[];
}

const IN_PREFIX = "in::";
const OUT_PREFIX = "out::";

/** Vertical room reserved per pin when sizing a node. */
const PIN_SPACING = 14;

/** Handle id of the input pin that faces `peerId`. */
export function inHandleId(peerId: string): string {
  return `${IN_PREFIX}${peerId}`;
}

/** Handle id of the output pin that faces `peerId`. */
export function outHandleId(peerId: string): string {
  return `${OUT_PREFIX}${peerId}`;
}

/**
 * Derive the input/output pins of every visible node from the edge list.
 * Only edges whose both endpoints are visible contribute a pin, and repeated
 * edges between the same pair collapse into a single pin so that handle ids
 * stay unique within a node.
 */
export function computeNodePins(
  edges: GraphEdge[],
  labelById: Map<string, string>,
  visibleNodeIds: Set<string>,
): Map<string, NodePins> {
  const pins = new Map<string, NodePins>();
  const seen = new Set<string>();

  const pinsOf = (nodeId: string): NodePins => {
    const existing = pins.get(nodeId);
    if (existing) return existing;
    const created: NodePins = { incoming: [], outgoing: [] };
    pins.set(nodeId, created);
    return created;
  };

  for (const edge of edges) {
    if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) {
      continue;
    }

    // NUL cannot occur in a path, so the joined key cannot collide.
    const key = `${edge.source}\0${edge.target}`;
    if (seen.has(key)) continue;
    seen.add(key);

    pinsOf(edge.source).outgoing.push({
      peerId: edge.target,
      edgeType: edge.type,
      peerLabel: labelById.get(edge.target) ?? edge.target,
    });
    pinsOf(edge.target).incoming.push({
      peerId: edge.source,
      edgeType: edge.type,
      peerLabel: labelById.get(edge.source) ?? edge.source,
    });
  }

  return pins;
}

/** Height a node needs so that its pins keep PIN_SPACING apart. Grows without an upper bound. */
export function nodeHeightFor(pins: NodePins | undefined): number {
  if (!pins) return NODE_HEIGHT;
  const pinCount = Math.max(pins.incoming.length, pins.outgoing.length);
  return Math.max(NODE_HEIGHT, (pinCount + 1) * PIN_SPACING);
}
