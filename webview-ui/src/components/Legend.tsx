import React from "react";
import { LAYER_COLORS } from "../types/graph";

interface LegendProps {
  layers: { name: string; count: number }[];
  disabledLayers: Set<string>;
  onToggleLayer: (layer: string) => void;
}

export const Legend: React.FC<LegendProps> = ({
  layers,
  disabledLayers,
  onToggleLayer,
}) => {
  return (
    <div className="legend">
      <div className="legend-title">LAYERS (CLICK TO FILTER)</div>
      <ul className="legend-list">
        {layers.map((layer) => {
          const disabled = disabledLayers.has(layer.name);
          const color = LAYER_COLORS[layer.name] ?? LAYER_COLORS.Other;
          return (
            <li
              key={layer.name}
              className={`legend-item ${disabled ? "legend-item--disabled" : ""}`}
              onClick={() => onToggleLayer(layer.name)}
            >
              <span
                className="legend-dot"
                style={{ backgroundColor: disabled ? "transparent" : color, borderColor: color }}
              />
              <span className="legend-name">{layer.name}</span>
              <span className="legend-count">{layer.count}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
