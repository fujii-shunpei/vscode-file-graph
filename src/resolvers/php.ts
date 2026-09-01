import * as path from "path";
import * as fs from "fs";
import { LanguageResolver, ResolvedImport } from "./types";
import { PHP_COMMENT_SYNTAX, stripComments } from "./comments";
import { toNodeId } from "../paths/pathId";

export class PhpResolver implements LanguageResolver {
  languageIds = ["php"];
  fileExtensions = [".php"];

  resolveImports(
    content: string,
    filePath: string,
    workspaceRoot: string
  ): ResolvedImport[] {
    const imports: ResolvedImport[] = [];
    const seen = new Set<string>();
    const source = stripComments(content, PHP_COMMENT_SYNTAX);

    /**
     * Report an import once, whether or not it reached a file.
     *
     * An import that resolves nowhere is still an import that was written, and the
     * only record that it was: dropping it leaves a file that imports nothing
     * looking exactly like a file whose every import failed to resolve. The other
     * resolvers keep it for that reason and this one now matches them.
     *
     * One file can name the same target twice - a `use` and the `::class` it enables -
     * and that is one dependency either way. A resolved import is known by the file it
     * reached; an unresolved one has no file, so it is held apart by what was written.
     */
    const addImport = (raw: string, resolved: string | null, type: string) => {
      const key = resolved ?? "raw:" + raw;
      if (seen.has(key)) return;
      seen.add(key);
      imports.push({ raw, resolvedPath: resolved, type });
    };

    // Collect `use` namespace prefixes for resolving relative ::class references
    // e.g., `use App\Http\Controllers;` -> prefix "Controllers" maps to "App\Http\Controllers"
    const useAliases: Record<string, string> = {};

    // PSR-4 `use` statements: use App\Models\User;
    const useRegex = /^\s*use\s+([\w\\]+)(?:\s+as\s+(\w+))?;/gm;
    let match;
    while ((match = useRegex.exec(source)) !== null) {
      const fqcn = match[1];
      const alias = match[2] || fqcn.split("\\").pop() || "";
      const resolved = this.resolveNamespace(fqcn, filePath, workspaceRoot);

      // Register alias for relative ::class resolution
      useAliases[alias] = fqcn;

      // An unresolved one may be a namespace prefix (`use App\Http\Controllers;`) or a
      // class from vendor; either way the alias above still serves the ::class scan.
      addImport(fqcn, resolved, "use");
    }

    // ::class references: Controllers\Admin\ReserveBoardController::class
    // Also matches: SomeClass::class
    const classRefRegex = /([\w\\]+)::class/g;
    while ((match = classRefRegex.exec(source)) !== null) {
      const ref = match[1];
      const fqcn = this.resolveClassRef(ref, useAliases);
      if (!fqcn) continue;

      const resolved = this.resolveNamespace(fqcn, filePath, workspaceRoot);
      addImport(fqcn, resolved, "class-ref");
    }

    // require / require_once / include / include_once
    const requireRegex =
      /\b(require|require_once|include|include_once)\s*[\(]?\s*['"]([^'"]+)['"]\s*[\)]?\s*;/gm;
    while ((match = requireRegex.exec(source)) !== null) {
      const type = match[1];
      const target = match[2];
      const resolved = this.resolveRelativePath(target, filePath, workspaceRoot);
      addImport(target, resolved, type);
    }

    return imports;
  }

  /**
   * Resolve a relative ::class reference using use-imported aliases.
   * e.g., "Controllers\Admin\ReserveBoardController" with alias
   *   "Controllers" -> "App\Http\Controllers"
   * becomes "App\Http\Controllers\Admin\ReserveBoardController"
   */
  private resolveClassRef(
    ref: string,
    useAliases: Record<string, string>
  ): string | null {
    // Already fully qualified
    if (ref.startsWith("\\")) return ref.slice(1);

    // Try to match the first segment against use aliases
    const firstSeg = ref.split("\\")[0];
    const rest = ref.includes("\\") ? ref.slice(firstSeg.length + 1) : "";

    if (useAliases[firstSeg]) {
      const base = useAliases[firstSeg];
      return rest ? base + "\\" + rest : base;
    }

    // If it's a simple name (no backslash), it might be a directly imported class
    // Already handled by the `use` import above, skip to avoid duplicate
    if (!ref.includes("\\")) return null;

    // Qualified name without alias match — treat as FQCN
    // e.g., App\Http\Controllers\HomeController::class
    return ref;
  }

