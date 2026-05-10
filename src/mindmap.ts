import { v4 as uuidv4 } from "uuid";
import { readFile, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadMindmap, saveMindmap } from "./storage.js";
import type { MindNode, Mindmap } from "./types.js";

// Serialized write queue — prevents concurrent file corruption under parallel tool calls
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const task = writeQueue.then(fn);
  writeQueue = task.then(
    () => {},
    () => {}
  );
  return task;
}

function ts(): string {
  return new Date().toISOString();
}

function normalizeTags(tags: string[]): string[] {
  return tags.map((t) => t.replace(/^#+/, "").trim().toLowerCase()).filter(Boolean);
}

// ── Write operations (serialized) ────────────────────────────────────────────

export function addIdea(
  text: string,
  parentId?: string,
  tags?: string[]
): Promise<MindNode> {
  return enqueue(async () => {
    const map = await loadMindmap();

    if (parentId !== undefined && !map.nodes[parentId]) {
      throw new Error(`Parent node not found: ${parentId}`);
    }

    // Dedup: if an identical text already exists under the same parent, return it
    const textNorm = text.trim().toLowerCase();
    const existing = Object.values(map.nodes).find(
      (n) => n.text.trim().toLowerCase() === textNorm && n.parentId === parentId
    );
    if (existing) {
      console.error(`[mindkeeper] skip duplicate "${text.slice(0, 60)}" (${existing.id})`);
      return existing;
    }

    const node: MindNode = {
      id: uuidv4(),
      text,
      children: [],
      createdAt: ts(),
      updatedAt: ts(),
      tags: normalizeTags(tags ?? []),
      ...(parentId !== undefined && { parentId }),
    };

    map.nodes[node.id] = node;

    if (parentId !== undefined) {
      const parent = map.nodes[parentId];
      if (parent) {
        parent.children.push(node.id);
        parent.updatedAt = ts();
      }
    } else if (map.rootId === null) {
      map.rootId = node.id;
    }

    await saveMindmap(map);
    console.error(`[mindkeeper] add ${node.id} "${text.slice(0, 60)}"`);
    return node;
  });
}

export function updateNode(
  nodeId: string,
  newText: string,
  newTags?: string[]
): Promise<MindNode> {
  return enqueue(async () => {
    const map = await loadMindmap();
    const node = map.nodes[nodeId];
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    node.text = newText;
    if (newTags !== undefined) node.tags = normalizeTags(newTags);
    node.updatedAt = ts();

    await saveMindmap(map);
    console.error(`[mindkeeper] update ${nodeId}`);
    return node;
  });
}

export function deleteNode(
  nodeId: string
): Promise<{ deleted: string; orphaned: string[] }> {
  return enqueue(async () => {
    const map = await loadMindmap();
    const node = map.nodes[nodeId];
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    // Detach from parent's children list
    if (node.parentId !== undefined) {
      const parent = map.nodes[node.parentId];
      if (parent) {
        parent.children = parent.children.filter((id) => id !== nodeId);
        parent.updatedAt = ts();
      }
    }

    // Orphan children — keep them in the map but remove parent reference
    const orphaned = [...node.children];
    for (const childId of node.children) {
      const child = map.nodes[childId];
      if (child) delete child.parentId;
    }

    if (map.rootId === nodeId) map.rootId = null;
    delete map.nodes[nodeId];

    await saveMindmap(map);
    console.error(
      `[mindkeeper] delete ${nodeId}` +
        (orphaned.length ? `, orphaned [${orphaned.join(", ")}]` : "")
    );
    return { deleted: nodeId, orphaned };
  });
}

// ── Read operations (no queue needed) ────────────────────────────────────────

export async function getLastSession(limit = 5): Promise<{
  lastActive: string | null;
  recentNodes: Array<{ id: string; text: string; tags: string[]; updatedAt: string; path: string[] }>;
}> {
  const map = await loadMindmap();
  const allNodes = Object.values(map.nodes);
  if (allNodes.length === 0) return { lastActive: null, recentNodes: [] };

  const sorted = [...allNodes].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  function getPath(nodeId: string): string[] {
    const path: string[] = [];
    let cur = map.nodes[nodeId];
    while (cur?.parentId) {
      const parent = map.nodes[cur.parentId];
      if (!parent) break;
      path.unshift(parent.text);
      cur = parent;
    }
    return path;
  }

  return {
    lastActive: sorted[0]!.updatedAt,
    recentNodes: sorted.slice(0, limit).map((n) => ({
      id: n.id,
      text: n.text,
      tags: n.tags,
      updatedAt: n.updatedAt,
      path: getPath(n.id),
    })),
  };
}

export async function searchNodes(
  query: string
): Promise<Array<{ node: MindNode; score: number }>> {
  const map = await loadMindmap();
  const q = query.toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  const results: Array<{ node: MindNode; score: number }> = [];

  for (const node of Object.values(map.nodes)) {
    const text = node.text.toLowerCase();
    const tagList = node.tags.map((t) => t.toLowerCase());
    let score = 0;

    if (text === q) score += 10;             // exact whole-string match
    else if (text.includes(q)) score += 5;   // full query is a substring

    for (const tok of tokens) {
      if (text.includes(tok)) score += 2;                        // token in text
      if (tagList.some((tag) => tag.includes(tok))) score += 1;  // token in tags
    }

    if (score > 0) results.push({ node, score });
  }

  return results.sort((a, b) => b.score - a.score);
}

export async function getSubtree(nodeId: string): Promise<MindNode[]> {
  const map = await loadMindmap();
  if (!map.nodes[nodeId]) throw new Error(`Node not found: ${nodeId}`);

  const collected: MindNode[] = [];

  function collect(id: string): void {
    const n = map.nodes[id];
    if (!n) return;
    collected.push(n);
    n.children.forEach(collect);
  }

  collect(nodeId);
  return collected;
}

export async function exportMarkdown(): Promise<string> {
  const map = await loadMindmap();
  const lines: string[] = ["# Mindkeeper\n"];

  function renderNode(id: string, depth: number): void {
    const node = map.nodes[id];
    if (!node) return;
    const indent = "  ".repeat(depth);
    const tagStr = node.tags.length > 0 ? `  \`[${node.tags.join(", ")}]\`` : "";
    lines.push(`${indent}- ${node.text}${tagStr}`);
    node.children.forEach((childId) => renderNode(childId, depth + 1));
  }

  if (map.rootId) renderNode(map.rootId, 0);

  const orphans = Object.values(map.nodes).filter(
    (n) => n.parentId === undefined && n.id !== map.rootId
  );

  if (orphans.length > 0) {
    lines.push("\n## Orphaned Nodes\n");
    for (const n of orphans) {
      const tagStr = n.tags.length > 0 ? `  \`[${n.tags.join(", ")}]\`` : "";
      lines.push(`- ${n.text}${tagStr}`);
      n.children.forEach((childId) => renderNode(childId, 1));
    }
  }

  return lines.join("\n");
}

export async function exportJSON(): Promise<Mindmap> {
  return loadMindmap();
}

export async function exportHTML(): Promise<{ filePath: string; nodeCount: number }> {
  const map = await loadMindmap();
  const nodeCount = Object.keys(map.nodes).length;
  const generatedAt = new Date().toLocaleString();
  const inlinedData = JSON.stringify(map);

  // Read library from docs/ — single source of truth, also served on GH Pages
  const libPath = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "mindkeeper-map.js");
  const librarySource = await readFile(libPath, "utf-8");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mindmap — mindkeeper</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #f8f9fb; }
    #map { width: 100%; height: 100%; }
    #toolbar {
      position: fixed; top: 14px; right: 14px;
      background: rgba(255,255,255,0.93); border: 1px solid #e1e4e8;
      border-radius: 10px; padding: 8px 16px; font-size: 11.5px; color: #6e7681;
      z-index: 100; backdrop-filter: blur(8px); display: flex; align-items: center;
      gap: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.10); user-select: none;
      font-family: system-ui, -apple-system, sans-serif;
    }
    #toolbar b { color: #24292f; font-size: 13px; }
    #toolbar .sep { color: #d0d7de; }
    #toolbar button {
      border: 1px solid #d0d7de; border-radius: 6px;
      background: transparent; padding: 3px 9px;
      font-size: 11px; color: #24292f; cursor: pointer; font-family: inherit;
    }
    #toolbar button:hover { background: #f3f4f6; border-color: #b0b8c3; }
  </style>
