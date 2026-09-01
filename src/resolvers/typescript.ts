import * as path from "path";
import * as fs from "fs";
import { LanguageResolver, ResolvedImport } from "./types";
import { stripComments, TS_COMMENT_SYNTAX } from "./comments";
import { toNodeId } from "../paths/pathId";

interface TsConfig {
  /**
   * The directory the config was found in.
   *
   * `baseUrl` and every target in `paths` are written relative to it, so it and not
   * the workspace root is what an alias is resolved against.
   */
  base: string;
  baseUrl: string;
  compiledPaths: { regex: RegExp; targets: string[] }[];
}

/** Where a JSON string literal starting at `start` ends, escapes included. */
function endOfJsonString(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === '"') return i + 1;
    i++;
  }
  return source.length;
}

/**
 * Turn the JSONC a tsconfig is written in into the JSON `JSON.parse` accepts.
 *
 * TypeScript reads a tsconfig as JSONC, where a comment and a comma before a closing
 * brace are both legal; `JSON.parse` refuses both. Real projects carry both, so a
 * parser that only handles strict JSON reports the common case as a project without
 * path aliases and moves every aliased import out of the graph.
 *
 * String literals are skipped whole, for the reason the resolvers skip them in source:
 * a `//` inside one belongs to a URL or a path and a comma inside one is text. Both
 * comments and the commas are blanked rather than removed, so that every other offset
 * stays where it was and a parse error still points at the place in the file the
 * reader is looking at.
 */
function jsoncToJson(raw: string): string {
  const { source } = stripComments(raw, TS_COMMENT_SYNTAX);
  const out = source.split("");

  // Index of the last comma seen outside a string with only whitespace since; -1 when
  // something else has been read, which is what makes the comma a separator and not a
  // trailing one.
  let pendingComma = -1;
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === '"') {
      i = endOfJsonString(source, i);
      pendingComma = -1;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      i++;
      continue;
    }
    if (char === ",") {
      pendingComma = i;
      i++;
      continue;
    }
    if ((char === "}" || char === "]") && pendingComma !== -1) {
      out[pendingComma] = " ";
    }
    pendingComma = -1;
    i++;
  }

  return out.join("");
}

/**
 * Read the alias rules out of a tsconfig found at `configPath`.
 *
 * `extends` is not followed: a config that keeps its `paths` in a base config resolves
 * no aliases here, and is read as a config declaring none.
 */
function compileTsConfig(raw: string, configPath: string, base: string): TsConfig {
  let parsed: {
    compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
  };
  try {
    parsed = JSON.parse(jsoncToJson(raw));
  } catch (e) {
    // A config that cannot be parsed is not a config without aliases. Answering with
    // an empty one is silent in exactly the wrong place: every `@/...` import then
    // resolves nowhere and is counted beside `react` as something outside the graph,
    // with nothing anywhere saying the config was the reason.
    throw new Error(`Cannot parse ${configPath}`, { cause: e });
  }

  const compilerOptions = parsed.compilerOptions ?? {};
  const paths = compilerOptions.paths ?? {};

  return {
    base,
    baseUrl: compilerOptions.baseUrl ?? ".",
    // Pre-compile path patterns to regexes
    compiledPaths: Object.entries(paths).map(([pattern, targets]) => ({
      regex: new RegExp("^" + pattern.replace(/\*/g, "(.*)") + "$"),
      targets,
    })),
  };
}

export class TypeScriptResolver implements LanguageResolver {
  languageIds = ["typescript", "typescriptreact", "javascript", "javascriptreact"];
  fileExtensions = [".ts", ".tsx", ".js", ".jsx"];

  /** Keyed by the directory of the file the config was looked up for, as in the PHP resolver. */
  private tsConfigCache = new Map<string, TsConfig>();

