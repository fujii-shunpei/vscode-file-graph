import * as path from "path";
import type { GraphData, GroupRule } from "./shared/graphTypes";

export interface GroupConfig {
  rules: GroupRule[];
  autoDepth: number;
}

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * Compile a glob pattern into an anchored RegExp.
 * Supports `*` (any run of characters inside one segment), `**` (spans zero or
 * more segments) and `?` (exactly one character). Every other character is
 * matched literally.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  let i = 0;

  while (i < glob.length) {
    const char = glob[i];

    if (char === "*" && glob[i + 1] === "*") {
      // `**/` also has to match zero directories, so the slash is optional too.
      if (glob[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 3;
      } else {
        source += ".*";
        i += 2;
      }
    } else if (char === "*") {
      source += "[^/]*";
      i += 1;
    } else if (char === "?") {
      source += "[^/]";
      i += 1;
    } else {
      source += escapeRegExpChar(char);
      i += 1;
    }
  }

  return new RegExp(`^${source}$`);
}

interface CompiledRule {
  matcher: RegExp;
  name: string;
}

function compileRules(rules: GroupRule[]): CompiledRule[] {
  return rules.map((rule) => ({
    matcher: globToRegExp(rule.pattern),
    name: rule.name,
  }));
}

function resolveWithCompiledRules(
  filePath: string,
  workspaceRoot: string,
  rules: CompiledRule[],
  autoDepth: number
): string[] {
  const relativePath = toPosix(
    path.relative(toPosix(workspaceRoot), toPosix(filePath))
  );

  // A file resolved outside the workspace has no place in its directory tree:
  // `path.relative` answers with a `..` chain, which is an escape route rather
  // than a directory name, so the file stays ungrouped.
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    path.isAbsolute(relativePath)
  ) {
    return [];
  }

  for (const rule of rules) {
    if (rule.matcher.test(relativePath)) {
      return [rule.name];
    }
  }

  const directories = relativePath.split("/").slice(0, -1);
  const depth = Math.min(autoDepth, directories.length);
  const chain: string[] = [];
  for (let i = 0; i < depth; i++) {
    chain.push(directories.slice(0, i + 1).join("/"));
  }
  return chain;
}

/**
 * Resolve the group chain a file belongs to, shallow to deep.
 * Rules win over automatic grouping and are evaluated in order, so the first
 * matching rule yields a single-element chain. Otherwise the leading directory
 * segments up to `autoDepth` become a chain of cumulative paths.
 * Returns an empty array when the file belongs to no group.
 */
export function resolveGroupPath(
  filePath: string,
  workspaceRoot: string,
  config: GroupConfig
): string[] {
  return resolveWithCompiledRules(
    filePath,
    workspaceRoot,
    compileRules(config.rules),
    config.autoDepth
  );
}

/** Return a copy of the graph with every node's groupPath resolved. Never mutates the input. */
export function attachGroups(
  data: GraphData,
  workspaceRoot: string,
  config: GroupConfig
): GraphData {
  // Compiled once for the whole graph: the rules do not change while it is walked.
  const rules = compileRules(config.rules);
  return {
    nodes: data.nodes.map((node) => ({
      ...node,
      groupPath: resolveWithCompiledRules(
        node.id,
        workspaceRoot,
        rules,
        config.autoDepth
      ),
    })),
    edges: data.edges,
  };
}