  private resolveNamespace(
    fqcn: string,
    filePath: string,
    workspaceRoot: string
  ): string | null {
    const { base, mappings } = this.autoloadFor(filePath, workspaceRoot);

    for (const [namespace, dir] of Object.entries(mappings)) {
      if (fqcn.startsWith(namespace)) {
        const relative = fqcn.slice(namespace.length).replace(/\\/g, "/");
        const candidate = path.join(base, dir, relative + ".php");
        if (fs.existsSync(candidate)) {
          return toNodeId(candidate);
        }
      }
    }

    return null;
  }

  private resolveRelativePath(
    target: string,
    currentFile: string,
    workspaceRoot: string
  ): string | null {
    // __DIR__ based paths
    const cleaned = target.replace(/__DIR__\s*\.\s*['"]?/g, "");

    // Try relative to current file
    const fromFile = path.resolve(path.dirname(currentFile), cleaned);
    if (fs.existsSync(fromFile)) {
      return toNodeId(fromFile);
    }

    // Try relative to workspace root
    const fromRoot = path.resolve(workspaceRoot, cleaned);
    if (fs.existsSync(fromRoot)) {
      return toNodeId(fromRoot);
    }

    return null;
  }

  clearCache(): void {
    this.autoloadCache.clear();
  }

  /** Namespace prefixes Laravel installs by convention, used when composer.json is silent. */
  private static readonly DEFAULT_PSR4: Record<string, string> = {
    "App\\": "app/",
    "Database\\Factories\\": "database/factories/",
    "Database\\Seeders\\": "database/seeders/",
    "Tests\\": "tests/",
  };

  private autoloadCache = new Map<string, Autoload>();

  /**
   * The PSR-4 rules that apply to a file, and the directory their paths are relative to.
   *
   * A prefix is declared in the composer.json of the package that holds the file, and the
   * directory it maps to is written relative to that same composer.json. The nearest
   * composer.json at or above the file is therefore the anchor, not the workspace root:
   * an application checked out under `src/` next to `docker/` keeps its rules in
   * `src/composer.json`, and reading `App\` as `app/` from the workspace root would look
   * for every class one directory too high and resolve nothing at all.
   */
  private autoloadFor(filePath: string, workspaceRoot: string): Autoload {
    const startDir = path.dirname(filePath);
    const cached = this.autoloadCache.get(startDir);
    if (cached) return cached;

    // Bounded by the workspace: a project without a composer.json must not be answered
    // with the autoload rules of whatever unrelated package sits above the workspace.
    const root = path.resolve(workspaceRoot);
    let base = root;
    let dir = startDir;
    while (dir.startsWith(root)) {
      if (fs.existsSync(path.join(dir, "composer.json"))) {
        base = dir;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    const autoload: Autoload = {
      base,
      mappings: {
        ...PhpResolver.DEFAULT_PSR4,
        ...this.loadComposerMappings(base),
      },
    };
    this.autoloadCache.set(startDir, autoload);
    return autoload;
  }

  private loadComposerMappings(packageRoot: string): Record<string, string> {
    const composerPath = path.join(packageRoot, "composer.json");

    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, "utf-8"));
      const result: Record<string, string> = {};

      const autoload = composer.autoload?.["psr-4"] ?? {};
      for (const [ns, dir] of Object.entries(autoload)) {
        result[ns] = dir as string;
      }

      const autoloadDev = composer["autoload-dev"]?.["psr-4"] ?? {};
      for (const [ns, dir] of Object.entries(autoloadDev)) {
        result[ns] = dir as string;
      }

      return result;
    } catch {
      // No composer.json, or one that cannot be read: the conventional mappings stand alone.
      return {};
    }
  }
}

/** PSR-4 prefixes and the directory their target paths are written relative to. */
interface Autoload {
  base: string;
  mappings: Record<string, string>;
}
