import * as fs from "fs";
import * as path from "path";
import { LanguageResolver } from "./resolvers/types";
import { clearPathIdCache, toNodeId } from "./paths/pathId";
import type {
  AnalysisResult,
  GraphData,
  GraphEdge,
  GraphNode,
  UnreadablePaths,
  UnresolvedImports,
} from "./shared/graphTypes";

export type { AnalysisResult, GraphData, GraphEdge, GraphNode };

/** How many unresolved imports an analysis names; the count still covers the rest. */
const UNRESOLVED_SAMPLE_LIMIT = 10;

/** How many unreadable paths an analysis names; the count still covers the rest. */
const UNREADABLE_SAMPLE_LIMIT = 10;

/**
 * The errno codes the filesystem answers a path with.
 *
 * Named one by one rather than accepted wholesale, so that what was never thought
 * about is still noticed. `collectFiles` recurses without a depth limit, so a deep
 * enough tree raises `RangeError: Maximum call stack size exceeded` from inside the
 * same `try` a locked directory arrives in; a `RangeError` carries no `code`, and
 * treating it as a filesystem answer would hand back the part of the workspace walked
 * before the stack ran out as if it were all of it.
 */
const FS_ERROR_CODES: ReadonlySet<string> = new Set([
  "EACCES", // no permission to read the path
  "EPERM", // the operation is not permitted on it
  "ENOENT", // gone, usually removed while the scan was running
  "ENOTDIR", // a component of the path stopped being a directory
  "EISDIR", // a directory where a file was expected
  "ELOOP", // a circle of symbolic links
  "EMFILE", // this process ran out of file descriptors
  "ENFILE", // the machine ran out of them
  "ENAMETOOLONG",
  "EIO", // the device failed
  "EBUSY",
]);

/** Whether an error is the filesystem refusing a path, rather than a fault of this code. */
function isFsError(error: unknown): error is NodeJS.ErrnoException & { code: string } {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return error instanceof Error && typeof code === "string" && FS_ERROR_CODES.has(code);
}

/**
 * What one run of the analyzer met that the graph cannot hold.
 *
 * `countedPaths` stays out of `AnalysisResult`: it says nothing about the workspace,
 * it only keeps a path that two passes both walked over from being reported as two
 * separate failures.
 */
interface ScanReport {
  unresolved: UnresolvedImports;
  unreadable: UnreadablePaths;
  countedPaths: Set<string>;
}

function newScanReport(): ScanReport {
  return {
    unresolved: { count: 0, samples: [] },
    unreadable: { count: 0, samples: [] },
    countedPaths: new Set(),
  };
}

// Extension pattern: (php|tsx?|jsx?) covers .php, .ts, .tsx, .js, .jsx
const EXT = String.raw`(php|tsx?|jsx?)`;

