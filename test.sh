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
