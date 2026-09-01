import React from "react";
import { STRUCTURE_COLORS } from "../lib/structure";

interface StatusBarProps {
  currentFile: string;
  nodeCount: number;
  edgeCount: number;
  /** Cycles between files. */
  cycleCount: number;
  /** Cycles between groups; already zeroed by the caller when groups are not drawn. */
  groupCycleCount: number;
  errorCount: number;
  warningCount: number;
}

/**
 * A count is only shown once there is something to report: a bar that always states
 * zero teaches the reader to stop looking at it.
 */
const Flag: React.FC<{ count: number; color: string; label: string }> = ({
  count,
  color,
  label,
}) => {
  if (count === 0) return null;
  return (
    <span className="statusbar-flag" style={{ color }}>
      {count} {label}
    </span>
  );
};

export const StatusBar: React.FC<StatusBarProps> = ({
  currentFile,
  nodeCount,
  edgeCount,
  cycleCount,
  groupCycleCount,
  errorCount,
  warningCount,
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
      </span>
    </div>
  );
};
