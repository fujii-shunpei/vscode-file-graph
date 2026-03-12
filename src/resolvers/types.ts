export interface ResolvedImport {
  /** The raw import string as found in source code */
  raw: string;
  /** Resolved absolute file path (if resolvable) */
  resolvedPath: string | null;
  /** Type of import (e.g., 'use', 'require', 'include') */
  type: string;
}

export interface LanguageResolver {
  /** VS Code language identifiers this resolver handles */
  languageIds: string[];
  /** File extensions this resolver handles (with dot) */
  fileExtensions: string[];
  /** Extract imports from file content and resolve to file paths */
  resolveImports(content: string, filePath: string, workspaceRoot: string): ResolvedImport[];
  /** Clear any cached config (tsconfig, composer.json, etc.) */
  clearCache?(): void;
}