</head>
<body>
  <div id="map"></div>
  <div id="toolbar">
    <b>&#x1F9E0; mindkeeper</b>
    <span class="sep">&#xB7;</span>
    <span>${nodeCount} node${nodeCount !== 1 ? "s" : ""}</span>
    <span class="sep">&#xB7;</span>
    <span>${generatedAt}</span>
    <span class="sep">&#xB7;</span>
    <span>Scroll to zoom &middot; Drag nodes or background</span>
    <span class="sep">&#xB7;</span>
    <button id="btn-png">&#x1F4F7; PNG</button>
    <button id="btn-svg">&#x2193; SVG</button>
  </div>
  <script>
${librarySource}
  </script>
  <script>
    var MAP = ${inlinedData};

    function toTree(nodes, id) {
      var n = nodes[id];
      if (!n) return null;
      var kids = (n.children || []).map(function(cid) { return toTree(nodes, cid); }).filter(Boolean);
      var node = { id: n.id, topic: n.text };
      if (kids.length) node.children = kids;
      return node;
    }

    var nodes = MAP.nodes;
    var rootId = MAP.rootId;
    var rootNode = rootId ? nodes[rootId] : Object.values(nodes)[0];
    var orphans = Object.values(nodes).filter(function(n) { return !n.parentId && n.id !== rootId; });

    var data;
    if (!rootNode) {
      data = { id: 'empty', topic: 'Mindkeeper (empty)', children: [] };
    } else if (!orphans.length) {
      data = toTree(nodes, rootNode.id);
    } else {
      data = {
        id: '__root__', topic: 'Mindkeeper',
        children: [toTree(nodes, rootNode.id)]
          .concat(orphans.map(function(o) { return toTree(nodes, o.id); }))
          .filter(Boolean)
      };
    }

    var mm = new MindkeeperMap('#map');
    mm.init(data);
    document.getElementById('btn-png').onclick = function() { mm.exportPNG('mindmap.png'); };
    document.getElementById('btn-svg').onclick = function() { mm.exportSVG('mindmap.svg'); };
  </script>
