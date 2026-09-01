import * as fs from "fs";
import * as path from "path";
import { LanguageResolver } from "./resolvers/types";
import { clearPathIdCache, toNodeId } from "./paths/pathId";
import type {
  AnalysisResult,
  GraphData,
  GraphEdge,
  GraphNode,
  UnresolvedImports,
} from "./shared/graphTypes";

export type { AnalysisResult, GraphData, GraphEdge, GraphNode };

/** How many unresolved imports an analysis names; the count still covers the rest. */
const UNRESOLVED_SAMPLE_LIMIT = 10;

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

function emptyUnresolved(): UnresolvedImports {
  return { count: 0, samples: [] };
}

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

  private readFile(filePath: string): string | null {
    if (this.fileCache.has(filePath)) {
      return this.fileCache.get(filePath)!;
    }
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      this.fileCache.set(filePath, content);
      return content;
    } catch {
      return null;
    }
  }

  /**
   * Build a dependency graph centered on the given file.
   * Explores outgoing (imports) and incoming (who imports this file) dependencies
   * up to the specified depth.
   */
  analyze(
    focusFilePath: string,
    workspaceRoot: string,
    maxDepth: number = 2
  ): AnalysisResult {
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const visited = new Set<string>();
    const unresolved = emptyUnresolved();

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
      unresolved
    );

    // Explore incoming dependencies (files that import this file). Their own
    // unresolved imports are not counted: this pass reads every file in the
    // workspace to find the few that point here, and reporting what the rest of the
    // workspace failed to resolve would answer a question this view never asked.
    this.exploreIncoming(
      focusId,
      rootId,
      nodes,
      edges
    );

    return {
      graph: {
        nodes: Array.from(nodes.values()),
        edges,
      },
      unresolved,
    };
  }

  /**
   * Build a dependency graph for the whole workspace.
   * Every scannable file becomes a node and every resolved import becomes an edge,
   * with no focus file and no depth limit.
   */
  analyzeOverview(workspaceRoot: string): AnalysisResult {
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const unresolved = emptyUnresolved();
    // Canonical, to match the ids the collected files and the resolvers produce.
    const rootId = toNodeId(workspaceRoot);

    for (const filePath of this.collectFiles(rootId)) {
      if (!nodes.has(filePath)) {
        nodes.set(filePath, this.buildNode(filePath, rootId, false));
      }

      const resolver = this.getResolver(filePath);
      if (!resolver) continue;

      const content = this.readFile(filePath);
      if (!content) continue;

      const imports = resolver.resolveImports(content, filePath, rootId);

      for (const imp of imports) {
        if (!imp.resolvedPath) {
          this.recordUnresolved(unresolved, filePath, rootId, imp.raw);
          continue;
        }

        if (!nodes.has(imp.resolvedPath)) {
          nodes.set(
            imp.resolvedPath,
            this.buildNode(imp.resolvedPath, rootId, false)
          );
        }

        edges.push({
          source: filePath,
          target: imp.resolvedPath,
          type: imp.type,
        });
      }
    }

    return {
      graph: {
        nodes: Array.from(nodes.values()),
        edges,
      },
      unresolved,
    };
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

  private exploreOutgoing(
    filePath: string,
    workspaceRoot: string,
    nodes: Map<string, GraphNode>,
    edges: GraphEdge[],
    visited: Set<string>,
    depth: number,
    unresolved: UnresolvedImports
  ): void {
    if (depth <= 0 || visited.has(filePath)) return;
    visited.add(filePath);

    const resolver = this.getResolver(filePath);
    if (!resolver) return;

    const content = this.readFile(filePath);
    if (!content) return;

    const imports = resolver.resolveImports(content, filePath, workspaceRoot);

    for (const imp of imports) {
      if (!imp.resolvedPath) {
        this.recordUnresolved(unresolved, filePath, workspaceRoot, imp.raw);
        continue;
      }

      if (!nodes.has(imp.resolvedPath)) {
        nodes.set(
          imp.resolvedPath,
          this.buildNode(imp.resolvedPath, workspaceRoot, false)
        );
      }

      edges.push({
        source: filePath,
        target: imp.resolvedPath,
        type: imp.type,
      });

      this.exploreOutgoing(
        imp.resolvedPath,
        workspaceRoot,
        nodes,
        edges,
        visited,
        depth - 1,
        unresolved
      );
    }
  }

  private exploreIncoming(
    targetFilePath: string,
    workspaceRoot: string,
    nodes: Map<string, GraphNode>,
    edges: GraphEdge[]
  ): void {
    // Scan workspace for files that import the target
    const allFiles = this.collectFiles(workspaceRoot);

    for (const filePath of allFiles) {
      if (filePath === targetFilePath) continue;

      const resolver = this.getResolver(filePath);
      if (!resolver) continue;

      const content = this.readFile(filePath);
      if (!content) continue;

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

          edges.push({
            source: filePath,
            target: targetFilePath,
            type: imp.type,
          });
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
    } catch {
      // skip unreadable directories
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
