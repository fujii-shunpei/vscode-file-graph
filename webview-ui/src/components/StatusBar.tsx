import React from "react";
import { STRUCTURE_COLORS } from "../lib/structure";
import type { UnreadablePaths, UnresolvedImports } from "../types/graph";

interface StatusBarProps {
  currentFile: string;
  nodeCount: number;
  edgeCount: number;
  // The structural findings. Each arrives already zeroed by the caller wherever it
  // does not hold, so the bar reports a count without having to know which view or
  // which grouping state produced it.
  /** Cycles between files. */
  cycleCount: number;
  /** Cycles between groups. */
  groupCycleCount: number;
  errorCount: number;
  warningCount: number;
  /** Imports the graph could not hold; null until the first payload arrives. */
  unresolved: UnresolvedImports | null;
  /** Paths the analysis could not open; null until the first payload arrives. */
  unreadable: UnreadablePaths | null;
}

/**
 * A count is only shown once there is something to report: a bar that always states
 * zero teaches the reader to stop looking at it.
 */
const Flag: React.FC<{
  count: number;
  color: string;
  label: string;
  title?: string;
}> = ({ count, color, label, title }) => {
  if (count === 0) return null;
  return (
    <span className="statusbar-flag" style={{ color }} title={title}>
      {count} {label}
    </span>
  );
};

/**
 * Names the imports behind the count, so that a reader who wonders what is missing
 * can see whether they are packages the graph is right to leave out or paths that
 * failed to resolve. The samples are a prefix, so the remainder is stated as such
 * rather than silently dropped.
 */
function unresolvedTitle(unresolved: UnresolvedImports): string {
  const lines = unresolved.samples.map((s) => `${s.file}: ${s.raw}`);
  const rest = unresolved.count - unresolved.samples.length;
  if (rest > 0) lines.push(`...and ${rest} more`);
  return lines.join("\n");
}

/**
 * Names the paths behind the count, with what each one was and why it failed.
 *
 * The kind is part of the answer and not decoration: a file that would not open cost
 * the reader its dependencies, a directory cost them everything underneath it, and
 * the two are worth different reactions. The errno says whether to look at
 * permissions, at a path that has since been removed, or at this process running out
 * of descriptors.
 */
function unreadableTitle(unreadable: UnreadablePaths): string {
  const lines = unreadable.samples.map(
    (s) => `${s.path} (${s.kind}): ${s.reason}`,
  );
  const rest = unreadable.count - unreadable.samples.length;
  if (rest > 0) lines.push(`...and ${rest} more`);
  return lines.join("\n");
}

export const StatusBar: React.FC<StatusBarProps> = ({
  currentFile,
  nodeCount,
  edgeCount,
  cycleCount,
  groupCycleCount,
  errorCount,
  warningCount,
  unresolved,
  unreadable,
}) => {
  return (
    <div className="statusbar">
      <span className="statusbar-file" title={currentFile}>
        {currentFile}
      </span>
      <span className="statusbar-stats">
        {nodeCount} files, {edgeCount} connections
        {/* Colours match the wires and the frames, so a count leads to what it counts. */}
        <Flag
          count={cycleCount}
          color={STRUCTURE_COLORS.cycle}
          label="cycles"
        />
        <Flag
          count={groupCycleCount}
          color={STRUCTURE_COLORS.cycle}
          label="group cycles"
        />
        <Flag
          count={errorCount}
          color={STRUCTURE_COLORS.error}
          label="rule errors"
        />
        <Flag
          count={warningCount}
          color={STRUCTURE_COLORS.warning}
          label="rule warnings"
        />
        {/*
          Kept in the bar's own foreground rather than an accent colour: a package
          the workspace does not contain is not a fault, so this states how much
          lies outside the picture and must not read as a finding against it.
        */}
        <Flag
          count={unresolved?.count ?? 0}
          color="var(--vscode-descriptionForeground, #999)"
          label="imports outside the graph"
          title={unresolved === null ? undefined : unresolvedTitle(unresolved)}
        />
        {/*
          Louder than the count above it and quieter than the rule errors. A path
          that would not open is not a shape the workspace has, as the four accent
          colours beside it are - it is the analysis failing to look, and what it
          leaves behind is indistinguishable from a file that imports nothing. So it
          takes the editor's own colour for "a problem, though not an error" rather
          than one of the canvas accents: theme-aware like the description grey it
          escalates from, and no wire or frame on the canvas carries it to be
          mistaken for.
        */}
        <Flag
          count={unreadable?.count ?? 0}
          color="var(--vscode-editorWarning-foreground, #cca700)"
          label="paths that could not be read"
          title={unreadable === null ? undefined : unreadableTitle(unreadable)}
        />
      </span>
    </div>
  );
};
