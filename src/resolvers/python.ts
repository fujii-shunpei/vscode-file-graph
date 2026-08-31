import * as path from "path";
import * as fs from "fs";
import { LanguageResolver, ResolvedImport } from "./types";

export class PythonResolver implements LanguageResolver {
  languageIds = ["python"];
  fileExtensions = [".py"];

  resolveImports(
    content: string,
    filePath: string,
    workspaceRoot: string
  ): ResolvedImport[] {
    const imports: ResolvedImport[] = [];
    const seen = new Set<string>();

    const addImport = (raw: string, resolved: string | null, type: string) => {
      if (resolved && seen.has(resolved)) return;
      if (resolved) seen.add(resolved);
      imports.push({ raw, resolvedPath: resolved, type });
    };

    // from module import name / from module import *
    const fromImportRegex = /^\s*from\s+(\.{0,3}[\w.]*)\s+import\s+/gm;
    let match;
    while ((match = fromImportRegex.exec(content)) !== null) {
      const module = match[1];
      const resolved = this.resolveModule(module, filePath, workspaceRoot);
      addImport(module, resolved, "from-import");
    }

    // import module / import module as alias / import mod1, mod2
    const importRegex = /^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/gm;
    while ((match = importRegex.exec(content)) !== null) {
      const moduleList = match[1];
      // Split by comma, strip "as alias"
      const modules = moduleList.split(",").map((m) =>
        m.trim().replace(/\s+as\s+\w+$/, "").trim()
      );
      for (const mod of modules) {
        if (!mod) continue;
        const resolved = this.resolveModule(mod, filePath, workspaceRoot);
        addImport(mod, resolved, "import");
      }
    }

    return imports;
  }

  private resolveModule(
    module: string,
    currentFile: string,
    workspaceRoot: string
  ): string | null {
    // Relative import: starts with dots
    if (module.startsWith(".")) {
      const result = this.resolveRelative(module, currentFile);
      return result !== currentFile ? result : null;
    }

    // Absolute import: try from workspace root and common layouts
    const result = this.resolveAbsolute(module, currentFile, workspaceRoot);
    return result !== currentFile ? result : null;
  }

  private resolveRelative(module: string, currentFile: string): string | null {
    // Count leading dots
    let dots = 0;
    while (dots < module.length && module[dots] === ".") dots++;
    const rest = module.slice(dots);

    // Starting directory: one dot = current package dir, two dots = parent, etc.
    let base = path.dirname(currentFile);
    for (let i = 1; i < dots; i++) {
      base = path.dirname(base);
    }

    if (!rest) {
      // `from . import name` -> current package __init__.py
      return this.tryResolvePython(base);
    }

    const parts = rest.replace(/\./g, "/");
    return this.tryResolvePython(path.join(base, parts));
  }

  private resolveAbsolute(
    module: string,
    currentFile: string,
    workspaceRoot: string
  ): string | null {
    const parts = module.replace(/\./g, "/");

    // Walk up from the file's directory to the workspace root, trying each
    // ancestor as a potential Python path root. This mirrors how Python's
    // sys.path works when running `cd <dir> && python script.py`.
    let dir = path.dirname(currentFile);
    const root = path.resolve(workspaceRoot);
    while (dir.startsWith(root)) {
      const result = this.tryResolvePython(path.join(dir, parts));
      if (result) return result;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    // Not a local module (likely a pip package)
    return null;
  }

  private tryResolvePython(base: string): string | null {
    // Exact file: module.py
    const pyFile = base + ".py";
    const stat = fs.statSync(pyFile, { throwIfNoEntry: false });
    if (stat?.isFile()) return pyFile;

    // Package: module/__init__.py
    const initFile = path.join(base, "__init__.py");
    const initStat = fs.statSync(initFile, { throwIfNoEntry: false });
    if (initStat?.isFile()) return initFile;

    return null;
  }
}
