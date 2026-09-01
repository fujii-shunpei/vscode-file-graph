import { useMemo, useState, useCallback } from "react";
import { useVsCode } from "./hooks/useVsCode";
import { deriveDisplay } from "./lib/display";
import {
  type EdgeAccent,
  deriveCyclicGroupIds,
  deriveEdgeAccents,
} from "./lib/structure";
import { FileGraph } from "./components/FileGraph";
import { Controls } from "./components/Controls";
import { Legend } from "./components/Legend";
import { StatusBar } from "./components/StatusBar";
import "./App.css";

export default function App() {
  const { graphPayload, openFile, setDepth } = useVsCode();
  const [depth, setLocalDepth] = useState(2);
  const [mode, setMode] = useState<"layered" | "force">("layered");
  const [disabledLayers, setDisabledLayers] = useState<Set<string>>(new Set());
  const [showGroups, setShowGroups] = useState(false);
  // Groups whose fold state the user flipped away from the default of the current
  // view. Keeping the exception rather than the absolute set means a group that only
  // appears later - a settings change renames them - still opens with the default.
  const [toggledGroupIds, setToggledGroupIds] = useState<Set<string>>(new Set());

  const graphData = graphPayload?.data ?? null;
  const structure = graphPayload?.structure ?? null;
  const unresolved = graphPayload?.unresolved ?? null;
  // Reported in both views, unlike the findings that `findingsApply` withholds: this
  // is not read off the graph but observed while it was built, and the local view
  // reads the whole workspace looking for what imports the focus, so a path it could
  // not open there is as real as one the overview met.
  const unreadable = graphPayload?.unreadable ?? null;
  const view = graphPayload?.view ?? "local";
  const groupingEnabled = view === "overview" || showGroups;

  // Whether the graph on screen is complete enough to be judged by. The local view is
  // walked outward from one file, so every node but the origin keeps only the
  // dependencies the walk arrived by and loses the rest of its fan-in (issue #15).
  // Cycles and rule violations counted over it can therefore only come out low, and a
  // "0 rule errors" that means "not looked at" is read as a clean bill of health. The
  // findings are withheld where they cannot be trusted rather than stated too small.
  const findingsApply = view === "overview";

  // "Toggled" means the opposite thing in each view, so the exceptions are dropped
  // when the view changes. Adjusting during render keeps the two in step within one
  // render pass instead of drawing the stale combination first.
  const [viewOfToggles, setViewOfToggles] = useState(view);
  if (viewOfToggles !== view) {
    setViewOfToggles(view);
    setToggledGroupIds(new Set());
  }

  // The overview is meant to be drilled into, so its groups are folded by default;
  // the local view keeps them open.
  const collapsedGroupIds = useMemo(() => {
    if (view !== "overview") return toggledGroupIds;
    const collapsed = new Set<string>();
    for (const node of graphData?.nodes ?? []) {
      for (const groupId of node.groupPath) {
        if (!toggledGroupIds.has(groupId)) collapsed.add(groupId);
      }
    }
    return collapsed;
  }, [view, graphData, toggledGroupIds]);

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

  const handleGroupsToggle = useCallback(() => {
    setShowGroups((s) => !s);
  }, []);

  const handleToggleCollapse = useCallback((groupId: string) => {
    setToggledGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
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

  const display = useMemo(
    () =>
      deriveDisplay(
        filteredNodes,
        graphData?.edges ?? [],
        visibleNodeIds,
        groupingEnabled,
        collapsedGroupIds,
      ),
    [filteredNodes, graphData, visibleNodeIds, groupingEnabled, collapsedGroupIds],
  );

  const edgeAccents = useMemo(() => {
    if (!structure) return new Map<string, EdgeAccent>();
    return deriveEdgeAccents(
      structure,
      graphData?.edges ?? [],
      display.endpointByFileId,
    );
  }, [structure, graphData, display]);

  // Only meaningful while the frames are drawn: without them there is nothing on the
  // canvas a cycle between groups could be read off.
  const cyclicGroupIds = useMemo(() => {
    if (!structure || !display.grouped) return new Set<string>();
    return deriveCyclicGroupIds(structure);
  }, [structure, display]);

  const violationCounts = useMemo(() => {
    let error = 0;
    let warning = 0;
    for (const violation of structure?.violations ?? []) {
      if (violation.severity === "error") error++;
      else warning++;
    }
    return { error, warning };
  }, [structure]);

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
        showGroups={showGroups}
        onGroupsToggle={handleGroupsToggle}
        canToggleGroups={view === "local"}
        canChangeDepth={view === "local"}
      />
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <FileGraph
          display={display}
          edgeAccents={edgeAccents}
          cyclicGroupIds={cyclicGroupIds}
          onNodeClick={openFile}
          mode={mode}
          collapsedGroupIds={collapsedGroupIds}
          onToggleCollapse={handleToggleCollapse}
        />
        <Legend
          layers={layers}
          disabledLayers={disabledLayers}
          onToggleLayer={handleToggleLayer}
        />
      </div>
      <StatusBar
        currentFile={currentFile}
        nodeCount={display.fileNodes.length}
        edgeCount={display.displayEdges.length}
        cycleCount={findingsApply ? (structure?.cycles.length ?? 0) : 0}
        groupCycleCount={
          findingsApply && display.grouped
            ? (structure?.groupCycles.length ?? 0)
            : 0
        }
        errorCount={findingsApply ? violationCounts.error : 0}
        warningCount={findingsApply ? violationCounts.warning : 0}
        unresolved={unresolved}
        unreadable={unreadable}
      />
    </div>
  );
}