const LAYER_PATTERNS: Record<string, RegExp[]> = {
  Controller: [/controllers?\//i, new RegExp(`Controller\\.${EXT}$`, "i")],
  Request: [/requests?\//i, new RegExp(`Request\\.${EXT}$`, "i"), new RegExp(`\\.dto\\.${EXT}$`, "i"), /dtos?\//i],
  UseCase: [/usecases?\//i, /actions?\//i, new RegExp(`UseCase\\.${EXT}$`, "i"), new RegExp(`Action\\.${EXT}$`, "i")],
  Service: [/services?\//i, new RegExp(`Service\\.${EXT}$`, "i")],
  Model: [/models?\//i, /entities?\//i, new RegExp(`Entity\\.${EXT}$`, "i"), new RegExp(`\\.entity\\.${EXT}$`, "i")],
  Repository: [/repositor(y|ies)\//i, new RegExp(`Repository\\.${EXT}$`, "i"), new RegExp(`\\.repository\\.${EXT}$`, "i")],
  Event: [/events?\//i, new RegExp(`Event\\.${EXT}$`, "i")],
  Job: [/jobs?\//i, new RegExp(`Job\\.${EXT}$`, "i"), /queues?\//i, /workers?\//i],
  Mail: [/mail\//i, new RegExp(`Mail\\.${EXT}$`, "i")],
  Middleware: [/middleware\//i, new RegExp(`Middleware\\.${EXT}$`, "i"), new RegExp(`\\.middleware\\.${EXT}$`, "i")],
  Migration: [/migrations?\//i],
  Config: [/config\//i],
  Route: [/routes?\//i, new RegExp(`\\.routes\\.${EXT}$`, "i"), /router\//i],
  Component: [/components?\//i, new RegExp(`\\.component\\.${EXT}$`, "i")],
  Hook: [/hooks?\//i, new RegExp(`use[A-Z][\\w]*\\.${EXT}$`)],
  Store: [/stores?\//i, new RegExp(`\\.store\\.${EXT}$`, "i"), new RegExp(`\\.slice\\.${EXT}$`, "i"), /reducers?\//i],
  Page: [/pages?\//i, /views?\//i, /screens?\//i],
  API: [/(?:^|\/)api\//i, new RegExp(`\\.api\\.${EXT}$`, "i")],
  Util: [/utils?\//i, /helpers?\//i, /lib\//i],
  Type: [/types?\//i, /interfaces?\//i, new RegExp(`\\.type\\.${EXT}$`, "i"), /\.d\.ts$/i],
  Test: [/(__tests__|tests?|spec)\//i, new RegExp(`\\.(test|spec)\\.${EXT}$`, "i")],
};

function detectLayer(filePath: string): string {
  for (const [layer, patterns] of Object.entries(LAYER_PATTERNS)) {
    if (patterns.some((p) => p.test(filePath))) {
      return layer;
    }
  }
  return "Other";
}

export class DependencyAnalyzer {
  private resolvers: LanguageResolver[] = [];
  private fileCache = new Map<string, string>();

  registerResolver(resolver: LanguageResolver): void {
    this.resolvers.push(resolver);
  }

  private getResolver(filePath: string): LanguageResolver | null {
    const ext = path.extname(filePath);
    return this.resolvers.find((r) => r.fileExtensions.includes(ext)) ?? null;
  }

  /**
   * The contents of a file, or null when it could not be read.
   *
   * A failure is counted rather than passed over. The scan already named the file, so
   * a node for it reaches the graph either way; without the count, a file nothing may
   * open is drawn exactly like a file that imports nothing, and `unresolved` stays at
   * zero and says the picture is complete.
   *
   * Only successes are cached. A failure is retried on the next run so that a
   * permission or a descriptor limit that has since been lifted takes effect, and the
   * run that meets it again counts it again.
   */
  private readFile(
    filePath: string,
    workspaceRoot: string,
    report: ScanReport
  ): string | null {
    if (this.fileCache.has(filePath)) {
      return this.fileCache.get(filePath)!;
    }
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      this.fileCache.set(filePath, content);
      return content;
    } catch (e) {
      if (!isFsError(e)) throw e;
      this.recordUnreadable(report, filePath, workspaceRoot, "file", e.code);
      return null;
    }
  }

  /**
   * Build a dependency graph centered on the given file, and report what stayed out of it.
   *
   * Explores outgoing (imports) and incoming (who imports this file) dependencies
   * up to the specified depth.
   *
   * The imports that reached no file and the paths that could not be read come back
   * beside the graph rather than in it, because neither has an edge to appear as. Both
   * leave the same silence a file with no dependencies leaves, so a graph alone cannot
   * tell a workspace that depends on nothing from one whose every path failed.
   */
  analyze(
    focusFilePath: string,
    workspaceRoot: string,
    maxDepth: number = 2
  ): AnalysisResult {
    const nodes = new Map<string, GraphNode>();
    // Keyed by the pair of files, so one dependency is one edge however many
    // statements wrote it.
    const edges = new Map<string, GraphEdge>();
    const visited = new Set<string>();
    const report = newScanReport();

    // Node ids are canonical paths, so the entry points have to be canonical too:
    // otherwise the focused file gets a second node the moment an import reaches it.
    const focusId = toNodeId(focusFilePath);
    const rootId = toNodeId(workspaceRoot);

    // Add the focused file
    nodes.set(focusId, this.buildNode(focusId, rootId, true));

    // Explore outgoing dependencies (files this file imports)
    this.exploreOutgoing(
      focusId,
      rootId,
      nodes,
      edges,
      visited,
      maxDepth,
      report
    );

    // Explore incoming dependencies (files that import this file). Their own
    // unresolved imports are not counted: this pass reads every file in the
    // workspace to find the few that point here, and reporting what the rest of the
    // workspace failed to resolve would answer a question this view never asked.
    // What it could not read is counted, because a file that never opened may be one
    // that imports the focus, and its absence is an answer to what this view asks.
    this.exploreIncoming(
      focusId,
      rootId,
      nodes,
      edges,
      report
    );

    return {
      graph: {
        nodes: Array.from(nodes.values()),
        edges: Array.from(edges.values()),
      },
      unresolved: report.unresolved,
      unreadable: report.unreadable,
    };
  }

  /**
   * Build a dependency graph for the whole workspace, and report what stayed out of it.
   *
   * Every scannable file becomes a node and every resolved import becomes an edge,
   * with no focus file and no depth limit.
   *
   * As in `analyze`, the imports that reached no file and the paths that could not be
   * read come back beside the graph: an unreadable directory in particular leaves
   * nothing at all behind, not even a node, so the count is the only trace of it.
   */
  analyzeOverview(workspaceRoot: string): AnalysisResult {
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const report = newScanReport();
    // Canonical, to match the ids the collected files and the resolvers produce.
    const rootId = toNodeId(workspaceRoot);

    for (const filePath of this.collectFiles(rootId, rootId, report)) {
      if (!nodes.has(filePath)) {
        nodes.set(filePath, this.buildNode(filePath, rootId, false));
      }

      const resolver = this.getResolver(filePath);
      if (!resolver) continue;

      // `null` and not falsiness: an empty file was read and has no imports, which
      // is not the same answer as a file that could not be opened.
      const content = this.readFile(filePath, rootId, report);
      if (content === null) continue;

      const imports = resolver.resolveImports(content, filePath, rootId);

      for (const imp of imports) {
        if (!imp.resolvedPath) {
          this.recordUnresolved(report.unresolved, filePath, rootId, imp.raw);
          continue;
        }

        if (!nodes.has(imp.resolvedPath)) {
          nodes.set(
            imp.resolvedPath,
            this.buildNode(imp.resolvedPath, rootId, false)
          );
        }

        this.addEdge(edges, filePath, imp.resolvedPath, imp.type);
      }
    }

    return {
      graph: {
        nodes: Array.from(nodes.values()),
        edges: Array.from(edges.values()),
      },
      unresolved: report.unresolved,
      unreadable: report.unreadable,
    };
  }

  /**
   * Record a dependency from one file to another, once.
   *
   * A file can reach the same target through several statements - an `import` and the
   * `import type` beside it, a `use` and the `::class` it enables - and the view draws
   * one line for them either way. A second edge for the second statement would not
   * show up as a second line, but it would double the weight behind the group pair and
   * report a single crossing as two rule violations, so the pair of files is the key
   * and the first statement to name the target gives the type.
   */
  private addEdge(
    edges: Map<string, GraphEdge>,
    source: string,
    target: string,
    type: string
  ): void {
    // NUL cannot occur in a path, so no pair of files can collide with another.
    const key = source + "\0" + target;
    if (edges.has(key)) return;
    edges.set(key, { source, target, type });
  }

  /** Note an import that reached no file, keeping the first few by name. */
  private recordUnresolved(
    unresolved: UnresolvedImports,
    filePath: string,
    workspaceRoot: string,
    raw: string
  ): void {
    unresolved.count++;
    if (unresolved.samples.length < UNRESOLVED_SAMPLE_LIMIT) {
      unresolved.samples.push({
        file: this.toLabel(filePath, workspaceRoot),
        raw,
      });
    }
  }

  /**
   * Note a path the scan could not open, keeping the first few by name.
   *
   * A path is counted once per run however many passes walk over it: the incoming
   * scan reads the whole workspace and so meets the files the outgoing one already
   * tried, and one locked file is one thing missing, not two.
   */
  private recordUnreadable(
    report: ScanReport,
    targetPath: string,
    workspaceRoot: string,
    kind: "file" | "directory",
    reason: string
  ): void {
    if (report.countedPaths.has(targetPath)) return;
    report.countedPaths.add(targetPath);

    report.unreadable.count++;
    if (report.unreadable.samples.length < UNREADABLE_SAMPLE_LIMIT) {
      report.unreadable.samples.push({
        path: this.toLabel(targetPath, workspaceRoot),
        kind,
        reason,
      });
    }
  }

  private exploreOutgoing(
    filePath: string,
    workspaceRoot: string,
    nodes: Map<string, GraphNode>,
    edges: Map<string, GraphEdge>,
    visited: Set<string>,
    depth: number,
    report: ScanReport
  ): void {
    if (depth <= 0 || visited.has(filePath)) return;
    visited.add(filePath);

    const resolver = this.getResolver(filePath);
    if (!resolver) return;

    // `null` and not falsiness: an empty file was read and has no imports, which
    // is not the same answer as a file that could not be opened.
    const content = this.readFile(filePath, workspaceRoot, report);
    if (content === null) return;

    const imports = resolver.resolveImports(content, filePath, workspaceRoot);

    for (const imp of imports) {
      if (!imp.resolvedPath) {
        this.recordUnresolved(report.unresolved, filePath, workspaceRoot, imp.raw);
        continue;
      }

      if (!nodes.has(imp.resolvedPath)) {
        nodes.set(
          imp.resolvedPath,
          this.buildNode(imp.resolvedPath, workspaceRoot, false)
        );
      }

      this.addEdge(edges, filePath, imp.resolvedPath, imp.type);

      this.exploreOutgoing(
        imp.resolvedPath,
        workspaceRoot,
        nodes,
        edges,
        visited,
        depth - 1,
        report
      );
    }
  }

  private exploreIncoming(
    targetFilePath: string,
    workspaceRoot: string,
    nodes: Map<string, GraphNode>,
    edges: Map<string, GraphEdge>,
    report: ScanReport
  ): void {
    // Scan workspace for files that import the target
    const allFiles = this.collectFiles(workspaceRoot, workspaceRoot, report);

    for (const filePath of allFiles) {
      if (filePath === targetFilePath) continue;

      const resolver = this.getResolver(filePath);
      if (!resolver) continue;

      // `null` and not falsiness: an empty file was read and has no imports, which
      // is not the same answer as a file that could not be opened.
      const content = this.readFile(filePath, workspaceRoot, report);
      if (content === null) continue;

      const imports = resolver.resolveImports(
        content,
        filePath,
        workspaceRoot
      );

      for (const imp of imports) {
        if (imp.resolvedPath === targetFilePath) {
          if (!nodes.has(filePath)) {
            nodes.set(filePath, this.buildNode(filePath, workspaceRoot, false));
          }

          this.addEdge(edges, filePath, targetFilePath, imp.type);
        }
      }
    }
  }

  private static readonly SKIP_DIRS = new Set([
    "node_modules", "vendor", ".git", "storage", "bootstrap", "public",
    ".idea", ".vscode", "dist", "build", "out", ".next", ".nuxt",
    "coverage", ".turbo", ".cache", ".vscode-test", ".venv", "venv",
    "__pycache__", ".pytest_cache", "target", ".gradle", ".mvn",
  ]);

  private collectFiles(
    dir: string,
    workspaceRoot: string,
    report: ScanReport,
    result: string[] = [],
    visitedDirs: Set<string> = new Set()
  ): string[] {
    // There is no depth limit, so a directory that leads back to itself would
    // never end. Canonical paths make a repeat visit recognisable.
    const dirId = toNodeId(dir);
    if (visitedDirs.has(dirId)) return result;
    visitedDirs.add(dirId);

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!DependencyAnalyzer.SKIP_DIRS.has(entry.name)) {
            this.collectFiles(
              path.join(dir, entry.name),
              workspaceRoot,
              report,
              result,
              visitedDirs
            );
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (this.resolvers.some((r) => r.fileExtensions.includes(ext))) {
            result.push(toNodeId(path.join(dir, entry.name)));
          }
        }
      }
    } catch (e) {
      // A directory that will not list takes its whole subtree out of the graph, and
      // leaves nothing behind to say so - not even the empty node an unreadable file
      // leaves. EACCES on a mount owned by another user and ENOENT for a directory
      // removed mid-scan are the ones met in practice, and both are answers about
      // the workspace.
      //
      // A `RangeError` from the recursion above is not: it is this code running out
      // of stack on a deep tree, and passing it over here would return the part of
      // the workspace already walked as though it were the whole of it.
      if (!isFsError(e)) throw e;
      this.recordUnreadable(report, dir, workspaceRoot, "directory", e.code);
    }

    return result;
  }

  private toLabel(filePath: string, workspaceRoot: string): string {
    return path.relative(workspaceRoot, filePath);
  }

  /** Build a graph node. groupPath is left empty here; grouping is a separate post-processing pass. */
  private buildNode(
    filePath: string,
    workspaceRoot: string,
    isFocused: boolean
  ): GraphNode {
    // The layer is read from the path inside the workspace: the directories above
    // the workspace root are the machine's business, not the architecture's.
    const relativePath = this.toLabel(filePath, workspaceRoot);
    return {
      id: filePath,
      label: relativePath,
      layer: detectLayer(relativePath),
      isFocused,
      groupPath: [],
    };
  }

  clearCache(): void {
    this.fileCache.clear();
    clearPathIdCache();
    for (const resolver of this.resolvers) {
      resolver.clearCache?.();
    }
  }
}
