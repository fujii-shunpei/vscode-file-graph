import { type GraphNode } from "../types/graph";
import { type GroupTreeNode } from "./grouping";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  computeCirclePositions,
  computeLayeredPositions,
} from "./layout";

/** Placed rectangle of one group frame. See `computeGroupedLayout` for the coordinate system. */
export interface GroupBox {
  id: string;
  name: string;
  depth: number;
  /** Enclosing group, or undefined for a top level frame. */
  parentId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  collapsed: boolean;
  /** Files in the whole subtree, descendants included. */
  fileCount: number;
}

export interface GroupedLayoutResult {
  filePositions: Map<string, { x: number; y: number }>;
  groupBoxes: GroupBox[];
}

/** Height of the coloured title band a frame reserves above its content. */
const HEADER_HEIGHT = 28;
const FRAME_PADDING = 16;
/** Gap kept between two packed items. */
const ITEM_GAP = 24;
const COLLAPSED_WIDTH = 220;
/** Baseline pill height; a pill with many aggregated pins is stretched past it. */
const COLLAPSED_HEIGHT = 64;
/** Keeps narrow frames wide enough for their header text. */
const MIN_FRAME_WIDTH = 180;
/** Width-to-height bias of the shelf packer: above 1 rows grow wider than tall. */
const SHELF_ASPECT = 1.6;

interface XY {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

/** A laid out block of file nodes with its top left corner normalised to (0, 0). */
interface FileBlock extends Size {
  positions: Map<string, XY>;
}

interface PackResult extends Size {
  offsets: XY[];
}

/** A group sized by the recursion; its own position is decided by its parent. */
interface LaidGroup extends Size {
  group: GroupTreeNode;
  collapsed: boolean;
  fileCount: number;
  children: PlacedGroup[];
  /** Own files, relative to this group's top left corner. */
  filePositions: Map<string, XY>;
}

interface PlacedGroup extends XY {
  laid: LaidGroup;
}

interface LayoutContext {
  mode: "layered" | "force";
  collapsedGroupIds: Set<string>;
  nodesById: Map<string, GraphNode>;
  nodeHeights: Map<string, number>;
}

/** Files in the subtree of `group`, descendants included. */
function countFiles(group: GroupTreeNode): number {
  let count = group.fileIds.length;
  for (const child of group.children) count += countFiles(child);
  return count;
}

function layoutFileBlock(
  files: GraphNode[],
  ctx: LayoutContext,
): FileBlock {
  const raw =
    ctx.mode === "layered"
      ? computeLayeredPositions(files, ctx.nodeHeights)
      : computeCirclePositions(files, ctx.nodeHeights);

  if (raw.size === 0) return { positions: new Map(), width: 0, height: 0 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [id, position] of raw) {
    const height = ctx.nodeHeights.get(id) ?? NODE_HEIGHT;
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + NODE_WIDTH);
    maxY = Math.max(maxY, position.y + height);
  }

  const positions = new Map<string, XY>();
  for (const [id, position] of raw) {
    positions.set(id, { x: position.x - minX, y: position.y - minY });
  }

  return { positions, width: maxX - minX, height: maxY - minY };
}

/**
 * Pack boxes into left-to-right shelves that wrap at a derived target width.
 * Deterministic: the input order is preserved and no box is rotated or sorted.
 */
function shelfPack(items: Size[]): PackResult {
  if (items.length === 0) return { offsets: [], width: 0, height: 0 };

  let widest = 0;
  let area = 0;
  for (const item of items) {
    widest = Math.max(widest, item.width);
    area += item.width * item.height;
  }
  const targetWidth = Math.max(widest, Math.sqrt(area * SHELF_ASPECT));

  const offsets: XY[] = [];
  let cursorX = 0;
  let rowY = 0;
  let rowHeight = 0;
  let width = 0;

  for (const item of items) {
    if (cursorX > 0 && cursorX + item.width > targetWidth) {
      rowY += rowHeight + ITEM_GAP;
      cursorX = 0;
      rowHeight = 0;
    }

    offsets.push({ x: cursorX, y: rowY });
    cursorX += item.width + ITEM_GAP;
    rowHeight = Math.max(rowHeight, item.height);
    width = Math.max(width, cursorX - ITEM_GAP);
  }

  return { offsets, width, height: rowY + rowHeight };
}

