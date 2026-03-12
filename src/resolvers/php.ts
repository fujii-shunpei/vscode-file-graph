import * as path from "path";
import * as fs from "fs";
import { LanguageResolver, ResolvedImport } from "./types";

export class PhpResolver implements LanguageResolver {
  languageIds = ["php"];
  fileExtensions = [".php"];

  resolveImports(
    content: string,
    filePath: string,
    workspaceRoot: string
  ): ResolvedImport[] {
    const imports: ResolvedImport[] = [];

    // PSR-4 `use` statements: use App\Models\User;
    const useRegex = /^\s*use\s+([\w\\]+)(?:\s+as\s+\w+)?;/gm;
    let match;
    while ((match = useRegex.exec(content)) !== null) {
      const fqcn = match[1];
      const resolved = this.resolveNamespace(fqcn, workspaceRoot);
      imports.push({ raw: fqcn, resolvedPath: resolved, type: "use" });
    }

    // require / require_once / include / include_once
    const requireRegex =
      /\b(require|require_once|include|include_once)\s*[\(]?\s*['"]([^'"]+)['"]\s*[\)]?\s*;/gm;
    while ((match = requireRegex.exec(content)) !== null) {
      const type = match[1];
      const target = match[2];
      const resolved = this.resolveRelativePath(target, filePath, workspaceRoot);
      imports.push({ raw: target, resolvedPath: resolved, type });
    }

    return imports;
  }

  private resolveNamespace(
    fqcn: string,
    workspaceRoot: string
  ): string | null {
    // Try common PSR-4 mappings for Laravel
    const mappings: Record<string, string> = {
      "App\\": "app/",
      "Database\\Factories\\": "database/factories/",
      "Database\\Seeders\\": "database/seeders/",
      "Tests\\": "tests/",
    };

    // Also try to read composer.json for custom mappings
    const composerMappings = this.loadComposerMappings(workspaceRoot);
    const allMappings = { ...mappings, ...composerMappings };

    for (const [namespace, dir] of Object.entries(allMappings)) {
      if (fqcn.startsWith(namespace)) {
        const relative = fqcn.slice(namespace.length).replace(/\\/g, "/");
        const candidate = path.join(workspaceRoot, dir, relative + ".php");
        if (fs.existsSync(candidate)) {
          return candidate;
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
      return fromFile;
    }

    // Try relative to workspace root
    const fromRoot = path.resolve(workspaceRoot, cleaned);
    if (fs.existsSync(fromRoot)) {
      return fromRoot;
    }

    return null;
  }

  clearCache(): void {
    this.composerCache = null;
  }

  private composerCache: Record<string, string> | null = null;

  private loadComposerMappings(workspaceRoot: string): Record<string, string> {
    if (this.composerCache !== null) {
      return this.composerCache;
    }

    const composerPath = path.join(workspaceRoot, "composer.json");
    if (!fs.existsSync(composerPath)) {
      this.composerCache = {};
      return this.composerCache;
    }

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

      this.composerCache = result;
      return result;
    } catch {
      this.composerCache = {};
      return this.composerCache;
    }
  }
}
