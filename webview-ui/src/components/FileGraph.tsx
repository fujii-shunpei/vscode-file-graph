import {
  type FC,
  type CSSProperties,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useUpdateNodeInternals,
  type Node,
  type Edge,
  type NodeProps,
  type NodeTypes,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  type GraphEdge,
  type GraphNode,
  LAYER_COLORS,
  groupColor,
} from "../types/graph";
import {
  NODE_WIDTH,
  NODE_HEIGHT,
  computeLayeredPositions,
  computeCirclePositions,
} from "../lib/layout";
import { edgeColorFor } from "../lib/edgeStyle";
import {
  type NodePins as NodePinSet,
  computeNodePins,
  inHandleId,
  nodeHeightFor,
  outHandleId,
} from "../lib/nodeIO";
import { type DisplayGraph, edgeId } from "../lib/display";
import { type EdgeAccent, STRUCTURE_COLORS } from "../lib/structure";
import { type GroupBox, computeGroupedLayout } from "../lib/groupLayout";
import { NodePins } from "./NodePins";
import { GroupFrameNode, type GroupFrameNodeData } from "./GroupFrameNode";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FileGraphProps {
  /** What to draw, already derived by `deriveDisplay`. */
  display: DisplayGraph;
  /** Structural accent per wire, keyed by `edgeId`; wires absent from it are plain. */
  edgeAccents: Map<string, EdgeAccent>;
  /** Groups that take part in a cycle between groups. */
  cyclicGroupIds: Set<string>;
  onNodeClick: (filePath: string) => void;
  mode: "layered" | "force";
  collapsedGroupIds: Set<string>;
  onToggleCollapse: (groupId: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the file name (without extension) from an id / file path. */
function fileName(id: string): string {
  const base = id.split("/").pop() ?? id;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Extract the directory portion of a file path. */
function dirPath(id: string): string {
  const lastSlash = id.lastIndexOf("/");
  return lastSlash > 0 ? id.slice(0, lastSlash) : "";
}

/** Convert a hex colour to an rgba string. */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------------------------------------------------------------------------
// Custom node data
// ---------------------------------------------------------------------------

interface FileNodeData extends Record<string, unknown> {
  label: string;
  layer: string;
  isFocused: boolean;
  dimmed: boolean;
  height: number;
  /** Undefined when the file has no visible dependency at all. */
  pins?: NodePinSet;
}

type FileFlowNode = Node<FileNodeData, "fileNode">;
type GroupFlowNode = Node<GroupFrameNodeData, "groupFrame">;
type FlowNode = FileFlowNode | GroupFlowNode;

/**
 * What the hover patch needs to restyle a wire without rebuilding it: the accent
 * decides the resting stroke, and the flag says whether the wire already wears the
 * highlighted one. Reading the flag rather than the stroke keeps the two apart even
 * though a cycle wire at rest is as thick as a plain wire highlighted - both 2px. The
 * error and warning accents rest at 3px and so cannot be confused with either.
 */
interface EdgeData extends Record<string, unknown> {
  accent: EdgeAccent | null;
  highlighted: boolean;
}

type FlowEdge = Edge<EdgeData>;

// ---------------------------------------------------------------------------
// Custom node component
// ---------------------------------------------------------------------------

const FileNode: FC<NodeProps<FileFlowNode>> = memo(({ data }) => {
  const layerColor = LAYER_COLORS[data.layer] ?? LAYER_COLORS.Other;
  const focused = data.isFocused;
  const dimmed = data.dimmed;

  const style: CSSProperties = {
    width: NODE_WIDTH,
    height: data.height,
    borderRadius: 6,
    background: hexToRgba(layerColor, 0.2),
    border: `2px solid ${focused ? "var(--vscode-editor-foreground, #fff)" : layerColor}`,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    padding: "0 8px",
    boxSizing: "border-box",
    overflow: "hidden",
    opacity: dimmed ? 0.25 : 1,
    transition: "opacity 0.15s ease, border-color 0.15s ease",
    cursor: "default",
  };

  const nameStyle: CSSProperties = {
    color: "var(--vscode-editor-foreground, #fff)",
    fontSize: 12,
    fontWeight: focused ? 700 : 400,
    lineHeight: 1.2,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "100%",
  };

  const dirStyle: CSSProperties = {
    color: "var(--vscode-descriptionForeground, #999)",
    fontSize: 9,
    lineHeight: 1.2,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "100%",
  };

  const dir = dirPath(data.label);

  return (
    <>
      <div style={style}>
        <span style={nameStyle}>{fileName(data.label)}</span>
        {dir && <span style={dirStyle}>{dir}</span>}
      </div>
      <NodePins
        incoming={data.pins?.incoming ?? []}
        outgoing={data.pins?.outgoing ?? []}
      />
    </>
  );
});

FileNode.displayName = "FileNode";

const nodeTypes: NodeTypes = { fileNode: FileNode, groupFrame: GroupFrameNode };

// ---------------------------------------------------------------------------
// Build React Flow nodes & edges
// ---------------------------------------------------------------------------

function buildFileNodes(
  graphNodes: GraphNode[],
  positions: Map<string, { x: number; y: number }>,
  nodeHeights: Map<string, number>,
  pinsByNodeId: Map<string, NodePinSet>,
  dimmedNodeIds: Set<string>,
  grouped: boolean,
): FileFlowNode[] {
  return graphNodes.map((gn) => {
    const pos = positions.get(gn.id) ?? { x: 0, y: 0 };
    // Files sit inside the deepest frame of their chain; that frame is expanded,
    // otherwise the file would not be visible in the first place.
    const parentId = grouped ? gn.groupPath[gn.groupPath.length - 1] : undefined;
    return {
      id: gn.id,
      type: "fileNode",
      position: pos,
      parentId,
      extent: parentId ? "parent" : undefined,
      data: {
        label: gn.label,
        layer: gn.layer,
        isFocused: gn.isFocused,
        dimmed: dimmedNodeIds.has(gn.id),
        height: nodeHeights.get(gn.id) ?? NODE_HEIGHT,
        pins: pinsByNodeId.get(gn.id),
      },
      draggable: false,
    };
  });
}

function buildGroupNodes(
  boxes: GroupBox[],
  pinsByNodeId: Map<string, NodePinSet>,
  cyclicGroupIds: Set<string>,
  onToggleCollapse: (groupId: string) => void,
): GroupFlowNode[] {
  return boxes.map((box) => {
    const color = groupColor(box.name);
    const cyclic = cyclicGroupIds.has(box.id);
    // Expanded, the rectangle is the node style and GroupFrameNode only adds the
    // header band; collapsed, the component draws the whole pill itself.
    // A group caught in a cycle only gives up its outline, keeping the band and the
    // tint of its own colour so that it stays the group the reader recognises.
    const style: CSSProperties = box.collapsed
      ? { width: box.width, height: box.height }
      : {
          width: box.width,
          height: box.height,
          borderRadius: 6,
          border: cyclic
            ? `2px dashed ${STRUCTURE_COLORS.cycle}`
            : `1px solid ${color}`,
          background: hexToRgba(color, 0.06),
        };
    return {
      id: box.id,
      type: "groupFrame",
      position: { x: box.x, y: box.y },
      parentId: box.parentId,
      extent: box.parentId ? "parent" : undefined,
      style,
      data: {
        groupId: box.id,
        name: box.name,
        collapsed: box.collapsed,
        fileCount: box.fileCount,
        color,
        cyclic,
        pins: box.collapsed ? pinsByNodeId.get(box.id) : undefined,
        onToggleCollapse,
      },
      draggable: false,
      selectable: false,
    };
  });
}

/**
 * Absolute canvas position of every frame.
 *
 * `GroupBox` stores a nested frame relative to its parent because that is what React
 * Flow wants, but comparing one layout against the next needs a single coordinate
 * system. Pre-order guarantees a parent is already resolved when its child is read.
 */
function absoluteGroupPositions(
  boxes: GroupBox[],
): Map<string, { x: number; y: number }> {
  const absolute = new Map<string, { x: number; y: number }>();
  for (const box of boxes) {
    const parent = box.parentId ? absolute.get(box.parentId) : undefined;
    absolute.set(box.id, {
      x: (parent?.x ?? 0) + box.x,
      y: (parent?.y ?? 0) + box.y,
    });
  }
  return absolute;
}

/**
 * The one group whose fold state differs between the two sets, or null when the
 * difference is not exactly one group - a fresh payload, a view switch, no change.
 */
function toggledGroupId(
  previous: Set<string>,
  next: Set<string>,
): string | null {
  let found: string | null = null;
  for (const id of next) {
    if (previous.has(id)) continue;
    if (found !== null) return null;
    found = id;
  }
  for (const id of previous) {
    if (next.has(id)) continue;
    if (found !== null) return null;
    found = id;
  }
  return found;
}

/**
 * Resting stroke of a wire. An accented wire rests heavier and nearly opaque, so
 * that a broken rule is read off the canvas without hunting for it.
 */
function restingStroke(accent: EdgeAccent | null): {
  width: number;
  opacity: number;
} {
  if (accent === null) return { width: 1, opacity: 0.5 };
  return { width: accent === "cycle" ? 2 : 3, opacity: 0.9 };
}

/**
 * Highlighting only thickens and clears the wire, never recolours it, so the colour
 * stays free to say what the wire is: its dependency kind, or the accent above it.
 */
function edgeStyleFor(
  color: string,
  accent: EdgeAccent | null,
  highlighted: boolean,
): CSSProperties {
  const resting = restingStroke(accent);
  return {
    stroke: color,
    strokeWidth: highlighted ? resting.width + 1 : resting.width,
    opacity: highlighted ? 1 : resting.opacity,
    transition: "stroke-width 0.15s ease, opacity 0.15s ease",
  };
}

function buildEdges(
  displayEdges: GraphEdge[],
  edgeAccents: Map<string, EdgeAccent>,
  highlightedEdgeIds: Set<string>,
): FlowEdge[] {
  return displayEdges.map((ge) => {
    const id = edgeId(ge.source, ge.target);
    const accent = edgeAccents.get(id) ?? null;
    const color = accent === null ? edgeColorFor(ge.type) : STRUCTURE_COLORS[accent];
    const highlighted = highlightedEdgeIds.has(id);
    return {
      id,
      source: ge.source,
      target: ge.target,
      sourceHandle: outHandleId(ge.target),
      targetHandle: inHandleId(ge.source),
      type: "default",
      animated: true,
      data: { accent, highlighted },
      style: edgeStyleFor(color, accent, highlighted),
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// FileGraph component
// ---------------------------------------------------------------------------

const FileGraphCanvas: FC<FileGraphProps> = ({
  display,
  edgeAccents,
  cyclicGroupIds,
  onNodeClick,
  mode,
  collapsedGroupIds,
  onToggleCollapse,
}) => {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const updateNodeInternals = useUpdateNodeInternals();
  const { getViewport, setViewport } = useReactFlow();
  // Ids are resolved against the DOM synchronously, so only nodes that already
  // rendered under the same id are refreshed - the first payload and any freshly
  // introduced id are silently skipped. Those cases still re-measure because every
  // rebuild hands React Flow new node objects and `adoptUserNodes` drops the cached
  // handle bounds of a node carrying no `measured`. Memoising the nodes would remove
  // that safety net, and this hook cannot stand in for it.
  const pendingInternalsRef = useRef<string[] | null>(null);
  /** Fold state and absolute frame positions of the layout currently on screen. */
  const anchorRef = useRef<{
    collapsedGroupIds: Set<string>;
    groupPositions: Map<string, { x: number; y: number }>;
  } | null>(null);

  // ---- What is actually drawn ----------------------------------------------

  const grouped = display.grouped;

  /** Ids that can carry a wire: visible files plus the collapsed group stand-ins. */
  const displayNodeIds = useMemo(() => {
    const ids = new Set(display.fileNodes.map((n) => n.id));
    for (const group of display.collapsedGroups) ids.add(group.id);
    return ids;
  }, [display]);

  const pinsByNodeId = useMemo(() => {
    const labelById = new Map<string, string>();
    for (const node of display.fileNodes) labelById.set(node.id, node.label);
    for (const group of display.collapsedGroups) {
      labelById.set(group.id, group.id);
    }
    return computeNodePins(display.displayEdges, labelById, displayNodeIds);
  }, [display, displayNodeIds]);

  // Collapsed pills carry pins too, so they are sized by the same rule as the files.
  const nodeHeights = useMemo(() => {
    const heights = new Map<string, number>();
    for (const node of display.fileNodes) {
      heights.set(node.id, nodeHeightFor(pinsByNodeId.get(node.id)));
    }
    for (const group of display.collapsedGroups) {
      heights.set(group.id, nodeHeightFor(pinsByNodeId.get(group.id)));
    }
    return heights;
  }, [display, pinsByNodeId]);

  // ---- Hover-highlight bookkeeping -----------------------------------------

  const { connectedNodeIds, highlightedEdgeIds } = useMemo(() => {
    if (hoveredNodeId === null || !displayNodeIds.has(hoveredNodeId)) {
      return {
        connectedNodeIds: new Set<string>(),
        highlightedEdgeIds: new Set<string>(),
      };
    }

    const connected = new Set<string>();
    const highlighted = new Set<string>();
    connected.add(hoveredNodeId);

    for (const e of display.displayEdges) {
      if (e.source === hoveredNodeId || e.target === hoveredNodeId) {
        connected.add(e.source);
        connected.add(e.target);
        highlighted.add(edgeId(e.source, e.target));
      }
    }

    return { connectedNodeIds: connected, highlightedEdgeIds: highlighted };
  }, [hoveredNodeId, display, displayNodeIds]);

  const dimmedNodeIds = useMemo(() => {
    if (hoveredNodeId === null) return new Set<string>();
    const dimmed = new Set<string>();
    for (const node of display.fileNodes) {
      if (!connectedNodeIds.has(node.id)) dimmed.add(node.id);
    }
    return dimmed;
  }, [hoveredNodeId, display, connectedNodeIds]);

  // ---- Layout (only recomputed when data or mode changes, NOT on hover) -----

  const layout = useMemo(() => {
    if (!grouped) {
      const filePositions =
        mode === "layered"
          ? computeLayeredPositions(display.fileNodes, nodeHeights)
          : computeCirclePositions(display.fileNodes, nodeHeights);
      return { filePositions, groupBoxes: [] as GroupBox[] };
    }
    return computeGroupedLayout(
      display.fileNodes,
      display.tree,
      mode,
      collapsedGroupIds,
      nodeHeights,
    );
  }, [grouped, display, mode, collapsedGroupIds, nodeHeights]);

  // ---- Keep the toggled frame still while the packing moves around it ------

  // Folding one group re-packs the whole forest: the shelf a frame lands on, and the
  // height of every row above it, both depend on the sizes of its siblings, so every
  // frame after the toggled one gets new absolute coordinates. The view is only fitted
  // once, at mount, so without this the canvas keeps pointing at the spot the frames
  // just left and the reader is shown blank canvas. Panning by the shift of the frame
  // the user actually clicked keeps that frame where they were looking and lets the
  // rest of the forest move around it.
  useEffect(() => {
    const groupPositions = absoluteGroupPositions(layout.groupBoxes);
    const previous = anchorRef.current;
    anchorRef.current = { collapsedGroupIds, groupPositions };
    if (previous === null) return;

    const toggled = toggledGroupId(previous.collapsedGroupIds, collapsedGroupIds);
    if (toggled === null) return;

    const before = previous.groupPositions.get(toggled);
    const after = groupPositions.get(toggled);
    if (before === undefined || after === undefined) return;

    const viewport = getViewport();
    setViewport({
      x: viewport.x + (before.x - after.x) * viewport.zoom,
      y: viewport.y + (before.y - after.y) * viewport.zoom,
      zoom: viewport.zoom,
    });
  }, [layout, collapsedGroupIds, getViewport, setViewport]);

  // ---- Build nodes/edges when layout OR graph data changes ----------------

  useEffect(() => {
    // React Flow requires a frame to precede the children it owns.
    setNodes([
      ...buildGroupNodes(
        layout.groupBoxes,
        pinsByNodeId,
        cyclicGroupIds,
        onToggleCollapse,
      ),
      ...buildFileNodes(
        display.fileNodes,
        layout.filePositions,
        nodeHeights,
        pinsByNodeId,
        new Set(),
        grouped,
      ),
    ]);
    setEdges(buildEdges(display.displayEdges, edgeAccents, new Set()));
    pendingInternalsRef.current = [...displayNodeIds];
  }, [
    display,
    displayNodeIds,
    edgeAccents,
    cyclicGroupIds,
    layout,
    nodeHeights,
    pinsByNodeId,
    grouped,
    onToggleCollapse,
    setNodes,
    setEdges,
  ]);

  // ---- Best-effort handle refresh after a rebuild --------------------------

  useEffect(() => {
    const pending = pendingInternalsRef.current;
    if (pending === null) return;
    pendingInternalsRef.current = null;
    updateNodeInternals(pending);
  }, [nodes, updateNodeInternals]);

  // ---- Patch dimming/highlighting on hover (no layout recomputation) ------

  useEffect(() => {
    setNodes((prev) =>
      prev.map((node) => {
        if (node.type !== "fileNode") return node;
        const shouldDim = dimmedNodeIds.has(node.id);
        if (node.data.dimmed === shouldDim) return node;
        return { ...node, data: { ...node.data, dimmed: shouldDim } };
      }),
    );
    setEdges((prev) =>
      prev.map((edge) => {
        const highlighted = highlightedEdgeIds.has(edge.id);
        if (highlighted === edge.data?.highlighted) return edge;
        const accent = edge.data?.accent ?? null;
        const resting = restingStroke(accent);
        return {
          ...edge,
          data: { accent, highlighted },
          style: {
            ...edge.style,
            strokeWidth: highlighted ? resting.width + 1 : resting.width,
            opacity: highlighted ? 1 : resting.opacity,
          },
        };
      }),
    );
  }, [dimmedNodeIds, highlightedEdgeIds, setNodes, setEdges]);

  // ---- Callbacks -----------------------------------------------------------

  const handleNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.type !== "fileNode") return;
      onNodeClick(node.id);
    },
    [onNodeClick],
  );

  const handleNodeMouseEnter = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.type !== "fileNode") return;
      setHoveredNodeId(node.id);
    },
    [],
  );

  const handleNodeMouseLeave = useCallback(() => {
    setHoveredNodeId(null);
  }, []);

  // ---- Render --------------------------------------------------------------

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDoubleClick={handleNodeDoubleClick}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        nodeTypes={nodeTypes}
        // The overview can expand into thousands of nodes at once; without this every
        // one of them stays mounted and every hover re-renders the whole canvas.
        onlyRenderVisibleElements
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        style={{ background: "var(--vscode-editor-background, #1e1e1e)" }}
      />
    </div>
  );
};

/**
 * `useUpdateNodeInternals` reads the React Flow store from context, and the store
 * `<ReactFlow>` sets up on its own is only visible to the elements nested inside it -
 * not to the component that renders it. The canvas therefore needs a store of its own
 * above it, kept here so that callers cannot render it without one.
 */
export const FileGraph: FC<FileGraphProps> = (props) => (
  <ReactFlowProvider>
    <FileGraphCanvas {...props} />
  </ReactFlowProvider>
);
