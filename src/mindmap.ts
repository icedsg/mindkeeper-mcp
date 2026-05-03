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

    const node: MindNode = {
      id: uuidv4(),
      text,
      children: [],
      createdAt: ts(),
      updatedAt: ts(),
      tags: tags ?? [],
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
    if (newTags !== undefined) node.tags = newTags;
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
