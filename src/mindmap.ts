import { v4 as uuidv4 } from "uuid";
import { readFile, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadMindmap, saveMindmap } from "./storage.js";
import { ENTITY_KINDS } from "./types.js";
import type { EntityKind, HistoryEntry, MindLink, MindNode, Mindmap, NodeState } from "./types.js";

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

// ── History ──────────────────────────────────────────────────────────────────

// Dates are YYYY-MM-DD or a full ISO timestamp
function checkDate(date: string | undefined, what = "effectiveDate"): string | undefined {
  if (date === undefined || date === "") return undefined;
  const d = date.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(d) || Number.isNaN(Date.parse(d))) {
    throw new Error(`Bad ${what}: ${date} (use YYYY-MM-DD or an ISO timestamp)`);
  }
  return d;
}

function nodeState(n: MindNode): NodeState {
  const { children: _c, createdAt: _a, updatedAt: _u, ...rest } = n;
  return structuredClone(rest);
}

function record(
  map: Mindmap,
  entry: Omit<HistoryEntry, "at" | "effectiveDate"> & { effectiveDate: string | undefined }
): void {
  const { effectiveDate, ...rest } = entry;
  const e: HistoryEntry = { at: ts(), ...rest, ...(effectiveDate !== undefined && { effectiveDate }) };
  (map.history ??= []).push(e);
}

// ── Write operations (serialized) ────────────────────────────────────────────

export function addIdea(
  text: string,
  parentId?: string,
  tags?: string[],
  effectiveDate?: string
): Promise<MindNode> {
  return enqueue(async () => {
    const eff = checkDate(effectiveDate);
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
    record(map, {
      op: "add", nodeId: node.id, after: nodeState(node), effectiveDate: eff,
      ...(map.rootId === node.id && { rootBefore: null }),
    });

    await saveMindmap(map);
    console.error(`[mindkeeper] add ${node.id} "${text.slice(0, 60)}"`);
    return node;
  });
}

export function updateNode(
  nodeId: string,
  newText: string,
  newTags?: string[],
  effectiveDate?: string
): Promise<MindNode> {
  return enqueue(async () => {
    const eff = checkDate(effectiveDate);
    const map = await loadMindmap();
    const node = map.nodes[nodeId];
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    const before = nodeState(node);
    node.text = newText;
    if (newTags !== undefined) node.tags = normalizeTags(newTags);
    node.updatedAt = ts();
    record(map, { op: "update", nodeId, before, after: nodeState(node), effectiveDate: eff });

    await saveMindmap(map);
    console.error(`[mindkeeper] update ${nodeId}`);
    return node;
  });
}

export function deleteNode(
  nodeId: string,
  effectiveDate?: string
): Promise<{ deleted: string; orphaned: string[] }> {
  return enqueue(async () => {
    const eff = checkDate(effectiveDate);
    const map = await loadMindmap();
    const node = map.nodes[nodeId];
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    // Links touching the node go first, so rewinding the delete brings them back too
    for (const l of map.links ?? []) {
      if (l.from === nodeId || l.to === nodeId) {
        record(map, { op: "unlink", nodeId: l.from, linkId: l.id, before: structuredClone(l), effectiveDate: eff });
      }
    }
    const before = nodeState(node);
    const rootBefore = map.rootId;

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
    if (map.links) {
      map.links = map.links.filter((l) => l.from !== nodeId && l.to !== nodeId);
      if (map.links.length === 0) delete map.links;
    }
    record(map, {
      op: "delete", nodeId, before, effectiveDate: eff,
      ...(orphaned.length > 0 && { orphaned }),
      ...(rootBefore !== map.rootId && { rootBefore }),
    });

    await saveMindmap(map);
    console.error(
      `[mindkeeper] delete ${nodeId}` +
        (orphaned.length ? `, orphaned [${orphaned.join(", ")}]` : "")
    );
    return { deleted: nodeId, orphaned };
  });
}

