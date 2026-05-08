import { v4 as uuidv4 } from "uuid";
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
