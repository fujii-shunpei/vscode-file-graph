// Types mirror src/analyzer.ts (extension host). Keep in sync.
export interface GraphNode {
  id: string;
  label: string;
  layer: string;
  isFocused: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const LAYER_COLORS: Record<string, string> = {
  Route: "#fff176",
  Middleware: "#a1887f",
  Controller: "#4fc3f7",
  Request: "#ce93d8",
  UseCase: "#81c784",
  Service: "#aed581",
  Event: "#f06292",
  Job: "#ba68c8",
  Mail: "#4dd0e1",
  Model: "#ffb74d",
  Repository: "#ff8a65",
  Component: "#64b5f6",
  Hook: "#4db6ac",
  Store: "#e57373",
  Page: "#7986cb",
  API: "#ffcc80",
  Util: "#b0bec5",
  Type: "#9fa8da",
  Test: "#a5d6a7",
  Migration: "#90a4ae",
  Config: "#78909c",
  Other: "#bdbdbd",
};

export const LAYER_ORDER = [
  "Route", "Middleware", "Controller", "Page", "Component", "Request",
  "UseCase", "Service", "Hook", "Store", "API",
  "Event", "Job", "Mail",
  "Model", "Repository",
  "Util", "Type", "Test",
  "Migration", "Config", "Other",
];