function normalizeAttrs(attrs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    const key = k.trim();
    if (key) out[key] = String(v);
  }
  return out;
}

function checkKind(kind: string): EntityKind {
  if (!ENTITY_KINDS.includes(kind as EntityKind)) {
    throw new Error(`Unknown kind: ${kind} (use one of ${ENTITY_KINDS.join(", ")})`);
  }
  return kind as EntityKind;
}

export function addEntity(
  name: string,
  kind: string,
  parentId?: string,
  attrs?: Record<string, unknown>,
  tags?: string[],
  effectiveDate?: string
): Promise<MindNode> {
  return enqueue(async () => {
    const k = checkKind(kind);
    const eff = checkDate(effectiveDate);
    const map = await loadMindmap();

    if (parentId !== undefined && !map.nodes[parentId]) {
      throw new Error(`Parent node not found: ${parentId}`);
    }

    // Same name + kind under the same parent: merge attrs/tags into the existing node
    const nameNorm = name.trim().toLowerCase();
    const existing = Object.values(map.nodes).find(
      (n) =>
        n.text.trim().toLowerCase() === nameNorm &&
        n.parentId === parentId &&
        (n.kind ?? "idea") === k
    );
    if (existing) {
      const before = nodeState(existing);
      if (attrs) existing.attrs = { ...(existing.attrs ?? {}), ...normalizeAttrs(attrs) };
      if (tags) existing.tags = [...new Set([...existing.tags, ...normalizeTags(tags)])];
      existing.kind = k;
      existing.updatedAt = ts();
      record(map, { op: "update", nodeId: existing.id, before, after: nodeState(existing), effectiveDate: eff });
      await saveMindmap(map);
      console.error(`[mindkeeper] merge entity ${existing.id} "${name.slice(0, 60)}"`);
      return existing;
    }

    const cleanAttrs = attrs ? normalizeAttrs(attrs) : {};
    const node: MindNode = {
      id: uuidv4(),
      text: name,
      kind: k,
      ...(Object.keys(cleanAttrs).length > 0 && { attrs: cleanAttrs }),
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
    record(map, {
      op: "add", nodeId: node.id, after: nodeState(node), effectiveDate: eff,
      ...(map.rootId === node.id && { rootBefore: null }),
    });

    await saveMindmap(map);
    console.error(`[mindkeeper] add entity ${k} ${node.id} "${name.slice(0, 60)}"`);
    return node;
  });
}

export function linkEntities(
  from: string,
  to: string,
  type: string,
  label?: string,
  effectiveDate?: string
): Promise<MindLink> {
  return enqueue(async () => {
    const eff = checkDate(effectiveDate);
    const map = await loadMindmap();
    if (!map.nodes[from]) throw new Error(`Node not found: ${from}`);
    if (!map.nodes[to]) throw new Error(`Node not found: ${to}`);
    if (from === to) throw new Error("A node cannot link to itself");
    const t = type.trim().toLowerCase();
    if (!t) throw new Error("Link type is required");

    const links = map.links ?? [];
    const existing = links.find((l) => l.from === from && l.to === to && l.type === t);
    if (existing) {
      if (label !== undefined && label !== existing.label) {
        const before = structuredClone(existing);
        existing.label = label;
        record(map, { op: "link", nodeId: from, linkId: existing.id, before, after: structuredClone(existing), effectiveDate: eff });
        await saveMindmap(map);
      }
      return existing;
    }

    const link: MindLink = {
      id: uuidv4(),
      from,
      to,
      type: t,
      ...(label !== undefined && { label }),
      createdAt: ts(),
    };
    links.push(link);
    map.links = links;
    record(map, { op: "link", nodeId: from, linkId: link.id, after: structuredClone(link), effectiveDate: eff });
    await saveMindmap(map);
    console.error(`[mindkeeper] link ${from} -${t}-> ${to}`);
    return link;
  });
}

// Remove by linkId, or by from+to (+ type when given)
export function unlinkEntities(opts: {
  linkId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  type?: string | undefined;
  effectiveDate?: string | undefined;
}): Promise<{ removed: MindLink[] }> {
  return enqueue(async () => {
    const eff = checkDate(opts.effectiveDate);
    const map = await loadMindmap();
    const links = map.links ?? [];
    const t = opts.type?.trim().toLowerCase();
    let match: (l: MindLink) => boolean;
    if (opts.linkId) {
      match = (l) => l.id === opts.linkId;
    } else if (opts.from && opts.to) {
      match = (l) => l.from === opts.from && l.to === opts.to && (!t || l.type === t);
    } else {
      throw new Error("Pass linkId, or from and to");
    }
    const removed = links.filter(match);
    if (removed.length === 0) throw new Error("No matching link");
    map.links = links.filter((l) => !match(l));
    if (map.links.length === 0) delete map.links;
    for (const l of removed) {
      record(map, { op: "unlink", nodeId: l.from, linkId: l.id, before: structuredClone(l), effectiveDate: eff });
    }
    await saveMindmap(map);
    console.error(`[mindkeeper] unlink ${removed.length}`);
    return { removed };
  });
}

// Re-parent a node (e.g. a person moving to a new manager). newParentId omitted = make it a root-level node.
export function moveNode(nodeId: string, newParentId?: string, effectiveDate?: string): Promise<MindNode> {
  return enqueue(async () => {
    const eff = checkDate(effectiveDate);
    const map = await loadMindmap();
    const node = map.nodes[nodeId];
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    if (newParentId !== undefined) {
      if (!map.nodes[newParentId]) throw new Error(`Parent node not found: ${newParentId}`);
      // Refuse cycles: the new parent may not be the node or one of its descendants
      for (let cur: string | undefined = newParentId; cur !== undefined; cur = map.nodes[cur]?.parentId) {
        if (cur === nodeId) throw new Error("Cannot move a node under itself or its descendants");
      }
    }
    if (node.parentId === newParentId) return node;
    const before = nodeState(node);
    const rootBefore = map.rootId;

    if (node.parentId !== undefined) {
      const old = map.nodes[node.parentId];
      if (old) {
        old.children = old.children.filter((id) => id !== nodeId);
        old.updatedAt = ts();
      }
    }
    if (newParentId !== undefined) {
      const parent = map.nodes[newParentId]!;
      parent.children.push(nodeId);
      parent.updatedAt = ts();
      node.parentId = newParentId;
      if (map.rootId === nodeId) {
        // The old root now hangs off another tree: that tree's top becomes the root
        let top = newParentId;
        while (map.nodes[top]?.parentId !== undefined) top = map.nodes[top]!.parentId!;
        map.rootId = top;
      }
    } else {
      delete node.parentId;
      if (map.rootId === null) map.rootId = nodeId;
    }
    node.updatedAt = ts();
    record(map, {
      op: "move", nodeId, before, after: nodeState(node), effectiveDate: eff,
      ...(rootBefore !== map.rootId && { rootBefore }),
    });

    await saveMindmap(map);
    console.error(`[mindkeeper] move ${nodeId} -> ${newParentId ?? "(root level)"}`);
    return node;
  });
}

// ── History, as-of snapshots and diffs ───────────────────────────────────────

// Date-only cutoffs mean the end of that day (UTC); date-only effective dates the start of it
function dateMs(date: string, endOfDay: boolean): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Date.parse(`${date}T00:00:00.000Z`) + (endOfDay ? 86_400_000 - 1 : 0);
  }
  return Date.parse(date);
}

