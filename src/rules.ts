import type {
  DependencyRule,
  GraphData,
  RuleViolation,
} from "./shared/graphTypes";

/**
 * Find the file dependencies that break a declared rule.
 *
 * A rule names two group ids and forbids the dependency between them; anything
 * not declared is allowed. The ends are matched against the whole `groupPath` of
 * a node rather than its deepest group, because the path is an ancestor chain:
 * naming `src/domain` therefore covers every group nested under it. A node with
 * an empty path belongs to no group and so matches nothing.
 *
 * One dependency breaking several rules is reported once per rule, as the rule
 * is what the reader has to act on.
 *
 * Expects the graph to carry the groups already, as `attachGroups` leaves them.
 */
export function findViolations(
  data: GraphData,
  rules: DependencyRule[]
): RuleViolation[] {
  // The common case is a workspace that declares nothing, where indexing the
  // nodes of a whole overview would buy nothing.
  if (rules.length === 0) return [];

  const nodesById = new Map(data.nodes.map((node) => [node.id, node]));
  const violations: RuleViolation[] = [];

  for (const edge of data.edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (source === undefined || target === undefined) continue;

    for (const rule of rules) {
      if (
        source.groupPath.includes(rule.from) &&
        target.groupPath.includes(rule.to)
      ) {
        violations.push({
          ruleName: rule.name,
          severity: rule.severity,
          source: edge.source,
          target: edge.target,
          fromGroup: rule.from,
          toGroup: rule.to,
        });
      }
    }
  }

  return violations;
}