</body>
</html>`;

  const outPath = join(homedir(), ".mindkeeper", "mindmap-export.html");
  await writeFile(outPath, html, "utf-8");
  return { filePath: outPath, nodeCount };
}

// ── Server-side SVG layout engine ────────────────────────────────────────────

const PALETTE_SVG = [
  { fill: "#B5EAD7", stroke: "#55B88A", text: "#14432c" },
  { fill: "#FFD1DC", stroke: "#D9607A", text: "#5c0f22" },
  { fill: "#C7CEEA", stroke: "#6A7AC8", text: "#151e62" },
  { fill: "#FFDAC1", stroke: "#D48040", text: "#5c2800" },
  { fill: "#E2F0CB", stroke: "#80B840", text: "#223800" },
  { fill: "#B5D5EA", stroke: "#4898C8", text: "#0a2c4a" },
  { fill: "#F9C9E8", stroke: "#C840A0", text: "#500040" },
  { fill: "#FAF0B5", stroke: "#B8A010", text: "#332800" },
];
const ROOT_SVG = { fill: "#AED6DC", stroke: "#2898B8", text: "#082830" };

interface LayoutNode {
  id: string;
  topic: string;
  cx: number; cy: number;
  w: number; h: number;
  depth: number;
  isLeft: boolean;
  isRoot: boolean;
  style: { fill: string; stroke: string; text: string };
}
interface LayoutLink { source: LayoutNode; target: LayoutNode }

function svgEstimateW(text: string, fontSize: number, bold: boolean): number {
  return text.length * fontSize * (bold ? 0.58 : 0.52);
}

function svgTrunc(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function svgEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type TreeNode = { id: string; topic: string; _slot: number; children: TreeNode[] };

function assignSlotsTree(root: TreeNode): number {
  let c = 0;
  function walk(n: TreeNode) {
    if (!n.children.length) { n._slot = c++; return; }
    n.children.forEach(walk);
    n._slot = (n.children[0]!._slot + n.children[n.children.length - 1]!._slot) / 2;
  }
  walk(root);
  return c;
}

function buildSvgLayout(map: Mindmap): { nodes: LayoutNode[]; links: LayoutLink[] } {
  const nodes: LayoutNode[] = [];
  const links: LayoutLink[] = [];
  if (!map.rootId || !map.nodes[map.rootId]) return { nodes, links };

  const LEVEL_W = 240, V_GAP = 54;
  const cx = 500, cy = 400;

  function toTree(id: string): TreeNode {
    const n = map.nodes[id];
    if (!n) throw new Error(`missing node ${id}`);
    return { id: n.id, topic: n.text, _slot: 0, children: n.children.map(toTree) };
  }

  const rootData = toTree(map.rootId);
  const rootText = svgTrunc(rootData.topic, 32);
  const rootW = Math.max(svgEstimateW(rootText, 15, true) + 44, 110);
  const rootNode: LayoutNode = {
    id: rootData.id, topic: rootText,
    cx, cy, w: rootW, h: 42,
    depth: 0, isLeft: false, isRoot: true, style: ROOT_SVG,
  };
  nodes.push(rootNode);

  const allKids = rootData.children;
  const rightKids = allKids.filter((_, i) => i % 2 === 0);
  const leftKids  = allKids.filter((_, i) => i % 2 !== 0);

  function layoutSide(kids: TreeNode[], isLeft: boolean) {
    if (!kids.length) return;
    const dir = isLeft ? -1 : 1;
    const bOffset = isLeft ? rightKids.length : 0;
    const fakeRoot: TreeNode = { id: "", topic: "", _slot: 0, children: kids };
    const totalSlots = assignSlotsTree(fakeRoot);
    const yBase = cy - Math.max(0, totalSlots - 1) * V_GAP / 2;

    function place(node: TreeNode, depth: number, parent: LayoutNode, bIdx: number) {
      const bold = depth <= 1;
      const fs = depth <= 1 ? 13 : 12;
      const nh = depth <= 1 ? 36 : 30;
      const label = svgTrunc(node.topic, 30);
      const nw = Math.max(svgEstimateW(label, fs, bold) + (depth <= 1 ? 32 : 24), 72);
      const nd: LayoutNode = {
        id: node.id, topic: label,
        cx: cx + dir * depth * LEVEL_W,
        cy: yBase + node._slot * V_GAP,
        w: nw, h: nh,
        depth, isLeft, isRoot: false,
        style: PALETTE_SVG[bIdx % PALETTE_SVG.length]!,
      };
      nodes.push(nd);
      links.push({ source: parent, target: nd });
      node.children.forEach(child => place(child, depth + 1, nd, bIdx));
    }
    kids.forEach((kid, i) => place(kid, 1, rootNode, bOffset + i));
  }

  layoutSide(rightKids, false);
  layoutSide(leftKids, true);
  return { nodes, links };
}

function renderToSVGString(nodes: LayoutNode[], links: LayoutLink[]): string {
  if (!nodes.length) return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="10" y="40" font-family="sans-serif">Empty mindmap</text></svg>`;

  const pad = 60;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.cx - n.w / 2);
    minY = Math.min(minY, n.cy - n.h / 2);
    maxX = Math.max(maxX, n.cx + n.w / 2);
    maxY = Math.max(maxY, n.cy + n.h / 2);
  }
  const W = Math.ceil(maxX - minX + pad * 2);
  const H = Math.ceil(maxY - minY + pad * 2);
  const dx = -minX + pad;
  const dy = -minY + pad;
  const ff = `system-ui,-apple-system,"Segoe UI",Helvetica,sans-serif`;

  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="#f8f9fb"/>`,
    `<defs><filter id="sh" x="-30%" y="-30%" width="160%" height="160%">`,
    `  <feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.14"/>`,
    `</filter></defs>`,
    `<g id="links">`,
  ];

  for (const lk of links) {
    const { source: s, target: t } = lk;
    const sx = (t.isLeft ? s.cx - s.w / 2 : s.cx + s.w / 2) + dx;
    const sy = s.cy + dy;
    const tx = (t.isLeft ? t.cx + t.w / 2 : t.cx - t.w / 2) + dx;
    const ty = t.cy + dy;
    const mx = (sx + tx) / 2;
    lines.push(`  <path d="M${sx.toFixed(1)},${sy.toFixed(1)} C${mx.toFixed(1)},${sy.toFixed(1)} ${mx.toFixed(1)},${ty.toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)}" fill="none" stroke="${t.style.stroke}" stroke-width="3" stroke-linecap="round" opacity="0.82"/>`);
  }

  lines.push(`</g>`, `<g id="nodes">`);
  for (const nd of nodes) {
    const nx = nd.cx + dx;
    const ny = nd.cy + dy;
    const rx = nd.isRoot ? nd.h / 2 : 8;
    const fs = nd.isRoot ? 15 : nd.depth === 1 ? 13 : 12;
    const fw = nd.isRoot || nd.depth === 1 ? "bold" : "normal";
    lines.push(
      `  <rect x="${(nx - nd.w / 2).toFixed(1)}" y="${(ny - nd.h / 2).toFixed(1)}" width="${nd.w.toFixed(1)}" height="${nd.h}" rx="${rx}" fill="${nd.style.fill}" stroke="${nd.style.stroke}" stroke-width="2.5" filter="url(#sh)"/>`,
      `  <text x="${nx.toFixed(1)}" y="${ny.toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-family="${ff}" font-size="${fs}" font-weight="${fw}" fill="${nd.style.text}">${svgEsc(nd.topic)}</text>`
    );
  }
  lines.push(`</g>`, `</svg>`);
  return lines.join("\n");
}