function entryMs(e: HistoryEntry): number {
  return dateMs(e.effectiveDate ?? e.at, false);
}

function restoreNode(state: NodeState, keep: MindNode | undefined, at: string): MindNode {
  return {
    ...structuredClone(state),
    children: keep?.children ?? [],
    createdAt: keep?.createdAt ?? at,
    updatedAt: keep?.updatedAt ?? at,
  };
}

// The map as it stood on a date: undo, newest first, every change that took effect after it.
// Nodes from before history was kept (no "add" entry) fall back to their createdAt.
export function rewind(map: Mindmap, date: string): Mindmap {
  const d = checkDate(date, "date")!;
  const cutoff = dateMs(d, true);
  const m: Mindmap = structuredClone({ nodes: map.nodes, rootId: map.rootId, links: map.links ?? [] });
  const history = map.history ?? [];
  const added = new Set(history.filter((e) => e.op === "add").map((e) => e.nodeId));
  let links = m.links!;

  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i]!;
    if (entryMs(e) <= cutoff) continue;
    switch (e.op) {
      case "add":
        delete m.nodes[e.nodeId];
        break;
      case "update":
      case "move":
        if (e.before) m.nodes[e.nodeId] = restoreNode(e.before as NodeState, m.nodes[e.nodeId], e.at);
        break;
      case "delete":
        if (e.before) m.nodes[e.nodeId] = restoreNode(e.before as NodeState, undefined, e.at);
        for (const cid of e.orphaned ?? []) {
          const c = m.nodes[cid];
          if (c && c.parentId === undefined) c.parentId = e.nodeId;
        }
        break;
      case "link":
        links = links.filter((l) => l.id !== e.linkId);
        if (e.before) links.push(structuredClone(e.before as MindLink));
        break;
      case "unlink":
        if (e.before && !links.some((l) => l.id === e.linkId)) links.push(structuredClone(e.before as MindLink));
        break;
    }
    if (e.rootBefore !== undefined) m.rootId = e.rootBefore;
  }

  for (const n of Object.values(m.nodes)) {
    if (!added.has(n.id) && Date.parse(n.createdAt) > cutoff) delete m.nodes[n.id];
  }

  // Children are rebuilt from parentId, keeping today's order where it still applies
  for (const n of Object.values(m.nodes)) {
    if (n.parentId !== undefined && !m.nodes[n.parentId]) delete n.parentId;
  }
  for (const n of Object.values(m.nodes)) {
    const kids = n.children.filter((cid) => m.nodes[cid]?.parentId === n.id);
    for (const c of Object.values(m.nodes)) {
      if (c.parentId === n.id && !kids.includes(c.id)) kids.push(c.id);
    }
    n.children = kids;
  }
  if (m.rootId === null || !m.nodes[m.rootId] || m.nodes[m.rootId]!.parentId !== undefined) {
    m.rootId = Object.values(m.nodes).find((n) => n.parentId === undefined)?.id ?? null;
  }

  links = links.filter((l) => m.nodes[l.from] && m.nodes[l.to]);
  if (links.length > 0) m.links = links;
  else delete m.links;
  return m;
}

