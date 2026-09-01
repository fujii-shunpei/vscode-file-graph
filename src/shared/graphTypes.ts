// Single source of truth for the graph types shared by the extension host and
// the webview. Must stay free of vscode / fs / path / React imports so that the
// webview bundle never pulls Node-only code in.

export interface GraphNode {
  id: string;
  label: string;
  layer: string;
  isFocused: boolean;
  /** Ancestor chain of the groups this file belongs to, shallow to deep. Empty when ungrouped. */
  groupPath: string[];
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

export interface GroupRule {
  pattern: string;
  name: string;
}

/** A strongly connected component of size 2 or more: a dependency cycle. */
export interface DependencyCycle {
  /** Stable id derived from the sorted member ids. */
  id: string;
  /** Members of the cycle. Always 2 or more. */
  memberIds: string[];
}

/** A dependency from one group to another, with the number of file dependencies behind it. */
export interface GroupDependency {
  source: string;
  target: string;
  /** How many file-level dependencies cross this group pair. */
  weight: number;
}

/** A forbidden dependency between two groups, declared by the user. */
export interface DependencyRule {
  /** Name shown when the rule is violated. */
  name: string;
  /** Group id the dependency starts from. */
  from: string;
  /** Group id the dependency must not reach. */
  to: string;
  severity: "error" | "warning";
}

/** A file dependency that breaks a rule. */
export interface RuleViolation {
  ruleName: string;
  severity: "error" | "warning";
  /** The file dependency behind the violation. */
  source: string;
  target: string;
  /** The group ids that matched the rule. */
  fromGroup: string;
  toGroup: string;
}

/** Properties derived from the graph, kept apart from the graph itself. */
export interface StructureAnalysis {
  /** Cycles between files. */
  cycles: DependencyCycle[];
  /** Cycles between groups. A file-level acyclic graph can still be cyclic at group level. */
  groupCycles: DependencyCycle[];
  groupDependencies: GroupDependency[];
  /** File dependencies that break a declared rule. */
  violations: RuleViolation[];
}

/** An import that named no file in the workspace, and so has no edge to appear as. */
export interface UnresolvedImport {
  /** The file the import was written in, relative to the workspace root. */
  file: string;
  /** The import exactly as it was written. */
  raw: string;
}

/**
 * The imports an analysis read and the graph cannot hold.
 *
 * Deliberately not part of `StructureAnalysis`. That states properties the graph has,
 * and can be recomputed from the graph at any time; these imports are never in the
 * graph to have a property. They are observed while it is built and nowhere
 * afterwards - once the graph exists, an import that reached no file is
 * indistinguishable from one that was never written, which is how a project whose
 * paths all failed to resolve could look exactly like a project with no dependencies.
 *
 * A dependency on a package outside the workspace is counted here too, in every
 * language: `import React from "react"`, `import os` and
 * `use Illuminate\Support\Facades\DB;` all name something the graph cannot hold. The
 * count therefore measures what lies outside the picture, not how many mistakes were
 * made.
 */
export interface UnresolvedImports {
  /** How many, including the ones beyond `samples`. */
  count: number;
  /** The first few, so that what is missing can be named and not only counted. */
  samples: UnresolvedImport[];
}

/** What one analysis run produced: the graph, and the imports left out of it. */
export interface AnalysisResult {
  graph: GraphData;
  unresolved: UnresolvedImports;
}

/** Wire envelope from the extension host to the webview. */
export interface GraphPayload {
  view: "local" | "overview";
  data: GraphData;
  structure: StructureAnalysis;
  unresolved: UnresolvedImports;
}
