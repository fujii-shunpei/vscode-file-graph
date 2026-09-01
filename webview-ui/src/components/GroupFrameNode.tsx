import { type CSSProperties, type FC, memo, useCallback } from "react";
import { type Node, type NodeProps } from "@xyflow/react";
import { type NodePins as NodePinSet } from "../lib/nodeIO";
import { STRUCTURE_COLORS } from "../lib/structure";
import { NodePins } from "./NodePins";

/** Must match the header band `computeGroupedLayout` reserves above the frame content. */
const HEADER_HEIGHT = 28;

/** Alpha suffix appended to the group colour to tint a surface (#RRGGBBAA). */
const TINT_ALPHA = "33";

export interface GroupFrameNodeData extends Record<string, unknown> {
  groupId: string;
  name: string;
  collapsed: boolean;
  fileCount: number;
  color: string;
  /** True when the group takes part in a cycle between groups. */
  cyclic: boolean;
  /** Aggregated wires of the folded subtree; only set while collapsed. */
  pins?: NodePinSet;
  onToggleCollapse: (groupId: string) => void;
}

function headerStyle(color: string): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: HEADER_HEIGHT,
    padding: "0 8px",
    boxSizing: "border-box",
    background: `${color}${TINT_ALPHA}`,
    borderBottom: `1px solid ${color}`,
    color: "var(--vscode-editor-foreground, #fff)",
    fontSize: 11,
    cursor: "pointer",
    userSelect: "none",
    overflow: "hidden",
  };
}

/**
 * A pill caught in a cycle between groups only gives up its outline, keeping the
 * tint of its own colour, so it stays the group the reader recognises while saying
 * that it sits in a circle.
 */
function pillStyle(color: string, cyclic: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    height: "100%",
    padding: "0 14px",
    boxSizing: "border-box",
    borderRadius: 32,
    border: cyclic
      ? `3px dashed ${STRUCTURE_COLORS.cycle}`
      : `2px solid ${color}`,
    background: `${color}${TINT_ALPHA}`,
    color: "var(--vscode-editor-foreground, #fff)",
    fontSize: 12,
    cursor: "pointer",
    userSelect: "none",
    overflow: "hidden",
  };
}

const chevronStyle: CSSProperties = {
  color: "var(--vscode-descriptionForeground, #999)",
  fontSize: 9,
  flexShrink: 0,
};

const nameStyle: CSSProperties = {
  flex: 1,
  fontWeight: 600,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0,
};

const countStyle: CSSProperties = {
  color: "var(--vscode-descriptionForeground, #999)",
  fontSize: 11,
  fontVariantNumeric: "tabular-nums",
  flexShrink: 0,
};

/**
 * Directory group drawn as a React Flow node.
 *
 * Expanded, the frame rectangle itself comes from the node style, so this component
 * only draws the title band on top of it. Collapsed, it draws the whole pill and the
 * aggregated pins, so the node style only needs to supply the width and height.
 */
export const GroupFrameNode: FC<NodeProps<Node<GroupFrameNodeData>>> = memo(
  ({ data }) => {
    const {
      groupId,
      name,
      collapsed,
      fileCount,
      color,
      cyclic,
      pins,
      onToggleCollapse,
    } = data;

    const handleToggle = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        onToggleCollapse(groupId);
      },
      [onToggleCollapse, groupId],
    );

    const label = (
      <>
        <span style={chevronStyle}>{collapsed ? "▶" : "▼"}</span>
        <span style={nameStyle}>{name}</span>
        <span style={countStyle}>{fileCount}</span>
      </>
    );

    if (collapsed) {
      return (
        <>
          <div
            style={pillStyle(color, cyclic)}
            onClick={handleToggle}
            title={groupId}
          >
            {label}
          </div>
          <NodePins
            incoming={pins?.incoming ?? []}
            outgoing={pins?.outgoing ?? []}
          />
        </>
      );
    }

    return (
      <div style={headerStyle(color)} onClick={handleToggle} title={groupId}>
        {label}
      </div>
    );
  },
);

GroupFrameNode.displayName = "GroupFrameNode";
