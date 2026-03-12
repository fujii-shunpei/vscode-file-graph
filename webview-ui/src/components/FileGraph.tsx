import {
  type FC,
  type CSSProperties,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
  type NodeTypes,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  type GraphData,
  type GraphNode,
  LAYER_COLORS,
  LAYER_ORDER,
} from "../types/graph";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NODE_WIDTH = 160;
const NODE_HEIGHT = 40;
const LAYER_GAP_Y = 100;
const NODE_GAP_X = 200;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FileGraphProps {
  graphData: GraphData;
  filteredNodes: GraphNode[];
  visibleNodeIds: Set<string>;
  onNodeClick: (filePath: string) => void;
  mode: "layered" | "force";
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
}

// ---------------------------------------------------------------------------
// Custom node component
// ---------------------------------------------------------------------------

const FileNode: FC<NodeProps<Node<FileNodeData>>> = memo(({ data }) => {
  const layerColor = LAYER_COLORS[data.layer] ?? LAYER_COLORS.Other;
  const focused = data.isFocused;
  const dimmed = data.dimmed;

  const style: CSSProperties = {
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
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
    cursor: "pointer",
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
      <Handle
        type="target"
        position={Position.Left}
        style={{ visibility: "hidden", width: 0, height: 0 }}
      />
      <div style={style}>
        <span style={nameStyle}>{fileName(data.label)}</span>
        {dir && <span style={dirStyle}>{dir}</span>}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        style={{ visibility: "hidden", width: 0, height: 0 }}
      />
    </>
  );
});

FileNode.displayName = "FileNode";

const nodeTypes: NodeTypes = { fileNode: FileNode };

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function computeLayeredPositions(
  graphNodes: GraphNode[],
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

  let rowIndex = 0;
  for (const layer of orderedLayers) {
    const bucket = layerBuckets.get(layer);
    if (!bucket || bucket.length === 0) continue;

    const totalWidth = bucket.length * NODE_GAP_X;
    const startX = -totalWidth / 2 + NODE_GAP_X / 2;

    for (let i = 0; i < bucket.length; i++) {
      positions.set(bucket[i].id, {
        x: startX + i * NODE_GAP_X,
        y: rowIndex * LAYER_GAP_Y,
      });
    }
    rowIndex++;
  }

  return positions;
}