  resolveImports(
    content: string,
    filePath: string,
    workspaceRoot: string
  ): ResolvedImport[] {
    const imports: ResolvedImport[] = [];
    // `unterminated` is dropped: nothing reports a partly read file to the user yet.
    const { source } = stripComments(content, TS_COMMENT_SYNTAX);

    // ES module imports: import ... from '...'
    const importFromRegex = /\bimport\s+(?:[\w{}\s,*]+\s+from\s+)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = importFromRegex.exec(source)) !== null) {
      const specifier = match[1];
      const resolved = this.resolveSpecifier(specifier, filePath, workspaceRoot);
      imports.push({ raw: specifier, resolvedPath: resolved, type: "import" });
    }

    // Dynamic import: import('...')
    const dynamicRegex = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = dynamicRegex.exec(source)) !== null) {
      const specifier = match[1];
      const resolved = this.resolveSpecifier(specifier, filePath, workspaceRoot);
      imports.push({ raw: specifier, resolvedPath: resolved, type: "dynamic-import" });
    }

    // CommonJS require: require('...')
    const requireRegex = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = requireRegex.exec(source)) !== null) {
      const specifier = match[1];
      const resolved = this.resolveSpecifier(specifier, filePath, workspaceRoot);
      imports.push({ raw: specifier, resolvedPath: resolved, type: "require" });
    }

    // Re-exports: export ... from '...'
    const reExportRegex = /\bexport\s+(?:[\w{}\s,*]+\s+from\s+)['"]([^'"]+)['"]/g;
    while ((match = reExportRegex.exec(source)) !== null) {
      const specifier = match[1];
      const resolved = this.resolveSpecifier(specifier, filePath, workspaceRoot);
      imports.push({ raw: specifier, resolvedPath: resolved, type: "re-export" });
    }

    return imports;
  }

  clearCache(): void {
    this.tsConfigCache.clear();
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
    const aliasResult = this.resolveAlias(specifier, currentFile, workspaceRoot);
    if (aliasResult) return aliasResult;

    // Fallback: @/ -> src/ (common convention even without tsconfig paths).
    // Tried from the directory the file's own config sits in before the workspace
    // root, because `src/` means the one belonging to this project: in a repository
    // that keeps its frontend under `frontend/`, the `src/` at the root is another
    // package's or nothing at all.
    if (specifier.startsWith("@/")) {
      const withoutAlias = specifier.slice(2);
      const projectRoot = this.tsConfigFor(currentFile, workspaceRoot).base;
      const candidates = new Set([
        path.join(projectRoot, "src", withoutAlias),
        path.join(projectRoot, withoutAlias),
        path.join(workspaceRoot, "src", withoutAlias),
        path.join(workspaceRoot, withoutAlias),
      ]);
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
    if (stat?.isFile()) return toNodeId(base);

    // Try extensions
    for (const ext of TypeScriptResolver.EXTENSIONS) {
      const candidate = base + ext;
      const s = fs.statSync(candidate, { throwIfNoEntry: false });
      if (s?.isFile()) return toNodeId(candidate);
    }

    // Try index files
    for (const ext of TypeScriptResolver.EXTENSIONS) {
      const candidate = path.join(base, "index" + ext);
      const s = fs.statSync(candidate, { throwIfNoEntry: false });
      if (s?.isFile()) return toNodeId(candidate);
    }

    return null;
  }

  private resolveAlias(
    specifier: string,
    currentFile: string,
    workspaceRoot: string
  ): string | null {
    const config = this.tsConfigFor(currentFile, workspaceRoot);

    for (const { regex, targets } of config.compiledPaths) {
      const match = specifier.match(regex);
      if (match) {
        for (const target of targets) {
          const resolved = target.replace(/\*/g, match[1] || "");
          const fullPath = path.resolve(config.base, config.baseUrl, resolved);
          const result = this.tryResolveFile(fullPath);
          if (result) return result;
        }
      }
    }

    return null;
  }

  private static readonly CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"];

  /**
   * The alias rules that apply to a file, and the directory their paths are relative to.
   *
   * TypeScript reads the nearest config at or above a file, and both `baseUrl` and the
   * targets in `paths` are written relative to the directory holding it. The workspace
   * root is therefore the wrong anchor wherever the project does not sit at it - a
   * frontend under `frontend/`, one package of a monorepo - and a root with no config
   * at all leaves every `@/...` import resolving nowhere, counted beside `react` as
   * something that lives outside the graph.
   *
   * Bounded by the workspace for the reason the PHP resolver bounds its own search: a
   * project that declares no aliases must not be given the ones belonging to whatever
   * unrelated package sits above the directory the user opened.
   */
  private tsConfigFor(filePath: string, workspaceRoot: string): TsConfig {
    const startDir = path.dirname(filePath);
    const cached = this.tsConfigCache.get(startDir);
    if (cached) return cached;

    const root = path.resolve(workspaceRoot);
    let found: TsConfig | null = null;
    let dir = startDir;
    while (dir.startsWith(root)) {
      found = this.loadTsConfig(dir);
      if (found) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    // No config anywhere above the file: no aliases, and the root is as good an
    // anchor as any for the `@/` convention that needs one regardless.
    const config = found ?? { base: root, baseUrl: ".", compiledPaths: [] };
    this.tsConfigCache.set(startDir, config);
    return config;
  }

  /** The config written in this exact directory, or null when there is none. */
  private loadTsConfig(dir: string): TsConfig | null {
    for (const configName of TypeScriptResolver.CONFIG_NAMES) {
      const configPath = path.join(dir, configName);
      let raw: string;
      try {
        raw = fs.readFileSync(configPath, "utf-8");
      } catch (e) {
        // ENOENT is the only answer that means "keep looking further up". A config
        // that exists and will not open - EACCES on a container mount, a directory
        // named tsconfig.json - is a fact about this machine, and reporting it as a
        // project without aliases would hide it behind a graph that looks complete.
        if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") continue;
        throw e;
      }
      return compileTsConfig(raw, configPath, dir);
    }
    return null;
  }
}
