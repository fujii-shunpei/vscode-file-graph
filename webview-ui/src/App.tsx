import { useMemo, useState, useCallback } from "react";
import { useVsCode } from "./hooks/useVsCode";
import { FileGraph } from "./components/FileGraph";
import { Controls } from "./components/Controls";
import { Legend } from "./components/Legend";
import { StatusBar } from "./components/StatusBar";
import "./App.css";

export default function App() {
  const { graphData, openFile, setDepth } = useVsCode();
  const [depth, setLocalDepth] = useState(2);
  const [mode, setMode] = useState<"layered" | "force">("layered");
  const [disabledLayers, setDisabledLayers] = useState<Set<string>>(new Set());

  const handleDepthChange = useCallback(
    (d: number) => {
      setLocalDepth(d);
      setDepth(d);
    },
    [setDepth],
  );

  const handleModeToggle = useCallback(() => {
    setMode((m) => (m === "layered" ? "force" : "layered"));
  }, []);

  const handleReset = useCallback(() => {
    setDisabledLayers(new Set());
  }, []);

  const handleToggleLayer = useCallback((layer: string) => {
    setDisabledLayers((prev) => {
      const next = new Set(prev);
      if (next.has(layer)) {
        next.delete(layer);
      } else {
        next.add(layer);
      }
      return next;
    });
  }, []);

  const layers = useMemo(() => {
    if (!graphData) return [];
    const counts = new Map<string, number>();
    for (const node of graphData.nodes) {
      counts.set(node.layer, (counts.get(node.layer) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count }));
  }, [graphData]);

  const currentFile = useMemo(() => {
    if (!graphData) return "";
    return graphData.nodes.find((n) => n.isFocused)?.label ?? "";
  }, [graphData]);

  const { filteredNodes, visibleNodeIds } = useMemo(() => {
    if (!graphData) return { filteredNodes: [], visibleNodeIds: new Set<string>() };
    const filtered = graphData.nodes.filter((n) => !disabledLayers.has(n.layer));
    return { filteredNodes: filtered, visibleNodeIds: new Set(filtered.map((n) => n.id)) };
  }, [graphData, disabledLayers]);

  const visibleEdgeCount = useMemo(() => {
    if (!graphData) return 0;
    return graphData.edges.filter(
      (e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target),
    ).length;
  }, [graphData, visibleNodeIds]);

  if (!graphData) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          color: "#888",
          fontSize: 14,
        }}
      >
        Waiting for graph data...
      </div>
    );
  }

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column" }}>
      <Controls
        depth={depth}
        onDepthChange={handleDepthChange}
        mode={mode}
        onModeToggle={handleModeToggle}
        onReset={handleReset}
      />
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <FileGraph
          graphData={graphData}
          filteredNodes={filteredNodes}
          visibleNodeIds={visibleNodeIds}
          onNodeClick={openFile}
          mode={mode}
        />
        <Legend
          layers={layers}
          disabledLayers={disabledLayers}
          onToggleLayer={handleToggleLayer}
        />
      </div>
      <StatusBar
        currentFile={currentFile}
        nodeCount={filteredNodes.length}
        edgeCount={visibleEdgeCount}
      />
    </div>
  );
}