export async function getHistory(opts: {
  nodeId?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  limit?: number | undefined;
} = {}): Promise<{ total: number; entries: HistoryEntry[] }> {
  const map = await loadMindmap();
  const since = checkDate(opts.since, "since");
  const until = checkDate(opts.until, "until");
  const touches = (e: HistoryEntry): boolean => {
    if (e.nodeId === opts.nodeId) return true;
    const l = (e.after ?? e.before) as MindLink | undefined;
    return e.linkId !== undefined && l !== undefined && (l.from === opts.nodeId || l.to === opts.nodeId);
  };
  const matched = (map.history ?? []).filter(
    (e) =>
      (!opts.nodeId || touches(e)) &&
      (!since || entryMs(e) >= dateMs(since, false)) &&
      (!until || entryMs(e) <= dateMs(until, true))
  );
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 50;
  return { total: matched.length, entries: matched.reverse().slice(0, limit) };
}

export async function snapshotAsOf(date: string): Promise<Mindmap> {
  return rewind(await loadMindmap(), date);
}

interface DiffRef {
  id: string;
  name: string;
  kind?: EntityKind;
}

export interface MindDiff {
  from: string;
  to: string;
  joined: Array<DiffRef & { parent?: DiffRef }>;
  left: Array<DiffRef & { parent?: DiffRef }>;
  moved: Array<DiffRef & { fromParent?: DiffRef; toParent?: DiffRef }>;
  renamed: Array<{ id: string; from: string; to: string }>;
  changed: Array<DiffRef & { fields: string[] }>;
  links: { added: MindLink[]; removed: MindLink[] };
}