function computeCirclePositions(
  graphNodes: GraphNode[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const count = graphNodes.length;
  if (count === 0) return positions;

  const radius = Math.max(200, count * 30);
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    positions.set(graphNodes[i].id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  }

  return positions;
}

// ---------------------------------------------------------------------------
// Build React Flow nodes & edges
// ---------------------------------------------------------------------------

function buildNodes(
  graphNodes: GraphNode[],
  positions: Map<string, { x: number; y: number }>,
  dimmedNodeIds: Set<string>,
): Node<FileNodeData>[] {
  return graphNodes.map((gn) => {
    const pos = positions.get(gn.id) ?? { x: 0, y: 0 };
    return {
      id: gn.id,
      type: "fileNode",
      position: pos,
      data: {
        label: gn.label,
        layer: gn.layer,
        isFocused: gn.isFocused,
        dimmed: dimmedNodeIds.has(gn.id),
      },
      draggable: true,
    };
  });
}

function buildEdges(
  graphData: GraphData,
  visibleNodeIds: Set<string>,
  highlightedEdgeIds: Set<string>,
): Edge[] {
  return graphData.edges
    .filter(
      (ge) => visibleNodeIds.has(ge.source) && visibleNodeIds.has(ge.target),
    )
    .map((ge) => {
      const id = `${ge.source}->${ge.target}`;
      const highlighted = highlightedEdgeIds.has(id);
      return {
        id,
        source: ge.source,
        target: ge.target,
        type: "default",
        style: {
          stroke: highlighted ? "#aaa" : "#666",
          strokeWidth: highlighted ? 2 : 1,
          opacity: highlighted ? 1 : 0.5,
          transition: "stroke 0.15s ease, stroke-width 0.15s ease, opacity 0.15s ease",
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: highlighted ? "#aaa" : "#666",
        },
      };
    });
}

// ---------------------------------------------------------------------------
// FileGraph component
// ---------------------------------------------------------------------------

export const FileGraph: FC<FileGraphProps> = ({
  graphData,
  filteredNodes,
  visibleNodeIds,
  onNodeClick,
  mode,
}) => {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<FileNodeData>>(
    [],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // ---- Hover-highlight bookkeeping -----------------------------------------

  const { connectedNodeIds, highlightedEdgeIds } = useMemo(() => {
    if (hoveredNodeId === null || !visibleNodeIds.has(hoveredNodeId)) {
      return {
        connectedNodeIds: new Set<string>(),
        highlightedEdgeIds: new Set<string>(),
      };
    }

    const connected = new Set<string>();
    const highlighted = new Set<string>();
    connected.add(hoveredNodeId);

    for (const e of graphData.edges) {
      if (!visibleNodeIds.has(e.source) || !visibleNodeIds.has(e.target))
        continue;

      if (e.source === hoveredNodeId || e.target === hoveredNodeId) {
        connected.add(e.source);
        connected.add(e.target);
        highlighted.add(`${e.source}->${e.target}`);
      }
    }

    return { connectedNodeIds: connected, highlightedEdgeIds: highlighted };
  }, [hoveredNodeId, graphData.edges, visibleNodeIds]);

  const dimmedNodeIds = useMemo(() => {
    if (hoveredNodeId === null) return new Set<string>();
    const dimmed = new Set<string>();
    for (const id of visibleNodeIds) {
      if (!connectedNodeIds.has(id)) dimmed.add(id);
    }
    return dimmed;
  }, [hoveredNodeId, visibleNodeIds, connectedNodeIds]);

  // ---- Layout (only recomputed when data or mode changes, NOT on hover) -----

  const positions = useMemo(
    () =>
      mode === "layered"
        ? computeLayeredPositions(filteredNodes)
        : computeCirclePositions(filteredNodes),
    [filteredNodes, mode],
  );

  // ---- Build nodes/edges when layout OR graph data changes ----------------

  useEffect(() => {
    setNodes(buildNodes(filteredNodes, positions, new Set()));
    setEdges(buildEdges(graphData, visibleNodeIds, new Set()));
  }, [graphData, filteredNodes, visibleNodeIds, positions, setNodes, setEdges]);

  // ---- Patch dimming/highlighting on hover (no layout recomputation) ------

  useEffect(() => {
    setNodes((prev) =>
      prev.map((node) => {
        const shouldDim = dimmedNodeIds.has(node.id);
        if (node.data.dimmed === shouldDim) return node;
        return { ...node, data: { ...node.data, dimmed: shouldDim } };
      }),
    );
    setEdges((prev) =>
      prev.map((edge) => {
        const highlighted = highlightedEdgeIds.has(edge.id);
        const prevHighlighted = edge.style?.strokeWidth === 2;
        if (highlighted === prevHighlighted) return edge;
        return {
          ...edge,
          style: {
            ...edge.style,
            stroke: highlighted ? "#aaa" : "#666",
            strokeWidth: highlighted ? 2 : 1,
            opacity: highlighted ? 1 : 0.5,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: highlighted ? "#aaa" : "#666",
          },
        };
      }),
    );
  }, [dimmedNodeIds, highlightedEdgeIds, setNodes, setEdges]);

  // ---- Callbacks -----------------------------------------------------------

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      onNodeClick(node.id);
    },
    [onNodeClick],
  );

  const handleNodeMouseEnter = useCallback(
    (_event: React.MouseEvent, node: Node) => {
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
        onNodeClick={handleNodeClick}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        nodeTypes={nodeTypes}
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
