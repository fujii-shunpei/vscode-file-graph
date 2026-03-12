import * as vscode from "vscode";
import { GraphData } from "./analyzer";

export interface PanelCallbacks {
  onMessage?: (message: any) => void;
  onDispose?: () => void;
}

export class GraphPanel {
  public static currentPanel: GraphPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private callbacks: PanelCallbacks = {};
  private initialized = false;

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message) => {
        if (message.command === "openFile") {
          const uri = vscode.Uri.file(message.filePath);
          vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One });
        }
        this.callbacks.onMessage?.(message);
      },
      null,
      this.disposables
    );
  }

  static show(graphData: GraphData, focusLabel: string, callbacks?: PanelCallbacks): GraphPanel {
    const column = vscode.ViewColumn.Beside;

    if (GraphPanel.currentPanel) {
      GraphPanel.currentPanel.panel.reveal(column);
      if (callbacks) GraphPanel.currentPanel.callbacks = callbacks;
      GraphPanel.currentPanel.update(graphData, focusLabel);
      return GraphPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "fileGraph",
      `File Graph: ${focusLabel}`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    GraphPanel.currentPanel = new GraphPanel(panel);
    if (callbacks) GraphPanel.currentPanel.callbacks = callbacks;
    GraphPanel.currentPanel.update(graphData, focusLabel);
    return GraphPanel.currentPanel;
  }

  private update(graphData: GraphData, focusLabel: string): void {
    this.panel.title = `File Graph: ${focusLabel}`;

    if (!this.initialized) {
      this.panel.webview.html = this.getHtml(graphData);
      this.initialized = true;
    } else {
      this.panel.webview.postMessage({
        command: "updateGraph",
        data: graphData,
      });
    }
  }

  private getHtml(graphData: GraphData): string {
    const data = JSON.stringify(graphData);

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>File Graph</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #ccc);
    font-family: var(--vscode-font-family, monospace);
    overflow: hidden;
  }
  svg { width: 100vw; height: 100vh; }

  .layer-band {
    fill-opacity: 0.06;
  }
  .layer-label {
    font-size: 11px;
    fill: var(--vscode-descriptionForeground, #888);
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .node { cursor: pointer; }
  .node rect {
    rx: 6;
    ry: 6;
    stroke-width: 2px;
    transition: opacity 0.2s;
  }
  .node.focused rect { stroke-width: 3px; stroke: #fff; }
  .node.dimmed { opacity: 0.2; }
  .node text {
    font-size: 11px;
    fill: var(--vscode-editor-foreground, #ccc);
    pointer-events: none;
  }
  .node .sublabel {
    font-size: 9px;
    fill: var(--vscode-descriptionForeground, #888);
  }
  .node:hover rect { filter: brightness(1.3); }

  .link {
    stroke-opacity: 0.4;
    fill: none;
    transition: stroke-opacity 0.2s;
  }
  .link.highlighted {
    stroke-opacity: 1;
    stroke-width: 2.5;
  }
  .link.dimmed {
    stroke-opacity: 0.08;
  }

  .controls {
    position: fixed;
    top: 10px;
    left: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 10;
  }
  .control-row {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .control-label {
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #888);
    min-width: 40px;
  }
  .controls button {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none;
    padding: 3px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
  }
  .controls button:hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }
  .controls button.active {
    background: var(--vscode-inputValidation-infoBorder, #007acc);
  }

  .legend {
    position: fixed;
    top: 10px;
    right: 10px;
    background: var(--vscode-sideBar-background, #252526);
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 11px;
    z-index: 10;
  }
  .legend-title {
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #888);
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 3px 0;
    cursor: pointer;
    user-select: none;
  }
  .legend-item.disabled {
    opacity: 0.3;
    text-decoration: line-through;
  }
  .legend-dot {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .current-file {
    position: fixed;
    bottom: 10px;
    left: 10px;
    background: var(--vscode-sideBar-background, #252526);
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 10px;
    z-index: 10;
    max-width: 80vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stats {
    position: fixed;
    bottom: 10px;
    right: 10px;
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #888);
    z-index: 10;
  }
</style>
</head>
<body>

<div class="controls">
  <div class="control-row">
    <span class="control-label">Depth</span>
    <button onclick="setDepth(1)" id="depth-1">1</button>
    <button onclick="setDepth(2)" id="depth-2" class="active">2</button>
    <button onclick="setDepth(3)" id="depth-3">3</button>
  </div>
  <div class="control-row">
    <span class="control-label">View</span>
    <button onclick="resetZoom()">Reset</button>
    <button onclick="toggleMode()" id="mode-btn">Force</button>
  </div>
</div>

<div class="current-file" id="currentFile"></div>
<div class="stats" id="stats"></div>

<svg id="graph"></svg>

<script>
const vscodeApi = acquireVsCodeApi();

const LAYER_COLORS = {
  Route:       '#fff176',
  Middleware:  '#a1887f',
  Controller:  '#4fc3f7',
  Request:     '#ce93d8',
  UseCase:     '#81c784',
  Service:     '#aed581',
  Event:       '#f06292',
  Job:         '#ba68c8',
  Mail:        '#4dd0e1',
  Model:       '#ffb74d',
  Repository:  '#ff8a65',
  Component:   '#64b5f6',
  Hook:        '#4db6ac',
  Store:       '#e57373',
  Page:        '#7986cb',
  API:         '#ffcc80',
  Util:        '#b0bec5',
  Type:        '#9fa8da',
  Test:        '#a5d6a7',
  Migration:   '#90a4ae',
  Config:      '#78909c',
  Other:       '#bdbdbd',
};

// Layer order for hierarchical layout (top to bottom)
const LAYER_ORDER = [
  'Route', 'Middleware', 'Controller', 'Page', 'Component', 'Request',
  'UseCase', 'Service', 'Hook', 'Store', 'API',
  'Event', 'Job', 'Mail',
  'Model', 'Repository',
  'Util', 'Type', 'Test',
  'Migration', 'Config', 'Other'
];

const NS = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('graph');

let currentMode = 'layered'; // 'layered' or 'force'
let currentDepth = 2;
let disabledLayers = new Set();
let transform = { x: 0, y: 0, k: 1 };
let dragNode = null;
let dragOffset = null;
let isPanning = false;
let panStart = { x: 0, y: 0 };
let animationId = null;
let currentGraphData = null;
let highlightedNode = null;

// State
let g = null;
let nodeMap = {};
let edgeElements = [];
let nodeElements = [];
let bandElements = [];

function buildGraph(graphData) {
  currentGraphData = graphData;
  const width = window.innerWidth;
  const height = window.innerHeight;

  if (animationId) cancelAnimationFrame(animationId);
  while (svg.childNodes.length > 0) svg.removeChild(svg.lastChild);
  transform = { x: 0, y: 0, k: 1 };

  // Arrow defs
  const defs = document.createElementNS(NS, 'defs');
  const marker = document.createElementNS(NS, 'marker');
  marker.setAttribute('id', 'arrow');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '28');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '6');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('orient', 'auto');
  const arrowPath = document.createElementNS(NS, 'path');
  arrowPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  arrowPath.setAttribute('fill', '#666');
  marker.appendChild(arrowPath);
  defs.appendChild(marker);
  svg.appendChild(defs);

  g = document.createElementNS(NS, 'g');
  svg.appendChild(g);

  // Filter nodes by disabled layers
  const visibleNodes = graphData.nodes.filter(n => !disabledLayers.has(n.layer));
  const visibleIds = new Set(visibleNodes.map(n => n.id));
  const visibleEdges = graphData.edges.filter(e =>
    visibleIds.has(e.source) && visibleIds.has(e.target)
  );

  // Group nodes by layer
  const layerGroups = {};
  visibleNodes.forEach(n => {
    if (!layerGroups[n.layer]) layerGroups[n.layer] = [];
    layerGroups[n.layer].push(n);
  });

  const presentLayers = LAYER_ORDER.filter(l => layerGroups[l]);
  const PADDING_TOP = 40;
  const ROW_HEIGHT = Math.max(70, Math.min(100, (height - PADDING_TOP * 2) / Math.max(presentLayers.length, 1)));
  const NODE_W = 150;
  const NODE_H = 36;

  if (currentMode === 'layered') {
    // Layered layout
    bandElements = [];
    presentLayers.forEach((layer, rowIdx) => {
      const y = PADDING_TOP + rowIdx * ROW_HEIGHT;
      const nodes = layerGroups[layer];

      // Background band
      const band = document.createElementNS(NS, 'rect');
      band.setAttribute('class', 'layer-band');
      band.setAttribute('x', '0');
      band.setAttribute('y', String(y));
      band.setAttribute('width', String(width * 3));
      band.setAttribute('height', String(ROW_HEIGHT));
      band.setAttribute('fill', LAYER_COLORS[layer] || LAYER_COLORS.Other);
      g.appendChild(band);
      bandElements.push(band);

      // Layer label
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('class', 'layer-label');
      label.setAttribute('x', '10');
      label.setAttribute('y', String(y + 16));
      label.textContent = layer;
      g.appendChild(label);

      // Position nodes
      const startX = 120;
      const spacing = Math.max(NODE_W + 20, (width - startX - 40) / Math.max(nodes.length, 1));
      nodes.forEach((n, i) => {
        n.x = startX + i * spacing;
        n.y = y + (ROW_HEIGHT - NODE_H) / 2;
        n.vx = 0;
        n.vy = 0;
      });
    });
  } else {
    // Force layout - circular initial positions
    const cx = width / 2;
    const cy = height / 2;
    visibleNodes.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / visibleNodes.length;
      const radius = n.isFocused ? 0 : 200;
      n.x = cx + radius * Math.cos(angle);
      n.y = cy + radius * Math.sin(angle);
      n.vx = 0;
      n.vy = 0;
    });
  }

  nodeMap = {};
  visibleNodes.forEach(n => { nodeMap[n.id] = n; });

  // Create edges (curved paths)
  edgeElements = visibleEdges.map(e => {
    const pathEl = document.createElementNS(NS, 'path');
    pathEl.setAttribute('class', 'link');
    pathEl.setAttribute('stroke', '#666');
    pathEl.setAttribute('stroke-width', '1.5');
    pathEl.setAttribute('marker-end', 'url(#arrow)');
    g.appendChild(pathEl);
    return { data: e, el: pathEl };
  });

  // Create nodes (rounded rects with labels)
  nodeElements = visibleNodes.map(n => {
    const group = document.createElementNS(NS, 'g');
    group.setAttribute('class', 'node' + (n.isFocused ? ' focused' : ''));
    group.setAttribute('data-id', n.id);

    const rect = document.createElementNS(NS, 'rect');
    const color = LAYER_COLORS[n.layer] || LAYER_COLORS.Other;
    rect.setAttribute('width', String(NODE_W));
    rect.setAttribute('height', String(NODE_H));
    rect.setAttribute('fill', color + '33');
    rect.setAttribute('stroke', n.isFocused ? '#fff' : color);
    group.appendChild(rect);

    // File name
    const fileName = n.label.split('/').pop().replace('.php', '');
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', '10');
    text.setAttribute('y', '15');
    text.setAttribute('fill', '#fff');
    text.setAttribute('font-size', '12');
    text.setAttribute('font-weight', n.isFocused ? 'bold' : 'normal');
    text.textContent = truncate(fileName.replace(/\.(tsx?|jsx?|php)$/, ''), 18);
    group.appendChild(text);

    // Directory path
    const parts = n.label.split('/');
    parts.pop();
    const dirPath = parts.join('/');
    const subtext = document.createElementNS(NS, 'text');
    subtext.setAttribute('class', 'sublabel');
    subtext.setAttribute('x', '10');
    subtext.setAttribute('y', '29');
    subtext.textContent = truncate(dirPath, 22);
    group.appendChild(subtext);

    // Tooltip
    const title = document.createElementNS(NS, 'title');
    title.textContent = n.label;
    group.appendChild(title);

    // Click to open file
    group.addEventListener('click', (e) => {
      if (e.shiftKey) {
        // Shift+click: highlight connections
        toggleHighlight(n);
      } else {
        vscodeApi.postMessage({ command: 'openFile', filePath: n.id });
      }
    });

    // Hover: highlight connections
    group.addEventListener('mouseenter', () => highlightConnections(n));
    group.addEventListener('mouseleave', () => { if (!highlightedNode) clearHighlight(); });

    // Drag
    group.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        e.stopPropagation();
        dragNode = n;
        dragOffset = { x: e.clientX, y: e.clientY };
      }
    });

    g.appendChild(group);
    return { data: n, el: group };
  });

  // Update legend
  updateLegend(graphData);

  // Update info
  const focusNode = graphData.nodes.find(n => n.isFocused);
  document.getElementById('currentFile').textContent = focusNode ? focusNode.label : '';
  document.getElementById('stats').textContent =
    visibleNodes.length + ' files, ' + visibleEdges.length + ' connections';

  if (currentMode === 'layered') {
    render();
  } else {
    let frame = 0;
    const cx = width / 2;
    const cy = height / 2;
    function tick() {
      simulateForce(visibleNodes, visibleEdges, cx, cy);
      frame++;
      if (frame < 300) animationId = requestAnimationFrame(tick);
    }
    tick();
  }
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + '...' : str;
}

function updateLegend(graphData) {
  let legendDiv = document.querySelector('.legend');
  if (!legendDiv) {
    legendDiv = document.createElement('div');
    legendDiv.className = 'legend';
    document.body.appendChild(legendDiv);
  }
  legendDiv.innerHTML = '<div class="legend-title">Layers (click to filter)</div>';

  const allLayers = [...new Set(graphData.nodes.map(n => n.layer))];
  const orderedLayers = LAYER_ORDER.filter(l => allLayers.includes(l));

  orderedLayers.forEach(layer => {
    const count = graphData.nodes.filter(n => n.layer === layer).length;
    const item = document.createElement('div');
    item.className = 'legend-item' + (disabledLayers.has(layer) ? ' disabled' : '');
    item.innerHTML =
      '<div class="legend-dot" style="background:' +
      (LAYER_COLORS[layer] || LAYER_COLORS.Other) +
      '"></div><span>' + layer + ' (' + count + ')</span>';
    item.addEventListener('click', () => {
      if (disabledLayers.has(layer)) {
        disabledLayers.delete(layer);
      } else {
        disabledLayers.add(layer);
      }
      buildGraph(currentGraphData);
    });
    legendDiv.appendChild(item);
  });
}

function highlightConnections(node) {
  const connectedIds = new Set([node.id]);
  edgeElements.forEach(({ data }) => {
    if (data.source === node.id) connectedIds.add(data.target);
    if (data.target === node.id) connectedIds.add(data.source);
  });

  nodeElements.forEach(({ data, el }) => {
    el.classList.toggle('dimmed', !connectedIds.has(data.id));
  });
  edgeElements.forEach(({ data, el }) => {
    const connected = data.source === node.id || data.target === node.id;
    el.classList.toggle('highlighted', connected);
    el.classList.toggle('dimmed', !connected);
  });
}

function toggleHighlight(node) {
  if (highlightedNode === node) {
    highlightedNode = null;
    clearHighlight();
  } else {
    highlightedNode = node;
    highlightConnections(node);
  }
}

function clearHighlight() {
  nodeElements.forEach(({ el }) => el.classList.remove('dimmed'));
  edgeElements.forEach(({ el }) => {
    el.classList.remove('highlighted', 'dimmed');
  });
}

function render() {
  const NODE_W = 150;
  const NODE_H = 36;

  edgeElements.forEach(({ data, el }) => {
    const s = nodeMap[data.source];
    const t = nodeMap[data.target];
    if (!s || !t) return;

    const sx = s.x + NODE_W / 2;
    const sy = s.y + NODE_H / 2;
    const tx = t.x + NODE_W / 2;
    const ty = t.y + NODE_H / 2;

    if (currentMode === 'layered') {
      // Curved path for layered view
      const midY = (sy + ty) / 2;
      el.setAttribute('d',
        'M ' + sx + ' ' + sy +
        ' C ' + sx + ' ' + midY + ', ' + tx + ' ' + midY + ', ' + tx + ' ' + ty
      );
    } else {
      el.setAttribute('d',
        'M ' + sx + ' ' + sy + ' L ' + tx + ' ' + ty
      );
    }
  });

  nodeElements.forEach(({ data, el }) => {
    el.setAttribute('transform', 'translate(' + data.x + ',' + data.y + ')');
  });
}

function simulateForce(nodes, edges, cx, cy) {
  const alpha = 0.3;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      let dx = nodes[j].x - nodes[i].x;
      let dy = nodes[j].y - nodes[i].y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      let force = 1200 / (dist * dist);
      let fx = dx / dist * force;
      let fy = dy / dist * force;
      nodes[i].vx -= fx;
      nodes[i].vy -= fy;
      nodes[j].vx += fx;
      nodes[j].vy += fy;
    }
  }

  edges.forEach(e => {
    const s = nodeMap[e.source];
    const t = nodeMap[e.target];
    if (!s || !t) return;
    let dx = t.x - s.x;
    let dy = t.y - s.y;
    let dist = Math.sqrt(dx * dx + dy * dy) || 1;
    let force = (dist - 160) * 0.008;
    let fx = dx / dist * force;
    let fy = dy / dist * force;
    s.vx += fx;
    s.vy += fy;
    t.vx -= fx;
    t.vy -= fy;
  });

  nodes.forEach(n => {
    n.vx += (cx - n.x) * 0.001;
    n.vy += (cy - n.y) * 0.001;
  });

  nodes.forEach(n => {
    if (n === dragNode) return;
    n.vx *= 0.6;
    n.vy *= 0.6;
    n.x += n.vx * alpha;
    n.y += n.vy * alpha;
  });

  render();
}

// Depth control
function setDepth(d) {
  currentDepth = d;
  [1,2,3].forEach(i => {
    document.getElementById('depth-' + i).classList.toggle('active', i === d);
  });
  // Request re-analysis from extension
  vscodeApi.postMessage({ command: 'setDepth', depth: d });
}

// Toggle layered / force mode
function toggleMode() {
  currentMode = currentMode === 'layered' ? 'force' : 'layered';
  document.getElementById('mode-btn').textContent =
    currentMode === 'layered' ? 'Force' : 'Layered';
  if (currentGraphData) buildGraph(currentGraphData);
}

function resetZoom() {
  transform = { x: 0, y: 0, k: 1 };
  applyTransform();
}

function applyTransform() {
  if (g) {
    g.setAttribute('transform',
      'translate(' + transform.x + ',' + transform.y + ') scale(' + transform.k + ')');
  }
}

// Global event listeners
document.addEventListener('mousemove', (e) => {
  if (dragNode) {
    dragNode.x += (e.clientX - dragOffset.x) / transform.k;
    dragNode.y += (e.clientY - dragOffset.y) / transform.k;
    dragNode.vx = 0;
    dragNode.vy = 0;
    dragOffset = { x: e.clientX, y: e.clientY };
    render();
  }
});
document.addEventListener('mouseup', () => { dragNode = null; });

svg.addEventListener('mousedown', (e) => {
  if (!dragNode) {
    isPanning = true;
    panStart = { x: e.clientX - transform.x, y: e.clientY - transform.y };
  }
});
svg.addEventListener('mousemove', (e) => {
  if (isPanning && !dragNode) {
    transform.x = e.clientX - panStart.x;
    transform.y = e.clientY - panStart.y;
    applyTransform();
  }
});
svg.addEventListener('mouseup', () => { isPanning = false; });
svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const scaleFactor = e.deltaY > 0 ? 0.9 : 1.1;
  const newK = Math.max(0.1, Math.min(5, transform.k * scaleFactor));
  const mx = e.clientX;
  const my = e.clientY;
  transform.x = mx - (mx - transform.x) * (newK / transform.k);
  transform.y = my - (my - transform.y) * (newK / transform.k);
  transform.k = newK;
  applyTransform();
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.command === 'updateGraph') {
    buildGraph(message.data);
  }
});

buildGraph(${data});
</script>
</body>
</html>`;
  }

  private dispose(): void {
    GraphPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.callbacks.onDispose?.();
  }
}