export function diffMaps(a: Mindmap, b: Mindmap, from: string, to: string): MindDiff {
  const ref = (m: Mindmap, id: string | undefined): DiffRef | undefined => {
    const n = id === undefined ? undefined : m.nodes[id];
    return n ? { id: n.id, name: n.text, ...(n.kind && { kind: n.kind }) } : undefined;
  };
  const withParent = (m: Mindmap, n: MindNode) => {
    const parent = ref(m, n.parentId);
    return { ...ref(m, n.id)!, ...(parent && { parent }) };
  };
  const out: MindDiff = { from, to, joined: [], left: [], moved: [], renamed: [], changed: [], links: { added: [], removed: [] } };

  for (const n of Object.values(b.nodes)) if (!a.nodes[n.id]) out.joined.push(withParent(b, n));
  for (const n of Object.values(a.nodes)) if (!b.nodes[n.id]) out.left.push(withParent(a, n));
  for (const nb of Object.values(b.nodes)) {
    const na = a.nodes[nb.id];
    if (!na) continue;
    if (na.parentId !== nb.parentId) {
      const fromParent = ref(a, na.parentId);
      const toParent = ref(b, nb.parentId);
      out.moved.push({ ...ref(b, nb.id)!, ...(fromParent && { fromParent }), ...(toParent && { toParent }) });
    }
    if (na.text !== nb.text) out.renamed.push({ id: nb.id, from: na.text, to: nb.text });
    const fields: string[] = [];
    if ((na.kind ?? "") !== (nb.kind ?? "")) fields.push("kind");
    const keys = new Set([...Object.keys(na.attrs ?? {}), ...Object.keys(nb.attrs ?? {})]);
    for (const k of keys) if ((na.attrs ?? {})[k] !== (nb.attrs ?? {})[k]) fields.push(k);
    if (na.tags.join(",") !== nb.tags.join(",")) fields.push("tags");
    if (fields.length > 0) out.changed.push({ ...ref(b, nb.id)!, fields });
  }
  const la = new Set((a.links ?? []).map((l) => l.id));
  const lb = new Set((b.links ?? []).map((l) => l.id));
  out.links.added = (b.links ?? []).filter((l) => !la.has(l.id));
  out.links.removed = (a.links ?? []).filter((l) => !lb.has(l.id));
  return out;
}

// Who joined, left, moved or was renamed between two dates (dateA earlier than dateB)
export async function diffBetween(dateA: string, dateB: string): Promise<MindDiff> {
  const map = await loadMindmap();
  return diffMaps(rewind(map, dateA), rewind(map, dateB), dateA, dateB);
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

export async function exportHTML(): Promise<{ filePath: string; nodeCount: number }> {
  const map = await loadMindmap();
  const nodeCount = Object.keys(map.nodes).length;
  const generatedAt = new Date().toLocaleString();
  const { history: _history, ...shown } = map;
  const inlinedData = JSON.stringify(shown);

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
      if (n.kind) node.kind = n.kind;
      if (n.attrs) node.meta = n.attrs;
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

    if (MAP.links && MAP.links.length) {
      data.links = MAP.links.map(function(l) {
        var link = { from: l.from, to: l.to, type: l.type };
        if (l.label) link.label = l.label;
        return link;
      });
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
