import * as fs from "fs";
import * as path from "path";
import { LanguageResolver, ResolvedImport } from "./resolvers/types";

// Types mirrored in webview-ui/src/types/graph.ts (webview process). Keep in sync.
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
  ): GraphData {
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const visited = new Set<string>();

    // Add the focused file
    const focusLabel = this.toLabel(focusFilePath, workspaceRoot);
    nodes.set(focusFilePath, {
      id: focusFilePath,
      label: focusLabel,
      layer: detectLayer(focusFilePath),
      isFocused: true,
    });

    // Explore outgoing dependencies (files this file imports)
    this.exploreOutgoing(
      focusFilePath,
      workspaceRoot,
      nodes,
      edges,
      visited,
      maxDepth
    );

    // Explore incoming dependencies (files that import this file)
    this.exploreIncoming(
      focusFilePath,
      workspaceRoot,
      nodes,
      edges
    );

    return {
      nodes: Array.from(nodes.values()),
      edges,
    };
  }

  private exploreOutgoing(
    filePath: string,
    workspaceRoot: string,
    nodes: Map<string, GraphNode>,
    edges: GraphEdge[],
    visited: Set<string>,
    depth: number
  ): void {
    if (depth <= 0 || visited.has(filePath)) return;
    visited.add(filePath);

    const resolver = this.getResolver(filePath);
    if (!resolver) return;

    const content = this.readFile(filePath);
    if (!content) return;

    const imports = resolver.resolveImports(content, filePath, workspaceRoot);

    for (const imp of imports) {
      if (!imp.resolvedPath) continue;

      if (!nodes.has(imp.resolvedPath)) {
        nodes.set(imp.resolvedPath, {
          id: imp.resolvedPath,
          label: this.toLabel(imp.resolvedPath, workspaceRoot),
          layer: detectLayer(imp.resolvedPath),
          isFocused: false,
        });
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
        depth - 1
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
            nodes.set(filePath, {
              id: filePath,
              label: this.toLabel(filePath, workspaceRoot),
              layer: detectLayer(filePath),
              isFocused: false,
            });
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
    "coverage", ".turbo", ".cache",
  ]);

  private collectFiles(
    dir: string,
    result: string[] = [],
    depth: number = 0
  ): string[] {
    if (depth > 10) return result;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!DependencyAnalyzer.SKIP_DIRS.has(entry.name)) {
            this.collectFiles(
              path.join(dir, entry.name),
              result,
              depth + 1
            );
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (this.resolvers.some((r) => r.fileExtensions.includes(ext))) {
            result.push(path.join(dir, entry.name));
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

  clearCache(): void {
    this.fileCache.clear();
    for (const resolver of this.resolvers) {
      resolver.clearCache?.();
    }
  }
}
