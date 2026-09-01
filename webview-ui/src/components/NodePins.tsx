import { type CSSProperties, type FC, memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { edgeColorFor } from "../lib/edgeStyle";
import { type PinInfo, inHandleId, outHandleId } from "../lib/nodeIO";

export interface NodePinsProps {
  incoming: PinInfo[];
  outgoing: PinInfo[];
}

const PIN_SIZE = 8;

/** Vertical centre of pin `index` out of `total`, evenly spread over the node height. */
function pinTop(index: number, total: number): string {
  return `${((index + 1) / (total + 1)) * 100}%`;
}

function pinStyle(pin: PinInfo, index: number, total: number): CSSProperties {
  return {
    top: pinTop(index, total),
    width: PIN_SIZE,
    height: PIN_SIZE,
    background: edgeColorFor(pin.edgeType),
    border: "1px solid var(--vscode-editor-background, #1e1e1e)",
    // The bundled stylesheet mutes handles with pointer-events: none, which also
    // suppresses the title tooltip, so pointer events are turned back on here.
    pointerEvents: "auto",
  };
}

/**
 * UE5 style connection pins: one visible dot per connected peer, inputs on the left
 * edge and outputs on the right edge, coloured after the kind of wire they carry.
 *
 * The dots are display only. `isConnectableStart` is switched off as well as
 * `isConnectable` because they receive pointer events for their tooltip, and a drag
 * would otherwise start drawing a connection.
 */
export const NodePins: FC<NodePinsProps> = memo(({ incoming, outgoing }) => (
  <>
    {incoming.map((pin, index) => (
      <Handle
        key={pin.peerId}
        id={inHandleId(pin.peerId)}
        type="target"
        position={Position.Left}
        isConnectable={false}
        isConnectableStart={false}
        title={pin.peerLabel}
        style={pinStyle(pin, index, incoming.length)}
      />
    ))}
    {outgoing.map((pin, index) => (
      <Handle
        key={pin.peerId}
        id={outHandleId(pin.peerId)}
        type="source"
        position={Position.Right}
        isConnectable={false}
        isConnectableStart={false}
        title={pin.peerLabel}
        style={pinStyle(pin, index, outgoing.length)}
      />
    ))}
  </>
));

NodePins.displayName = "NodePins";
