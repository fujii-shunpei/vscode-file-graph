import React from "react";

interface ControlsProps {
  depth: number;
  onDepthChange: (d: number) => void;
  mode: "layered" | "force";
  onModeToggle: () => void;
  onReset: () => void;
}

export const Controls: React.FC<ControlsProps> = ({
  depth,
  onDepthChange,
  mode,
  onModeToggle,
  onReset,
}) => {
  return (
    <div className="controls">
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
      <div className="controls-group">
        <button className="controls-btn" onClick={onReset}>
          Reset
        </button>
        <button className="controls-btn controls-btn--active" onClick={onModeToggle}>
          {mode === "layered" ? "Layered" : "Force"}
        </button>
      </div>
    </div>
  );
};
