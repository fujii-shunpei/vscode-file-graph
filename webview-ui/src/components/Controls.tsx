import React from "react";

interface ControlsProps {
  depth: number;
  onDepthChange: (d: number) => void;
  mode: "layered" | "force";
  onModeToggle: () => void;
  onReset: () => void;
  showGroups: boolean;
  onGroupsToggle: () => void;
  /** False in the overview, where grouping is always on and the toggle would be a lie. */
  canToggleGroups: boolean;
  /** False in the overview, which has no focus file to walk away from. */
  canChangeDepth: boolean;
}

export const Controls: React.FC<ControlsProps> = ({
  depth,
  onDepthChange,
  mode,
  onModeToggle,
  onReset,
  showGroups,
  onGroupsToggle,
  canToggleGroups,
  canChangeDepth,
}) => {
  return (
    <div className="controls">
      {canChangeDepth && (
        <div className="controls-group">
          <span className="controls-label">Depth</span>
          {[1, 2, 3].map((d) => (
            <button
              key={d}
              className={`controls-btn ${depth === d ? "controls-btn--active" : ""}`}
              onClick={() => onDepthChange(d)}
            >
              {d}
            </button>
          ))}
        </div>
      )}
      <div className="controls-group">
        <button className="controls-btn" onClick={onReset}>
          Reset
        </button>
        {canToggleGroups && (
          <button
            className={`controls-btn ${showGroups ? "controls-btn--active" : ""}`}
            onClick={onGroupsToggle}
          >
            Groups
          </button>
        )}
        <button className="controls-btn controls-btn--active" onClick={onModeToggle}>
          {mode === "layered" ? "Layered" : "Force"}
        </button>
      </div>
    </div>
  );
};
