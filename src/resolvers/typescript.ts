import * as path from "path";
import * as fs from "fs";
import { LanguageResolver, ResolvedImport } from "./types";

interface TsConfig {
  paths: Record<string, string[]>;
  baseUrl: string;
  compiledPaths: { regex: RegExp; targets: string[] }[];
}

export class TypeScriptResolver implements LanguageResolver {
  languageIds = ["typescript", "typescriptreact", "javascript", "javascriptreact"];
  fileExtensions = [".ts", ".tsx", ".js", ".jsx"];

  private tsConfigCache: TsConfig | null = null;

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

  clearCache(): void {
    this.tsConfigCache = null;
  }

  private resolveSpecifier(
    specifier: string,
    currentFile: string,
    workspaceRoot: string
  ): string | null {
    // Relative imports
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const baseDir = path.dirname(currentFile);
      const base = path.resolve(baseDir, specifier);
      return this.tryResolveFile(base);
    }

    // Non-relative: try tsconfig paths alias first
    const aliasResult = this.resolveAlias(specifier, workspaceRoot);
    if (aliasResult) return aliasResult;

    // Fallback: @/ -> src/ (common convention even without tsconfig paths)
    if (specifier.startsWith("@/")) {
      const withoutAlias = specifier.slice(2);
      const candidates = [
        path.join(workspaceRoot, "src", withoutAlias),
        path.join(workspaceRoot, withoutAlias),
      ];
      for (const base of candidates) {
        const resolved = this.tryResolveFile(base);
        if (resolved) return resolved;
      }
    }

    // Bare module specifier (npm package) - not a local file
    return null;
  }

  private static readonly EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".d.ts"];

  private tryResolveFile(base: string): string | null {
    // Exact match
    const stat = fs.statSync(base, { throwIfNoEntry: false });
    if (stat?.isFile()) return base;

    // Try extensions
    for (const ext of TypeScriptResolver.EXTENSIONS) {
      const candidate = base + ext;
      const s = fs.statSync(candidate, { throwIfNoEntry: false });
      if (s?.isFile()) return candidate;
    }

    // Try index files
    for (const ext of TypeScriptResolver.EXTENSIONS) {
      const candidate = path.join(base, "index" + ext);
      const s = fs.statSync(candidate, { throwIfNoEntry: false });
      if (s?.isFile()) return candidate;
    }

    return null;
  }

  private resolveAlias(
    specifier: string,
    workspaceRoot: string
  ): string | null {
    const config = this.loadTsConfig(workspaceRoot);
    if (!config) return null;

    for (const { regex, targets } of config.compiledPaths) {
      const match = specifier.match(regex);
      if (match) {
        for (const target of targets) {
          const resolved = target.replace(/\*/g, match[1] || "");
          const fullPath = path.resolve(workspaceRoot, config.baseUrl, resolved);
          const result = this.tryResolveFile(fullPath);
          if (result) return result;
        }
      }
    }

    return null;
  }

  private loadTsConfig(workspaceRoot: string): TsConfig | null {
    if (this.tsConfigCache !== null) {
      return this.tsConfigCache;
    }

    const configNames = ["tsconfig.json", "jsconfig.json"];

    for (const configName of configNames) {
      const configPath = path.join(workspaceRoot, configName);
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
        const config = JSON.parse(cleaned);
        const compilerOptions = config.compilerOptions || {};
        const paths: Record<string, string[]> = compilerOptions.paths || {};

        // Pre-compile path patterns to regexes
        const compiledPaths = Object.entries(paths).map(([pattern, targets]) => ({
          regex: new RegExp("^" + pattern.replace(/\*/g, "(.*)") + "$"),
          targets: targets as string[],
        }));

        this.tsConfigCache = {
          paths,
          baseUrl: compilerOptions.baseUrl || ".",
          compiledPaths,
        };
        return this.tsConfigCache;
      } catch {
        continue;
      }
    }

    this.tsConfigCache = { paths: {}, baseUrl: ".", compiledPaths: [] };
    return this.tsConfigCache;
  }
}
