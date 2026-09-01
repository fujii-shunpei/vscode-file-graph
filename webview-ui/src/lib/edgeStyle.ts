/** Wire colour per dependency kind (the `type` field of a GraphEdge). */
export const EDGE_TYPE_COLORS: Record<string, string> = {
  "import": "#4fc3f7",
  "dynamic-import": "#4dd0e1",
  "require": "#81c784",
  "re-export": "#ba68c8",
  "use": "#ffb74d",
  "class-ref": "#f06292",
  "from-import": "#aed581",
};

/** Neutral colour used for edge kinds without a dedicated colour. */
export const DEFAULT_EDGE_COLOR = "#888888";

/** Resolve the wire colour for an edge kind. Unknown kinds fall back to the neutral colour. */
export function edgeColorFor(type: string): string {
  return EDGE_TYPE_COLORS[type] ?? DEFAULT_EDGE_COLOR;
}
