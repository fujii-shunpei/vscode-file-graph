import { type GraphNode, LAYER_ORDER } from "../types/graph";

export const NODE_WIDTH = 160;
export const NODE_HEIGHT = 40;
const LAYER_GAP_Y = 100;
const NODE_GAP_X = 200;

/** Vertical breathing room kept between two layer rows. */
const ROW_GAP_Y = LAYER_GAP_Y - NODE_HEIGHT;

/**
 * Nodes a single row may hold before the layer wraps onto another row.
 *
 * Without it a populous layer becomes one row as wide as the whole layer, which the
 * overview turns into a frame tens of thousands of pixels wide that no zoom level can
 * fit. Ordinary graphs stay below the cap and keep their previous single-row shape.
 */
const MAX_ROW_NODES = 24;

/**
 * Stack nodes into rows ordered by layer.
 *
 * @param nodeHeights Per-node heights; nodes missing from the map use NODE_HEIGHT.
 */
export function computeLayeredPositions(
  graphNodes: GraphNode[],
  nodeHeights?: Map<string, number>,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();

  // Group nodes by layer.
  const layerBuckets = new Map<string, GraphNode[]>();
  for (const node of graphNodes) {
    const bucket = layerBuckets.get(node.layer) ?? [];
    bucket.push(node);
    layerBuckets.set(node.layer, bucket);
  }

  // Walk LAYER_ORDER to assign y positions; unknown layers go at the end.
  const orderedLayers: string[] = [
    ...LAYER_ORDER.filter((l) => layerBuckets.has(l)),
    ...[...layerBuckets.keys()].filter((l) => !LAYER_ORDER.includes(l)),
  ];

  let rowY = 0;
  for (const layer of orderedLayers) {
    const bucket = layerBuckets.get(layer);
    if (!bucket || bucket.length === 0) continue;

    for (let start = 0; start < bucket.length; start += MAX_ROW_NODES) {
      const row = bucket.slice(start, start + MAX_ROW_NODES);
      const totalWidth = row.length * NODE_GAP_X;
      const startX = -totalWidth / 2 + NODE_GAP_X / 2;

      let tallest = NODE_HEIGHT;
      for (let i = 0; i < row.length; i++) {
        positions.set(row[i].id, {
          x: startX + i * NODE_GAP_X,
          y: rowY,
        });
        tallest = Math.max(tallest, nodeHeights?.get(row[i].id) ?? NODE_HEIGHT);
      }
      rowY += tallest + ROW_GAP_Y;
    }
  }

  return positions;
}

/**
 * Spread nodes evenly over a circle.
 *
 * @param nodeHeights Per-node heights; nodes missing from the map use NODE_HEIGHT.
 * The radius grows until two neighbours are far enough apart for the tallest node,
 * because a node stretched by its pins would otherwise cover the ones beside it.
 */
export function computeCirclePositions(
  graphNodes: GraphNode[],
  nodeHeights?: Map<string, number>,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const count = graphNodes.length;
  if (count === 0) return positions;

  let tallest = NODE_HEIGHT;
  for (const node of graphNodes) {
    tallest = Math.max(tallest, nodeHeights?.get(node.id) ?? NODE_HEIGHT);
  }

  // Two boxes can only overlap when they are closer than NODE_WIDTH horizontally
  // AND than `tallest` vertically, so that diagonal is the separation to keep.
  const minSeparation = Math.hypot(NODE_WIDTH, tallest);
  const spacedRadius =
    count > 1 ? minSeparation / (2 * Math.sin(Math.PI / count)) : 0;
  const radius = Math.max(200, count * 30, spacedRadius);

  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    positions.set(graphNodes[i].id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  }

  return positions;
}
