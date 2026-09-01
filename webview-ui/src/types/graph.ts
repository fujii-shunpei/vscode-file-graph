export type {
  DependencyCycle,
  GraphData,
  GraphEdge,
  GraphNode,
  GraphPayload,
  GroupDependency,
  RuleViolation,
  StructureAnalysis,
} from "../../../src/shared/graphTypes";

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

export const GROUP_PALETTE = [
  "#4fc3f7", "#81c784", "#ffb74d", "#ba68c8", "#4db6ac",
  "#f06292", "#7986cb", "#aed581", "#ff8a65", "#9575cd",
  "#4dd0e1", "#dce775",
];

/**
 * Palette colour of a group. Groups come from user configuration, so unlike the layers
 * they cannot be enumerated in a fixed table; the colour is hashed from the group name
 * instead, which keeps it stable across renders and across sessions.
 */
export function groupColor(group: string): string {
  let hash = 0;
  for (let i = 0; i < group.length; i++) {
    hash = (hash * 31 + group.charCodeAt(i)) | 0;
  }
  return GROUP_PALETTE[Math.abs(hash) % GROUP_PALETTE.length];
}

export const LAYER_ORDER = [
  "Route", "Middleware", "Controller", "Page", "Component", "Request",
  "UseCase", "Service", "Hook", "Store", "API",
  "Event", "Job", "Mail",
  "Model", "Repository",
  "Util", "Type", "Test",
  "Migration", "Config", "Other",
];
