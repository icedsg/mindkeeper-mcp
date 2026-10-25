#!/usr/bin/env bash
# mindkeeper-mcp test suite
set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

section() { echo -e "\n${CYAN}${BOLD}── $* ──${NC}"; }
ok()      { echo -e "  ${GREEN}✓${NC} $*"; }
info()    { echo -e "  ${YELLOW}▸${NC} $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Isolated test environment — never touches real ~/.mindkeeper
TEST_HOME="$(mktemp -d)"
export HOME="$TEST_HOME"
export USERPROFILE="$TEST_HOME"  # os.homedir() reads this on Windows
RUNNER="$SCRIPT_DIR/.test-runner.mjs"
trap 'rm -f "$RUNNER"; rm -rf "$TEST_HOME"' EXIT

echo -e "${BOLD}mindkeeper-mcp test suite${NC}"
info "Isolated store: $TEST_HOME/.mindkeeper/mindmap.json"

# ── Build ─────────────────────────────────────────────────────────────────────
section "Build"
npm run build --silent 2>&1
ok "TypeScript compiled to ./build"

# ── Write the Node.js test runner ─────────────────────────────────────────────
# Runner lives at $SCRIPT_DIR so relative imports resolve correctly on all platforms
cat > "$RUNNER" << 'HEADER'
import { join } from 'path';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import {
  addIdea, updateNode, deleteNode,
  searchNodes, getSubtree, exportMarkdown, exportMermaid, exportOPML, exportJSON,
  addEntity, linkEntities, unlinkEntities, moveNode,
  getHistory, snapshotAsOf, diffBetween, exportHTML,
  projectsOf, membersOf, reportsOf, exportOrgchart, exportCsv, importCsv,
} from './build/mindmap.js';
import { writeFile as writeFileFs, mkdir as mkdirFs } from 'fs/promises';

HEADER

cat >> "$RUNNER" << 'TESTS'
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[1m', N = '\x1b[0m';
let pass = 0, fail = 0;

const ok  = (m)      => { console.log(`  ${G}✓${N} ${m}`); pass++; };
const err = (m, d)   => { console.log(`  ${R}✗${N} ${m}${d ? ': ' + d : ''}`); fail++; };

async function test(name, fn) {
  try { await fn(); }
  catch (e) { err(name, e.message); }
}

function section(title) {
  console.log(`\n\x1b[36m\x1b[1m── ${title} ──\x1b[0m`);
}

// Track IDs across tests
const ids = {};

// ── Add ideas ─────────────────────────────────────────────────────────────────
section('Add ideas');

await test('add root idea (no parent, with tags)', async () => {
  const n = await addIdea('Software Architecture', undefined, ['tech', 'architecture']);
  if (!n.id || n.text !== 'Software Architecture') throw new Error('wrong node returned');
  if (!Array.isArray(n.children) || n.children.length !== 0) throw new Error('children should start empty');
  if (n.parentId !== undefined) throw new Error('root should have no parentId');
  ids.root = n.id;
  ok(`root  id=${n.id.slice(0, 8)}…  tags=[${n.tags.join(', ')}]`);
});

await test('add child idea (parentId attached)', async () => {
  const n = await addIdea('Design Patterns', ids.root, ['patterns']);
  if (n.parentId !== ids.root) throw new Error(`parentId=${n.parentId}, want ${ids.root}`);
  ids.patterns = n.id;
  ok(`child id=${n.id.slice(0, 8)}…  parentId set correctly`);
});

await test('add second child', async () => {
  const n = await addIdea('SOLID Principles', ids.root, ['principles']);
  ids.solid = n.id;
  ok(`child id=${n.id.slice(0, 8)}…`);
});

await test('add grandchild', async () => {
  const n = await addIdea('Dependency Injection', ids.patterns, ['patterns', 'di']);
  if (n.parentId !== ids.patterns) throw new Error('parentId wrong');
  ids.di = n.id;
  ok(`grandchild id=${n.id.slice(0, 8)}…`);
});

await test('add idea with no tags (defaults to [])', async () => {
  const n = await addIdea('Microservices', ids.root);
  if (!Array.isArray(n.tags) || n.tags.length !== 0) throw new Error('tags should default to []');
  ids.micro = n.id;
  ok('tags default to empty array');
});

await test('root node has all children', async () => {
  // verify the parent's children array was updated
  const map = await exportJSON();
  const root = map.nodes[ids.root];
  if (!root) throw new Error('root missing from map');
  const expected = [ids.patterns, ids.solid, ids.micro];
  for (const id of expected) {
    if (!root.children.includes(id)) throw new Error(`root.children missing ${id.slice(0,8)}`);
  }
  ok(`root.children has ${root.children.length} entries`);
});

// ── Search ────────────────────────────────────────────────────────────────────
section('Search');

await test('exact whole-string match scores highest', async () => {
  const r = await searchNodes('Design Patterns');
  if (r.length === 0) throw new Error('no results');
  if (r[0].node.id !== ids.patterns) throw new Error(`top result is ${r[0].node.text}, not Design Patterns`);
  ok(`exact match score=${r[0].score}`);
});

await test('partial / substring match', async () => {
  const r = await searchNodes('inject');
  if (r.length === 0) throw new Error('no results for "inject"');
  if (!r.some(x => x.node.id === ids.di)) throw new Error('DI node not found');
  ok(`"inject" found ${r.length} hit(s)`);
});

await test('tag match contributes to score', async () => {
  const r = await searchNodes('di');
  if (!r.some(x => x.node.tags.includes('di'))) throw new Error('tag scoring missing');
  ok(`tag "di" scored correctly`);
});

await test('no results for nonsense query', async () => {
  const r = await searchNodes('xyzzy_no_match_00000');
  if (r.length !== 0) throw new Error(`expected 0, got ${r.length}`);
  ok('returns empty array for no matches');
});

// ── Update ────────────────────────────────────────────────────────────────────
section('Update');

await test('update text and tags', async () => {
  const n = await updateNode(ids.patterns, 'GoF Design Patterns', ['patterns', 'gof']);
  if (n.text !== 'GoF Design Patterns') throw new Error('text not changed');
  if (!n.tags.includes('gof')) throw new Error('tags not updated');
  ok('text and tags updated');
});

await test('updatedAt advances after update', async () => {
  const before = (await exportJSON()).nodes[ids.patterns];
  if (!before) throw new Error('node missing');
  const created = before.createdAt;
  // sleep 1ms then update
  await new Promise(r => setTimeout(r, 2));
  const n = await updateNode(ids.patterns, 'Design Patterns (GoF)');
  if (n.updatedAt <= created) throw new Error(`updatedAt did not advance: ${n.updatedAt} <= ${created}`);
  ok('updatedAt is newer than createdAt');
});

await test('omitting newTags leaves tags unchanged', async () => {
  const before = (await exportJSON()).nodes[ids.patterns];
  if (!before) throw new Error('node missing');
  const tagsBefore = [...before.tags];
  await updateNode(ids.patterns, 'Design Patterns (GoF) — revised');
  const after = (await exportJSON()).nodes[ids.patterns];
  if (!after) throw new Error('node missing after update');
  if (JSON.stringify(after.tags) !== JSON.stringify(tagsBefore))
    throw new Error(`tags changed: ${JSON.stringify(after.tags)}`);
  ok('tags preserved when newTags omitted');
});

// ── Get subtree ───────────────────────────────────────────────────────────────
section('Get subtree');

await test('getSubtree returns node + all descendants', async () => {
  const nodes = await getSubtree(ids.patterns);
  const nodeIds = nodes.map(n => n.id);
  if (!nodeIds.includes(ids.patterns)) throw new Error('subtree root missing');
  if (!nodeIds.includes(ids.di))       throw new Error('grandchild missing from subtree');
  ok(`subtree has ${nodes.length} node(s) (root + descendants)`);
});

await test('getSubtree of leaf returns single node', async () => {
  const nodes = await getSubtree(ids.di);
  if (nodes.length !== 1) throw new Error(`expected 1, got ${nodes.length}`);
  ok('leaf subtree = 1 node');
});

await test('getSubtree throws for unknown id', async () => {
  try {
    await getSubtree('nonexistent-uuid-xyz');
    err('getSubtree throws for unknown id', 'should have thrown');
  } catch {
    ok('throws on unknown nodeId');
  }
});

// ── Delete ────────────────────────────────────────────────────────────────────
section('Delete');

await test('delete orphans children', async () => {
  const result = await deleteNode(ids.patterns);
  if (result.deleted !== ids.patterns) throw new Error('wrong id in result');
  if (!result.orphaned.includes(ids.di)) throw new Error('child not in orphaned list');
  ok(`deleted ${ids.patterns.slice(0,8)}…, orphaned=[${result.orphaned.map(x=>x.slice(0,8)+'…').join(', ')}]`);
});

await test('deleted node absent from map', async () => {
  const map = await exportJSON();
  if (map.nodes[ids.patterns]) throw new Error('deleted node still in nodes map');
  ok('node removed from map');
});

await test('orphaned child has no parentId', async () => {
  const map = await exportJSON();
  const child = map.nodes[ids.di];
  if (!child) throw new Error('orphaned child missing from map');
  if (child.parentId !== undefined) throw new Error(`parentId still set: ${child.parentId}`);
  ok('orphaned child.parentId is absent');
});

await test('deleted node no longer searchable', async () => {
  const r = await searchNodes('Design Patterns (GoF)');
  if (r.some(x => x.node.id === ids.patterns)) throw new Error('deleted node found in search');
  ok('deleted node absent from search results');
});

await test('delete throws for unknown id', async () => {
  try {
    await deleteNode('nonexistent-uuid-xyz');
    err('delete throws for unknown id', 'should have thrown');
  } catch {
    ok('throws on unknown nodeId');
  }
});

// ── Export markdown ───────────────────────────────────────────────────────────
section('Export markdown');

await test('markdown has h1 heading', async () => {
  const md = await exportMarkdown();
  if (!md.startsWith('# Mindkeeper')) throw new Error(`missing h1: ${md.slice(0,50)}`);
  ok('starts with # Mindkeeper');
});

await test('markdown includes live nodes', async () => {
  const md = await exportMarkdown();
  if (!md.includes('Software Architecture')) throw new Error('root node missing');
  if (!md.includes('SOLID Principles'))      throw new Error('child node missing');
  ok('root and children appear in markdown');
});

await test('markdown has Orphaned section for disconnected nodes', async () => {
  const md = await exportMarkdown();
  if (!md.includes('Orphaned'))            throw new Error('no Orphaned section');
  if (!md.includes('Dependency Injection')) throw new Error('orphaned node missing');
  ok('Orphaned Nodes section present');
});

await test('tags rendered inline', async () => {
  const md = await exportMarkdown();
  if (!md.includes('[tech')) throw new Error('inline tags missing');
  ok('tags appear as `[tag1, tag2]`');
});

// ── Export JSON ───────────────────────────────────────────────────────────────
section('Export JSON');

await test('exportJSON returns correct shape', async () => {
  const map = await exportJSON();
  if (typeof map.nodes !== 'object' || map.nodes === null) throw new Error('nodes not an object');
  if (!('rootId' in map)) throw new Error('rootId field missing');
  ok('top-level shape: { nodes, rootId }');
});

await test('each node has required fields', async () => {
  const map = await exportJSON();
  const required = ['id', 'text', 'children', 'tags', 'createdAt', 'updatedAt'];
  for (const node of Object.values(map.nodes)) {
    for (const f of required) {
      if (!(f in node)) throw new Error(`node ${node.id.slice(0,8)} missing field: ${f}`);
    }
  }
  const count = Object.keys(map.nodes).length;
  ok(`all ${count} nodes have required fields`);
});

// ── Verify mindmap.json on disk ───────────────────────────────────────────────
section('File persistence');

await test('mindmap.json exists and is valid JSON', async () => {
  const path = join(homedir(), '.mindkeeper', 'mindmap.json');
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed.nodes || !('rootId' in parsed)) throw new Error('invalid top-level structure');
  ok(`mindmap.json present and parseable (${raw.length} bytes)`);
});

await test('persisted nodes match in-memory export', async () => {
  const path = join(homedir(), '.mindkeeper', 'mindmap.json');
  const disk = JSON.parse(await readFile(path, 'utf-8'));
  const mem  = await exportJSON();
  if (JSON.stringify(disk) !== JSON.stringify(mem)) throw new Error('disk/memory mismatch');
  ok('disk and in-memory state are identical');
});

await test('rootId on disk points to a real node', async () => {
  const path = join(homedir(), '.mindkeeper', 'mindmap.json');
  const { nodes, rootId } = JSON.parse(await readFile(path, 'utf-8'));
  if (rootId === null) throw new Error('rootId is null');
  if (!nodes[rootId])  throw new Error(`rootId ${rootId} not in nodes`);
  ok(`rootId=${rootId.slice(0,8)}… resolves to "${nodes[rootId].text}"`);
});

// ── Tag normalization ─────────────────────────────────────────────────────────
section('Tag normalization');

await test('# prefix is stripped on addIdea', async () => {
  const n = await addIdea('Tag test node', undefined, ['#roadmap', '#q3']);
  if (n.tags.some(t => t.startsWith('#'))) throw new Error(`# not stripped: ${JSON.stringify(n.tags)}`);
  if (!n.tags.includes('roadmap')) throw new Error(`"roadmap" missing: ${JSON.stringify(n.tags)}`);
  if (!n.tags.includes('q3'))      throw new Error(`"q3" missing: ${JSON.stringify(n.tags)}`);
  ids.tagtest = n.id;
  ok(`["#roadmap","#q3"] → ${JSON.stringify(n.tags)}`);
});

await test('tags are lowercased on addIdea', async () => {
  const n = await addIdea('Case test', undefined, ['#UPPER', 'MixedCase']);
  if (n.tags.some(t => t !== t.toLowerCase()))
    throw new Error(`uppercase not lowercased: ${JSON.stringify(n.tags)}`);
  ok(`uppercased input → ${JSON.stringify(n.tags)}`);
});

await test('# prefix stripped on updateNode', async () => {
  const n = await updateNode(ids.tagtest, 'Tag test node updated', ['#sprint1', '#done']);
  if (n.tags.some(t => t.startsWith('#'))) throw new Error(`# not stripped on update: ${JSON.stringify(n.tags)}`);
  ok(`updateNode strips # → ${JSON.stringify(n.tags)}`);
});

await test('search finds node by normalized tag', async () => {
  const r = await searchNodes('sprint1');
  if (!r.some(x => x.node.id === ids.tagtest)) throw new Error('normalized tag not searchable');
  ok('tag "sprint1" (stored without #) found by search');
});

// ── Export Mermaid ────────────────────────────────────────────────────────────
section('Export Mermaid');

await test('output starts with flowchart TD', async () => {
  const m = await exportMermaid();
  if (!m.startsWith('flowchart TD')) throw new Error(`unexpected start: ${m.slice(0, 40)}`);
  ok('starts with "flowchart TD"');
});

await test('mermaid contains node definitions for all nodes', async () => {
  const m = await exportMermaid();
  const map = await exportJSON();
  const nodeCount = Object.keys(map.nodes).length;
  // Count opening brackets of node label definitions (["  — works regardless of multiline labels
  const defCount = (m.match(/\["/g) || []).length;
  if (defCount !== nodeCount) throw new Error(`${defCount} defs for ${nodeCount} nodes`);
  ok(`${defCount} node definition(s) match map`);
});

await test('mermaid contains --> edges for parent-child pairs', async () => {
  const m = await exportMermaid();
  if (!m.includes('-->')) throw new Error('no edges found');
  ok('edges present');
});

await test('mermaid node ids are alphanumeric (no raw UUIDs)', async () => {
  const m = await exportMermaid();
  // raw UUID format (with hyphens) should not appear as node IDs
  const rawUuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}/;
  if (rawUuidPattern.test(m)) throw new Error('raw UUID found in output');
  ok('no raw UUIDs — hyphens replaced');
});

// ── Export OPML ───────────────────────────────────────────────────────────────
section('Export OPML');

await test('output is valid XML declaration', async () => {
  const o = await exportOPML();
  if (!o.startsWith('<?xml')) throw new Error(`unexpected start: ${o.slice(0, 40)}`);
  ok('starts with <?xml');
});

await test('opml wraps content in <opml> and <body>', async () => {
  const o = await exportOPML();
  if (!o.includes('<opml')) throw new Error('missing <opml>');
  if (!o.includes('<body>') && !o.includes('<body\n')) throw new Error('missing <body>');
  ok('<opml> and <body> present');
});

await test('opml contains outline elements for nodes', async () => {
  const o = await exportOPML();
  if (!o.includes('<outline')) throw new Error('no <outline> elements');
  ok('<outline> elements present');
});

await test('opml escapes XML special characters in text', async () => {
  const n = await addIdea('Test <node> & "quotes"', undefined, ['xml']);
  const o = await exportOPML();
  if (o.includes('<node>') && !o.includes('&lt;node&gt;'))
    throw new Error('< not escaped in OPML');
  if (o.includes(' & ') && !o.includes('&amp;'))
    throw new Error('& not escaped in OPML');
  await deleteNode(n.id);
  ok('< > & " are XML-escaped');
});

await test('opml tags appear as _tags attribute', async () => {
  // ids.tagtest was updated to have sprint1,done tags
  const o = await exportOPML();
  if (!o.includes('_tags=')) throw new Error('_tags attribute missing');
  ok('_tags attribute present');
});

// ── Entities + relations ──────────────────────────────────────────────────────
section('Entities + relations');

await test('add_entity: company + people with kind and attrs', async () => {
  const c = await addEntity('Acme Ltd', 'company', undefined, { url: 'https://acme.test' });
  if (c.kind !== 'company' || c.attrs?.url !== 'https://acme.test') throw new Error('kind/attrs not stored');
  const ceo = await addEntity('Asha Rao', 'person', c.id, { title: 'CEO' });
  const cto = await addEntity('Ben Lee', 'person', ceo.id, { title: 'CTO', start: '2026-01-15' });
  const dev = await addEntity('Cara Diaz', 'person', cto.id, { title: 'Engineer' });
  const pm  = await addEntity('Dev Shah', 'person', ceo.id, { title: 'PM' });
  const proj = await addEntity('Project Atlas', 'project', c.id);
  Object.assign(ids, { co: c.id, ceo: ceo.id, cto: cto.id, dev: dev.id, pm: pm.id, proj: proj.id });
  if (cto.parentId !== ceo.id) throw new Error('reporting line not set');
  ok('company, 4 people, 1 project; kind + attrs stored');
});

await test('add_entity: unknown kind is refused', async () => {
  try { await addEntity('X', 'planet'); } catch (e) {
    if (!/Unknown kind/.test(e.message)) throw e;
    ok('kind validated'); return;
  }
  throw new Error('accepted bad kind');
});

await test('add_entity: same name+kind+parent merges attrs', async () => {
  const again = await addEntity('Ben Lee', 'person', ids.ceo, { email: 'ben@acme.test' });
  if (again.id !== ids.cto) throw new Error('duplicate created');
  if (again.attrs.title !== 'CTO' || again.attrs.email !== 'ben@acme.test') throw new Error('attrs not merged');
  ok('merged into existing node');
});

await test('link_entities: stores typed links, dedups same pair+type', async () => {
  const l1 = await linkEntities(ids.dev, ids.proj, 'Works_On');
  const l2 = await linkEntities(ids.dev, ids.proj, 'works_on', 'builds');
  const l3 = await linkEntities(ids.pm, ids.proj, 'leads');
  if (l1.id !== l2.id || l2.label !== 'builds') throw new Error('dedup/label update failed');
  if (l1.type !== 'works_on') throw new Error('type not lowercased');
  const map = await exportJSON();
  if (map.links.length !== 2) throw new Error(`links=${map.links.length}, want 2`);
  ids.leadLink = l3.id;
  ok('2 links stored, type lowercased, duplicate merged');
});

await test('link_entities: missing node / self link refused', async () => {
  let n = 0;
  try { await linkEntities(ids.dev, 'nope', 'x'); } catch { n++; }
  try { await linkEntities(ids.dev, ids.dev, 'x'); } catch { n++; }
  if (n !== 2) throw new Error('bad links accepted');
  ok('refused');
});

await test('unlink_entities: by id and by from/to', async () => {
  await unlinkEntities({ linkId: ids.leadLink });
  const r = await unlinkEntities({ from: ids.dev, to: ids.proj, type: 'works_on' });
  if (r.removed.length !== 1) throw new Error('from/to remove failed');
  const map = await exportJSON();
  if (map.links !== undefined) throw new Error('empty links should be dropped from the file');
  ok('both removed; links key dropped when empty');
});

await test('move_node: re-parents and keeps subtree', async () => {
  const moved = await moveNode(ids.cto, ids.pm);
  const map = await exportJSON();
  if (moved.parentId !== ids.pm) throw new Error('parentId not updated');
  if (map.nodes[ids.ceo].children.includes(ids.cto)) throw new Error('still in old parent');
  if (!map.nodes[ids.pm].children.includes(ids.cto)) throw new Error('not in new parent');
  if (map.nodes[ids.dev].parentId !== ids.cto) throw new Error('subtree broken');
  ok('CTO now under PM, engineer still under CTO');
});

await test('move_node: refuses cycles', async () => {
  try { await moveNode(ids.ceo, ids.dev); } catch (e) {
    if (!/descendants/.test(e.message)) throw e;
    ok('cycle refused'); return;
  }
  throw new Error('cycle accepted');
});

await test('move_node: to root level and back', async () => {
  await moveNode(ids.dev);
  let map = await exportJSON();
  if (map.nodes[ids.dev].parentId !== undefined) throw new Error('still has parent');
  if (map.nodes[ids.cto].children.includes(ids.dev)) throw new Error('still a child');
  await moveNode(ids.dev, ids.cto);
  map = await exportJSON();
  if (map.nodes[ids.dev].parentId !== ids.cto) throw new Error('not moved back');
  ok('detached and re-attached');
});

await test('delete_node drops links touching the node', async () => {
  const tmp = await addEntity('Temp Contractor', 'person', ids.co);
  await linkEntities(tmp.id, ids.proj, 'works_on');
  await linkEntities(ids.dev, ids.proj, 'works_on');
  await deleteNode(tmp.id);
  const map = await exportJSON();
  if (map.links.some((l) => l.from === tmp.id || l.to === tmp.id)) throw new Error('dangling link');
  if (map.links.length !== 1) throw new Error(`links=${map.links.length}, want 1`);
  ok('dangling link removed, other kept');
});

await test('old mindmap.json (no kind/attrs/links) loads and works unchanged', async () => {
  const dir = join(homedir(), '.mindkeeper');
  await mkdirFs(dir, { recursive: true });
  const legacy = {
    nodes: {
      a: { id: 'a', text: 'Old root', children: ['b'], createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', tags: ['x'] },
      b: { id: 'b', text: 'Old child', parentId: 'a', children: [], createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', tags: [] },
    },
    rootId: 'a',
  };
  const saved = JSON.parse(await readFile(join(dir, 'mindmap.json'), 'utf-8'));
  await writeFileFs(join(dir, 'mindmap.json'), JSON.stringify(legacy), 'utf-8');
  const md = await exportMarkdown();
  if (!md.includes('- Old root') || !md.includes('  - Old child')) throw new Error('legacy export broken');
  await updateNode('b', 'Old child renamed');
  const after = await exportJSON();
  if ('links' in after || 'kind' in after.nodes.b || 'attrs' in after.nodes.b) throw new Error('legacy file gained new keys');
  await writeFileFs(join(dir, 'mindmap.json'), JSON.stringify(saved), 'utf-8');
  ok('legacy file reads, edits, and keeps its shape');
});

// ── History, as-of, diff ──────────────────────────────────────────────────────
section('History + as-of + diff');

const org = {};
const kidsOf = (m, id) => m.nodes[id].children.map((c) => m.nodes[c].text);

await test('fresh store: build a small org with effective dates', async () => {
  const dir = join(homedir(), '.mindkeeper');
  await writeFileFs(join(dir, 'mindmap.json'), JSON.stringify({ nodes: {}, rootId: null }), 'utf-8');
  org.acme = (await addEntity('Acme', 'company', undefined, undefined, undefined, '2026-01-01')).id;
  org.ana  = (await addEntity('Ana', 'person', org.acme, { title: 'CEO' }, undefined, '2026-01-01')).id;
  org.ben  = (await addEntity('Ben', 'person', org.ana, { title: 'Engineer' }, undefined, '2026-01-10')).id;
  org.cara = (await addEntity('Cara', 'person', org.ana, undefined, undefined, '2026-01-10')).id;
  org.proj = (await addEntity('Apollo', 'project', org.acme, undefined, undefined, '2026-01-01')).id;
  await linkEntities(org.ben, org.proj, 'works_on', undefined, '2026-02-01');
  org.dee  = (await addEntity('Dee', 'person', org.ben, undefined, undefined, '2026-03-01')).id;
  await moveNode(org.cara, org.ben, '2026-04-01');
  await updateNode(org.ben, 'Ben Ortiz', undefined, '2026-05-01');
  await addEntity('Ben Ortiz', 'person', org.ana, { title: 'Lead' }, undefined, '2026-05-15');
  await deleteNode(org.dee, '2026-06-01');
  await unlinkEntities({ from: org.ben, to: org.proj, effectiveDate: '2026-06-15' });
  const map = await exportJSON();
  if (map.history.length !== 12) throw new Error(`history has ${map.history.length} entries, want 12`);
  ok('12 changes recorded');
});

await test('history entries carry at, op, nodeId, before/after, effectiveDate', async () => {
  const map = await exportJSON();
  const mv = map.history.find((e) => e.op === 'move');
  if (!mv.at || mv.nodeId !== org.cara || mv.effectiveDate !== '2026-04-01') throw new Error('move entry wrong');
  if (mv.before.parentId !== org.ana || mv.after.parentId !== org.ben) throw new Error('move before/after wrong');
  if ('children' in mv.before) throw new Error('children should not be stored');
  const add = map.history[0];
  if (add.op !== 'add' || add.before !== undefined || add.after.text !== 'Acme') throw new Error('add entry wrong');
  ok('entry shape correct');
});

await test('get_history: newest first, filter by node (incl. its links) and dates', async () => {
  const all = await getHistory();
  if (all.entries[0].op !== 'unlink') throw new Error(`newest is ${all.entries[0].op}`);
  const ben = await getHistory({ nodeId: org.proj });
  const ops = ben.entries.map((e) => e.op).join(',');
  if (ops !== 'unlink,link,add') throw new Error(`Apollo history: ${ops}`);
  const q2 = await getHistory({ since: '2026-04-01', until: '2026-05-31' });
  if (q2.total !== 3) throw new Error(`Apr-May has ${q2.total}, want 3`);
  const lim = await getHistory({ limit: 2 });
  if (lim.entries.length !== 2 || lim.total !== 12) throw new Error('limit wrong');
  ok('ordering, nodeId, since/until and limit work');
});

await test('snapshot before anything happened is empty', async () => {
  const m = await snapshotAsOf('2025-12-31');
  if (Object.keys(m.nodes).length !== 0 || m.rootId !== null || m.links) throw new Error('not empty');
  ok('2025-12-31: empty');
});

await test('snapshot 2026-02-15: original tree with the link', async () => {
  const m = await snapshotAsOf('2026-02-15');
  if (Object.keys(m.nodes).length !== 5) throw new Error(`${Object.keys(m.nodes).length} nodes`);
  if (m.rootId !== org.acme) throw new Error('root wrong');
  if (kidsOf(m, org.ana).join(',') !== 'Ben,Cara') throw new Error(`Ana's reports: ${kidsOf(m, org.ana)}`);
  if (m.nodes[org.ben].attrs.title !== 'Engineer') throw new Error('old title not restored');
  if (!m.links || m.links.length !== 1) throw new Error('link missing');
  ok('names, titles, reports and the link as they were');
});

await test('snapshot on the effective day includes that change', async () => {
  const m = await snapshotAsOf('2026-03-01');
  if (!m.nodes[org.dee] || m.nodes[org.dee].parentId !== org.ben) throw new Error('Dee missing on her start date');
  if (kidsOf(m, org.ben).join(',') !== 'Dee') throw new Error(`Ben's reports: ${kidsOf(m, org.ben)}`);
  ok('2026-03-01: Dee under Ben');
});

await test('snapshot after a delete restores nothing; before it restores node + links', async () => {
  const late = await snapshotAsOf('2026-07-01');
  const now = await exportJSON();
  if (Object.keys(late.nodes).sort().join() !== Object.keys(now.nodes).sort().join()) throw new Error('late snapshot != now');
  if (late.links) throw new Error('link should be gone');
  const may = await snapshotAsOf('2026-05-20');
  if (!may.nodes[org.dee] || kidsOf(may, org.ben).join(',') !== 'Cara,Dee') throw new Error(`May: ${kidsOf(may, org.ben)}`);
  if (may.nodes[org.ben].text !== 'Ben Ortiz' || may.nodes[org.ben].attrs.title !== 'Lead') throw new Error('May Ben wrong');
  ok('July = today; May has Dee back and Cara under Ben');
});

await test('diff_between: moved, renamed, changed, links removed', async () => {
  const d = await diffBetween('2026-02-15', '2026-07-01');
  if (d.joined.length || d.left.length) throw new Error('Dee came and went inside the window');
  if (d.moved.length !== 1 || d.moved[0].name !== 'Cara' || d.moved[0].fromParent.name !== 'Ana' || d.moved[0].toParent.name !== 'Ben Ortiz')
    throw new Error(`moved ${JSON.stringify(d.moved)}`);
  if (d.renamed.length !== 1 || d.renamed[0].from !== 'Ben' || d.renamed[0].to !== 'Ben Ortiz') throw new Error('renamed wrong');
  if (d.changed.length !== 1 || d.changed[0].fields.join() !== 'title') throw new Error(`changed ${JSON.stringify(d.changed)}`);
  if (d.links.removed.length !== 1 || d.links.added.length !== 0) throw new Error('links wrong');
  ok('Cara Ana -> Ben Ortiz, Ben renamed, title changed, 1 link removed');
});

await test('diff_between: joined and left', async () => {
  const j = await diffBetween('2026-02-15', '2026-03-15');
  if (j.joined.length !== 1 || j.joined[0].name !== 'Dee' || j.joined[0].parent.name !== 'Ben') throw new Error('joined wrong');
  const l = await diffBetween('2026-03-15', '2026-06-30');
  if (l.left.length !== 1 || l.left[0].name !== 'Dee') throw new Error('left wrong');
  ok('Dee joined under Ben in March, left in June');
});

await test('changes without effectiveDate count from when they were recorded', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const n = await addEntity('Eve', 'person', org.ana);
  const m = await snapshotAsOf(today);
  if (!m.nodes[n.id]) throw new Error('Eve missing from today');
  const d = await diffBetween('2026-07-01', today);
  if (!d.joined.some((x) => x.name === 'Eve')) throw new Error('Eve not joined');
  ok('undated change shows up from today');
});

await test('bad dates are refused', async () => {
  for (const fn of [() => snapshotAsOf('last tuesday'), () => moveNode(org.cara, org.ana, '15/01/2026'), () => diffBetween('2026-13-45', '2026-01-01')]) {
    let threw = false;
    try { await fn(); } catch { threw = true; }
    if (!threw) throw new Error('bad date accepted');
  }
  const m = await exportJSON();
  if (m.nodes[org.cara].parentId !== org.ben) throw new Error('refused move still changed the map');
  ok('non-ISO dates throw, map untouched');
});

await test('legacy nodes (no history) fall back to createdAt', async () => {
  const dir = join(homedir(), '.mindkeeper');
  const legacy = {
    nodes: {
      a: { id: 'a', text: 'Old root', children: ['b'], createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', tags: [] },
      b: { id: 'b', text: 'Later child', parentId: 'a', children: [], createdAt: '2025-06-01T00:00:00.000Z', updatedAt: '2025-06-01T00:00:00.000Z', tags: [] },
    },
    rootId: 'a',
  };
  await writeFileFs(join(dir, 'mindmap.json'), JSON.stringify(legacy), 'utf-8');
  const m = await snapshotAsOf('2025-03-01');
  if (!m.nodes.a || m.nodes.b || m.nodes.a.children.length !== 0) throw new Error('createdAt fallback wrong');
  const h = await getHistory();
  if (h.total !== 0) throw new Error('legacy file should have no history');
  ok('Mar 2025: root only, empty history');
});

await test('export_html leaves history out of the page', async () => {
  await addIdea('Note', 'a');
  const { filePath } = await exportHTML();
  const html = await readFile(filePath, 'utf-8');
  if (html.includes('"history"')) throw new Error('history inlined in HTML');
  ok('no history in the HTML export');
});

// ── Org queries + org exports + CSV ──────────────────────────────────────────
section('Org queries + exports + CSV');

const oq = {};
await test('import_csv builds a tree (manager by id or name, extra columns as attrs)', async () => {
  await writeFileFs(join(homedir(), '.mindkeeper', 'mindmap.json'), JSON.stringify({ nodes: {}, rootId: null }), 'utf-8');
  const co = await addEntity('Acme', 'company');
  oq.co = co.id;
  const csv = [
    'id,name,title,manager,kind,email',
    'e1,Ana Ruiz,CEO,,,ana@acme.test',
    'e2,"Ben, Jr.",CTO,e1,person,',
    't1,Platform,,Ben; Jr.,team,',
    'e3,Cara,Engineer,t1,,',
    'e4,Dev,"Engineer ""II""",Ana Ruiz,,',
    'e5,Eve,Intern,nobody,,',
  ].join('\r\n').replace('Ben; Jr.', 'e2');
  const r = await importCsv(csv, co.id, '2026-01-15');
  if (r.added !== 6) throw new Error(`added=${r.added}`);
  if (r.warnings.length !== 1 || !r.warnings[0].includes('nobody')) throw new Error(`warnings=${JSON.stringify(r.warnings)}`);
  Object.assign(oq, r.ids);
  const m = await exportJSON();
  if (m.nodes[oq.e1].parentId !== co.id) throw new Error('CEO not under the company');
  if (m.nodes[oq.e2].text !== 'Ben, Jr.' || m.nodes[oq.e2].parentId !== oq.e1) throw new Error('quoted name / manager by id');
  if (m.nodes[oq.e4].parentId !== oq.e1) throw new Error('manager by name');
  if (m.nodes[oq.e4].attrs.title !== 'Engineer "II"') throw new Error('escaped quotes');
  if (m.nodes[oq.e1].attrs.email !== 'ana@acme.test') throw new Error('extra column not an attr');
  if (m.nodes[oq.t1].kind !== 'team' || m.nodes[oq.e3].kind !== 'person') throw new Error('kinds');
  if (m.nodes[oq.e5].parentId !== co.id) throw new Error('unknown manager should fall back to parent');
  if (m.history.filter((h) => h.op === 'add' && h.effectiveDate === '2026-01-15').length !== 6) throw new Error('history');
  ok('6 rows, quoted cells, name/id managers, 1 warning, dated history');
});

await test('import_csv refuses bad input before touching the map', async () => {
  const before = JSON.stringify(await exportJSON());
  for (const bad of ['title\nCEO', 'name,kind\nX,planet']) {
    let threw = false;
    try { await importCsv(bad); } catch { threw = true; }
    if (!threw) throw new Error(`accepted: ${bad}`);
  }
  if (JSON.stringify(await exportJSON()) !== before) throw new Error('map changed');
  ok('no name column / unknown kind throw');
});

await test('import_csv manager loop falls back with a warning', async () => {
  const r = await importCsv('id,name,manager\nx,X,y\ny,Y,x\n', oq.co);
  if (r.added !== 2 || !r.warnings.some((w) => w.includes('loop'))) throw new Error(JSON.stringify(r));
  const m = await exportJSON();
  const px = m.nodes[r.ids.x].parentId, py = m.nodes[r.ids.y].parentId;
  if (!((px === r.ids.y && py === oq.co) || (py === r.ids.x && px === oq.co))) throw new Error('loop not broken');
  await deleteNode(r.ids.x); await deleteNode(r.ids.y);
  ok('one of the pair goes under the import parent');
});

await test('reports_of: direct (through team), all, manager', async () => {
  const d = await reportsOf(oq.e2);
  if (d.reports.map((r) => r.name).join() !== 'Cara') throw new Error(`direct=${d.reports.map((r) => r.name)}`);
  if (d.manager?.id !== oq.e1) throw new Error('manager');
  const a = await reportsOf(oq.e1, true);
  const names = a.reports.map((r) => `${r.name}@${r.depth}`).sort().join();
  if (names !== 'Ben, Jr.@1,Cara@2,Dev@1') throw new Error(names);
  if ((await reportsOf(oq.e3)).manager?.id !== oq.e2) throw new Error('manager through team');
  if ((await reportsOf(oq.e1)).manager !== null) throw new Error('CEO has no manager');
  ok('Ben -> Cara via team; Ana all = 3; Cara manager = Ben');
});

await test('projects_of / members_of with links and tree', async () => {
  const p1 = await addEntity('Apollo', 'project', oq.co);
  const p2 = await addEntity('Hermes', 'project', oq.t1);
  oq.p1 = p1.id; oq.p2 = p2.id;
  await linkEntities(oq.e3, p1.id, 'works_on');
  await linkEntities(p1.id, oq.e4, 'led_by');
  const cara = await projectsOf(oq.e3);
  if (cara.projects.length !== 1 || cara.projects[0].via !== 'link:works_on') throw new Error(JSON.stringify(cara));
  const team = await projectsOf(oq.t1);
  if (team.projects.map((p) => p.name).join() !== 'Hermes') throw new Error('team tree project');
  const ben = await projectsOf(oq.e2, true);
  if (ben.projects.map((p) => p.name).sort().join() !== 'Apollo,Hermes') throw new Error(`ben=${ben.projects.map((p) => p.name)}`);
  if ((await projectsOf(oq.e2)).projects.map((p) => p.name).join() !== 'Hermes') throw new Error('without includeReports: tree only');
  const mem = await membersOf(p1.id);
  if (mem.members.map((m) => m.name).sort().join() !== 'Cara,Dev') throw new Error('project members');
  const co = await membersOf(oq.co);
  if (co.members.length !== 5 || co.members.some((m) => m.via !== 'tree')) throw new Error(`company=${co.members.length}`);
  ok('link + tree projects, includeReports, members both ways');
});

await test('export_orgchart: Mermaid TB + map JSON with links', async () => {
  const r = await exportOrgchart();
  if (!r.mermaid.startsWith('flowchart TB')) throw new Error('not TB');
  if (!r.mermaid.includes('<br/><small>CTO</small>')) throw new Error('no title line');
  if (!r.mermaid.includes('-.->|works_on|')) throw new Error('no link arrow');
  if (!r.mermaid.includes('classDef person') || !r.mermaid.includes('#quot;II#quot;')) throw new Error('classes/escaping');
  if (r.data.id !== oq.co || r.data.kind !== 'company') throw new Error('root');
  if (r.data.links.length !== 2) throw new Error(`links=${r.data.links.length}`);
  const sub = await exportOrgchart(oq.t1);
  if (sub.nodeCount !== 3 || sub.data.links) throw new Error('subtree should drop links leaving it');
  if (sub.data.children.find((c) => c.id === oq.e3).meta.title !== 'Engineer') throw new Error('meta');
  ok(`${r.nodeCount} nodes, 2 links; subtree 3 nodes, no dangling links`);
});

await test('export_csv -> edit -> import_csv round-trips as moves/updates', async () => {
  const { csv, rows } = await exportCsv();
  if (rows !== 9) throw new Error(`rows=${rows}`);
  const lines = csv.trim().split('\n');
  if (lines[0] !== 'id,name,title,manager,kind,email') throw new Error(lines[0]);
  if (!csv.includes('"Ben, Jr."') || !csv.includes('"Engineer ""II"""')) throw new Error('quoting');
  // Dev moves under Ben, Cara gets a new title
  const edited = csv
    .replace(`${oq.e4},Dev,"Engineer ""II""",${oq.e1}`, `${oq.e4},Dev,"Engineer ""II""",${oq.e2}`)
    .replace(`${oq.e3},Cara,Engineer,`, `${oq.e3},Cara,Senior Engineer,`);
  const r = await importCsv(edited, undefined, '2026-07-01');
  if (r.added !== 0 || r.moved !== 1 || r.updated !== 1) throw new Error(JSON.stringify(r));
  const d = await diffBetween('2026-06-30', '2026-07-01');
  if (d.moved.length !== 1 || d.moved[0].id !== oq.e4) throw new Error('diff moved');
  ok('9 rows; re-import = 1 move + 1 update, visible in diff_between');
});

// ── Summary ───────────────────────────────────────────────────────────────────
const total = pass + fail;
console.log('');
console.log(`  ${total} tests  ${G}${pass} passed${N}  ${fail > 0 ? R : ''}${fail} failed${N}`);
process.exitCode = fail > 0 ? 1 : 0;
TESTS

# ── Run the test runner ───────────────────────────────────────────────────────
section "Tests"
STDERR_LOG="$TEST_HOME/node-stderr.log"
set +e
node "$RUNNER" 2>"$STDERR_LOG"
STATUS=$?
set -e

# Show node's stderr only when the runner crashes (not normal [mindkeeper] logs)
if [ "$STATUS" -ne 0 ] && [ -s "$STDERR_LOG" ]; then
  echo -e "\n${RED}Node.js stderr:${NC}"
  grep -v '^\[mindkeeper\]' "$STDERR_LOG" || true
fi

echo ""
if [ "$STATUS" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All tests passed.${NC}"
else
  echo -e "${RED}${BOLD}Some tests failed.${NC}"
  exit 1
fi