export async function exportSVG(): Promise<{ filePath: string; nodeCount: number }> {
  const map = await loadMindmap();
  const nodeCount = Object.keys(map.nodes).length;
  const { nodes, links } = buildSvgLayout(map);
  const svg = renderToSVGString(nodes, links);
  const outPath = join(homedir(), ".mindkeeper", "mindmap-export.svg");
  await writeFile(outPath, svg, "utf-8");
  console.error(`[mindkeeper] export_svg -> ${outPath}`);
  return { filePath: outPath, nodeCount };
}

export async function exportPNG(): Promise<{ filePath: string; nodeCount: number }> {
  const map = await loadMindmap();
  const nodeCount = Object.keys(map.nodes).length;
  const { nodes, links } = buildSvgLayout(map);
  const svg = renderToSVGString(nodes, links);

  const { Resvg } = await import("@resvg/resvg-js");
  const renderer = new Resvg(svg, { font: { loadSystemFonts: true } });
  const pngData = renderer.render();
  const pngBuffer = pngData.asPng();

  const outPath = join(homedir(), ".mindkeeper", "mindmap-export.png");
  await writeFile(outPath, pngBuffer);
  console.error(`[mindkeeper] export_png -> ${outPath}`);
  return { filePath: outPath, nodeCount };
}

