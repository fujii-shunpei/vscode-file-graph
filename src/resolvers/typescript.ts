import * as path from "path";
import * as fs from "fs";
import { LanguageResolver, ResolvedImport } from "./types";

export class TypeScriptResolver implements LanguageResolver {
  languageIds = ["typescript", "typescriptreact", "javascript", "javascriptreact"];
  fileExtensions = [".ts", ".tsx", ".js", ".jsx"];

  private tsConfigCache: { paths: Record<string, string[]>; baseUrl: string } | null = null;

  resolveImports(
    content: string,
    filePath: string,
    workspaceRoot: string
  ): ResolvedImport[] {
    const imports: ResolvedImport[] = [];

    // ES module imports: import ... from '...'
    const importFromRegex = /\bimport\s+(?:[\w{}\s,*]+\s+from\s+)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = importFromRegex.exec(content)) !== null) {
      const specifier = match[1];
      const resolved = this.resolveSpecifier(specifier, filePath, workspaceRoot);
      imports.push({ raw: specifier, resolvedPath: resolved, type: "import" });
    }

    // Dynamic import: import('...')
    const dynamicRegex = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = dynamicRegex.exec(content)) !== null) {
      const specifier = match[1];
      const resolved = this.resolveSpecifier(specifier, filePath, workspaceRoot);
      imports.push({ raw: specifier, resolvedPath: resolved, type: "dynamic-import" });
    }

    // CommonJS require: require('...')
    const requireRegex = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = requireRegex.exec(content)) !== null) {
      const specifier = match[1];
      const resolved = this.resolveSpecifier(specifier, filePath, workspaceRoot);
      imports.push({ raw: specifier, resolvedPath: resolved, type: "require" });
    }

    // Re-exports: export ... from '...'
    const reExportRegex = /\bexport\s+(?:[\w{}\s,*]+\s+from\s+)['"]([^'"]+)['"]/g;
    while ((match = reExportRegex.exec(content)) !== null) {
      const specifier = match[1];
      const resolved = this.resolveSpecifier(specifier, filePath, workspaceRoot);
      imports.push({ raw: specifier, resolvedPath: resolved, type: "re-export" });
    }

    return imports;
  }

  private resolveSpecifier(
    specifier: string,
    currentFile: string,
    workspaceRoot: string
  ): string | null {
    // Skip bare module specifiers (node_modules packages)
    if (!specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("@/")) {
      // Check tsconfig paths for alias resolution
      return this.resolveAlias(specifier, workspaceRoot);
    }

    // Handle @/ alias (common in many frameworks)
    if (specifier.startsWith("@/")) {
      const withoutAlias = specifier.slice(2);
      // Try src/ directory first, then root
      const candidates = [
        path.join(workspaceRoot, "src", withoutAlias),
        path.join(workspaceRoot, withoutAlias),
      ];
      for (const base of candidates) {
        const resolved = this.tryResolveFile(base);
        if (resolved) return resolved;
      }
      return this.resolveAlias(specifier, workspaceRoot);
    }

    // Relative import
    const baseDir = path.dirname(currentFile);
    const base = path.resolve(baseDir, specifier);
    return this.tryResolveFile(base);
  }

  private tryResolveFile(base: string): string | null {
    // Exact match
    if (fs.existsSync(base) && fs.statSync(base).isFile()) {
      return base;
    }

    // Try extensions
    const extensions = [".ts", ".tsx", ".js", ".jsx", ".d.ts"];
    for (const ext of extensions) {
      const candidate = base + ext;
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    // Try index files
    for (const ext of extensions) {
      const candidate = path.join(base, "index" + ext);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private resolveAlias(
    specifier: string,
    workspaceRoot: string
  ): string | null {
    const config = this.loadTsConfig(workspaceRoot);
    if (!config) return null;

    const { paths, baseUrl } = config;

    for (const [pattern, targets] of Object.entries(paths)) {
      // Convert tsconfig path pattern to regex
      // e.g., "@/*" -> match "@/anything"
      const regexStr = "^" + pattern.replace(/\*/g, "(.*)") + "$";
      const regex = new RegExp(regexStr);
      const match = specifier.match(regex);

      if (match) {
        for (const target of targets) {
          const resolved = target.replace(/\*/g, match[1] || "");
          const fullPath = path.resolve(workspaceRoot, baseUrl, resolved);
          const result = this.tryResolveFile(fullPath);
          if (result) return result;
        }
      }
    }

    return null;
  }

  private loadTsConfig(
    workspaceRoot: string
  ): { paths: Record<string, string[]>; baseUrl: string } | null {
    if (this.tsConfigCache !== null) {
      return this.tsConfigCache;
    }

    // Try tsconfig.json, then jsconfig.json
    const configNames = ["tsconfig.json", "jsconfig.json"];

    for (const configName of configNames) {
      const configPath = path.join(workspaceRoot, configName);
      if (!fs.existsSync(configPath)) continue;

      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        // Strip comments (// and /* */) for JSON parsing
        const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
        const config = JSON.parse(cleaned);
        const compilerOptions = config.compilerOptions || {};

        this.tsConfigCache = {
          paths: compilerOptions.paths || {},
          baseUrl: compilerOptions.baseUrl || ".",
        };
        return this.tsConfigCache;
      } catch {
        continue;
      }
    }

    this.tsConfigCache = { paths: {}, baseUrl: "." };
    return this.tsConfigCache;
  }
}
