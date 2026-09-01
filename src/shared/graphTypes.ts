// Single source of truth for the graph types shared by the extension host and
// the webview. Must stay free of vscode / fs / path / React imports so that the
// webview bundle never pulls Node-only code in.

export interface GraphNode {
  id: string;
  label: string;
  layer: string;
  isFocused: boolean;
  /**
   * The groups this file belongs to, shallow to deep. Empty when ungrouped.
   *
   * Only automatic grouping makes this an ancestor chain; a file claimed by a
   * user group rule gets that one name and nothing above it, because the rule
   * declares a group rather than a position in the directory tree. So anything
   * that treats the array as "this group and all its ancestors" is reading a
   * guarantee that half the files do not carry.
   */
  groupPath: string[];
}

/**
 * A dependency from one file to another.
 *
 * At most one per ordered pair of files. A file can reach the same target through
 * several statements, and that is still one dependency: one line drawn, one unit of
 * weight behind a group pair, one rule violation to act on.
 */
export interface GraphEdge {
  source: string;
  target: string;
  /**
   * How the dependency was written - `import`, `require`, `use` - for the reader.
   * Where several statements reach the same target, this is the first of them.
   */
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

/** A path the analysis named but could not open. */
export interface UnreadablePath {
  /** The path, relative to the workspace root. */
  path: string;
  /**
   * What went missing with it. A file keeps its node and loses every dependency it
   * declared; a directory takes its whole subtree out of the graph unseen. The two
   * are held apart rather than added up, because one number cannot say which of the
   * two a reader is looking at.
   */
  kind: "file" | "directory";
  /** The errno the read failed with: `EACCES`, `ENOENT`, `EMFILE`, `ELOOP`. */
  reason: string;
}

/**
 * The paths an analysis walked over and could not open.
 *
 * Counted for the reason `UnresolvedImports` is, one step earlier. A file whose
 * contents never arrived declares no imports, so it reaches the graph as a node with
 * nothing leaving it - the exact shape of a file that imports nothing. It is the
 * quieter of the two failures: `unresolved` stays at zero for it, and so states that
 * nothing was left out of the picture.
 */
export interface UnreadablePaths {
  /** How many, including the ones beyond `samples`. */
  count: number;
  /** The first few, so that what is missing can be named and not only counted. */
  samples: UnreadablePath[];
}

/** What one analysis run produced: the graph, and what could not be put into it. */
export interface AnalysisResult {
  graph: GraphData;
  unresolved: UnresolvedImports;
  unreadable: UnreadablePaths;
}

/** Wire envelope from the extension host to the webview. */
export interface GraphPayload {
  view: "local" | "overview";
  data: GraphData;
  structure: StructureAnalysis;
  unresolved: UnresolvedImports;
  /**
   * Carried for the same reason as `unresolved`, and required rather than optional:
   * a count that is gathered and never sent is a failure counted in private, which
   * is the silence the count exists to break.
   */
  unreadable: UnreadablePaths;
}