export async function exportMermaid(): Promise<string> {
  const map = await loadMindmap();

  function sid(id: string): string {
    return "n" + id.replace(/-/g, "_");
  }

  function esc(text: string): string {
    return text.replace(/"/g, "'").replace(/[<>{}[\]]/g, "");
  }

  const nodeDefs: string[] = [];
  const edges: string[] = [];

  for (const node of Object.values(map.nodes)) {
    const label =
      node.tags.length > 0
        ? `${esc(node.text)}\n#lsqb;${node.tags.join(", ")}#rsqb;`
        : esc(node.text);
    nodeDefs.push(`  ${sid(node.id)}["${label}"]`);
    for (const childId of node.children) {
      edges.push(`  ${sid(node.id)} --> ${sid(childId)}`);
    }
  }

  return ["flowchart TD", ...nodeDefs, ...edges].join("\n");
}

export async function exportOPML(): Promise<string> {
  const map = await loadMindmap();

  function escXml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderOutline(id: string, depth: number): string {
    const node = map.nodes[id];
    if (!node) return "";
    const indent = "  ".repeat(depth + 2);
    const tagsAttr =
      node.tags.length > 0
        ? ` _tags="${escXml(node.tags.join(","))}"`
        : "";
    const childLines = node.children
      .map((cid) => renderOutline(cid, depth + 1))
      .filter(Boolean);

    if (childLines.length > 0) {
      return [
        `${indent}<outline text="${escXml(node.text)}"${tagsAttr}>`,
        ...childLines,
        `${indent}</outline>`,
      ].join("\n");
    }
    return `${indent}<outline text="${escXml(node.text)}"${tagsAttr} />`;
  }

  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "  <head>",
    "    <title>Mindkeeper Mindmap</title>",
    `    <dateCreated>${new Date().toUTCString()}</dateCreated>`,
    "  </head>",
    "  <body>",
  ];

  if (map.rootId) parts.push(renderOutline(map.rootId, 0));

  const orphans = Object.values(map.nodes).filter(
    (n) => n.parentId === undefined && n.id !== map.rootId
  );
  for (const orphan of orphans) parts.push(renderOutline(orphan.id, 0));

  parts.push("  </body>", "</opml>");
  return parts.join("\n");
}