function layoutGroup(group: GroupTreeNode, ctx: LayoutContext): LaidGroup {
  const fileCount = countFiles(group);

  if (ctx.collapsedGroupIds.has(group.id)) {
    return {
      group,
      collapsed: true,
      fileCount,
      width: COLLAPSED_WIDTH,
      // A pill carries the aggregated pins of its whole subtree, so it needs the
      // same room per pin as a file node does.
      height: Math.max(
        COLLAPSED_HEIGHT,
        ctx.nodeHeights.get(group.id) ?? COLLAPSED_HEIGHT,
      ),
      children: [],
      filePositions: new Map(),
    };
  }

  const ownFiles: GraphNode[] = [];
  for (const fileId of group.fileIds) {
    const node = ctx.nodesById.get(fileId);
    if (node) ownFiles.push(node);
  }

  const block = layoutFileBlock(ownFiles, ctx);
  const children = group.children.map((child) => layoutGroup(child, ctx));

  const items: Size[] = [];
  if (block.positions.size > 0) items.push(block);
  for (const child of children) items.push(child);

  const packed = shelfPack(items);
  const contentX = FRAME_PADDING;
  const contentY = HEADER_HEIGHT + FRAME_PADDING;
  const firstChildOffset = block.positions.size > 0 ? 1 : 0;

  const filePositions = new Map<string, XY>();
  if (block.positions.size > 0) {
    const offset = packed.offsets[0];
    for (const [id, position] of block.positions) {
      filePositions.set(id, {
        x: contentX + offset.x + position.x,
        y: contentY + offset.y + position.y,
      });
    }
  }

  const placedChildren = children.map((child, index) => {
    const offset = packed.offsets[firstChildOffset + index];
    return { laid: child, x: contentX + offset.x, y: contentY + offset.y };
  });

  return {
    group,
    collapsed: false,
    fileCount,
    width: Math.max(MIN_FRAME_WIDTH, packed.width + FRAME_PADDING * 2),
    height: contentY + packed.height + FRAME_PADDING,
    children: placedChildren,
    filePositions,
  };
}

function collectPlacedFileIds(laid: LaidGroup, into: Set<string>): void {
  for (const id of laid.filePositions.keys()) into.add(id);
  for (const child of laid.children) collectPlacedFileIds(child.laid, into);
}

function flatten(
  placed: PlacedGroup,
  parentId: string | undefined,
  groupBoxes: GroupBox[],
  filePositions: Map<string, XY>,
): void {
  const { laid, x, y } = placed;

  groupBoxes.push({
    id: laid.group.id,
    name: laid.group.name,
    depth: laid.group.depth,
    parentId,
    x,
    y,
    width: laid.width,
    height: laid.height,
    collapsed: laid.collapsed,
    fileCount: laid.fileCount,
  });

  for (const [id, position] of laid.filePositions) {
    filePositions.set(id, position);
  }
  for (const child of laid.children) {
    flatten(child, laid.group.id, groupBoxes, filePositions);
  }
}

/**
 * Lay out the group frames and the file nodes inside them.
 *
 * Coordinates follow the React Flow parent/child convention: a `GroupBox` with a
 * `parentId` and a file that sits inside a frame carry coordinates relative to the top
 * left corner of that frame, while a top level frame and an ungrouped file carry
 * absolute canvas coordinates. It is the coordinates alone that arrive ready to use -
 * a file position carries no `parentId`, and the caller pairs it with one derived from
 * the file's group path.
 * `groupBoxes` comes out in pre-order, i.e. a parent always precedes its children,
 * which is the order React Flow requires in its `nodes` array.
 *
 * @param visibleFileNodes Files to place; expected to be the `visibleFileNodes` of `deriveVisibleGraph`.
 * @param tree Group forest from `buildGroupTree`, built from the same node set.
 * @param nodeHeights Heights keyed by file id and by collapsed group id; ids missing
 * from the map fall back to NODE_HEIGHT for a file and to the baseline pill height.
 */
export function computeGroupedLayout(
  visibleFileNodes: GraphNode[],
  tree: GroupTreeNode[],
  mode: "layered" | "force",
  collapsedGroupIds: Set<string>,
  nodeHeights: Map<string, number>,
): GroupedLayoutResult {
  const ctx: LayoutContext = {
    mode,
    collapsedGroupIds,
    nodesById: new Map(visibleFileNodes.map((node) => [node.id, node])),
    nodeHeights,
  };

  const roots = tree.map((group) => layoutGroup(group, ctx));

  const placedFileIds = new Set<string>();
  for (const root of roots) collectPlacedFileIds(root, placedFileIds);
  const ungrouped = visibleFileNodes.filter(
    (node) => !placedFileIds.has(node.id),
  );

  const block = layoutFileBlock(ungrouped, ctx);
  const items: Size[] = [];
  if (block.positions.size > 0) items.push(block);
  for (const root of roots) items.push(root);

  const packed = shelfPack(items);
  const firstRootOffset = block.positions.size > 0 ? 1 : 0;

  const filePositions = new Map<string, XY>();
  const groupBoxes: GroupBox[] = [];

  if (block.positions.size > 0) {
    const offset = packed.offsets[0];
    for (const [id, position] of block.positions) {
      filePositions.set(id, {
        x: offset.x + position.x,
        y: offset.y + position.y,
      });
    }
  }

  roots.forEach((laid, index) => {
    const offset = packed.offsets[firstRootOffset + index];
    flatten({ laid, x: offset.x, y: offset.y }, undefined, groupBoxes, filePositions);
  });

  return { filePositions, groupBoxes };
}