// ── Claude.ai export format (undocumented — handle multiple known variants) ──

interface ClaudeExportMessage {
  sender?: string;       // "human" | "assistant" (older) or "user" | "assistant" (newer)
  text?: string;         // flat text field (older format)
  content?: string | Array<{ type: string; text?: string }>; // newer format
  created_at?: string;
}

interface ClaudeExportConversation {
  uuid?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ClaudeExportMessage[];  // older key
  chat_history?: ClaudeExportMessage[];   // newer key
}

function extractMessageText(msg: ClaudeExportMessage): string {
  if (typeof msg.text === "string" && msg.text.trim()) return msg.text.trim();
  if (typeof msg.content === "string" && msg.content.trim()) return msg.content.trim();
  if (Array.isArray(msg.content)) {
    const block = msg.content.find((b) => b.type === "text" && b.text);
    if (block?.text) return block.text.trim();
  }
  return "";
}

function isHuman(msg: ClaudeExportMessage): boolean {
  return msg.sender === "human" || msg.sender === "user";
}

export async function importClaudeExport(filePath: string): Promise<{
  conversationCount: number;
  shown: number;
  conversations: Array<{
    title: string;
    date: string;
    turns: number;
    preview: string;
  }>;
  note: string;
}> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    throw new Error(`Cannot read file: ${filePath}. Check the path is correct and the file exists.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("File is not valid JSON. Make sure you are pointing to conversations.json, not the ZIP.");
  }

  // Normalise: Claude.ai exports either a bare array or { conversations: [...] }
  let rawList: ClaudeExportConversation[];
  if (Array.isArray(parsed)) {
    rawList = parsed as ClaudeExportConversation[];
  } else if (
    parsed !== null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as Record<string, unknown>)["conversations"])
  ) {
    rawList = (parsed as Record<string, unknown>)["conversations"] as ClaudeExportConversation[];
  } else {
    throw new Error(
      "Unrecognised format. Expected a JSON array or { conversations: [...] }. " +
        "Make sure you are using the conversations.json from the Claude.ai data export."
    );
  }

  // Sort newest-updated first
  const sorted = [...rawList].sort((a, b) => {
    const ad = a.updated_at ?? a.created_at ?? "";
    const bd = b.updated_at ?? b.created_at ?? "";
    return bd.localeCompare(ad);
  });

  const conversations = sorted.map((conv) => {
    const messages: ClaudeExportMessage[] = conv.chat_messages ?? conv.chat_history ?? [];
    const humanMsgs = messages.filter(isHuman);
    const firstText = humanMsgs[0] ? extractMessageText(humanMsgs[0]) : "";
    const preview = firstText.slice(0, 160) + (firstText.length > 160 ? "…" : "");

    return {
      title: (conv.name ?? "(untitled)").trim(),
      date: (conv.created_at ?? conv.updated_at ?? "").slice(0, 10),
      turns: messages.length,
      preview,
    };
  });

  const shown = Math.min(conversations.length, 80);
  return {
    conversationCount: rawList.length,
    shown,
    conversations: conversations.slice(0, shown),
    note:
      rawList.length > 80
        ? `Showing ${shown} most recent of ${rawList.length} total. Consider filtering by date or topic before importing all.`
        : `All ${rawList.length} conversations included above.`,
  };
}
