# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0] - 2026-10-25

### Added
- Typed entities: nodes take an optional `kind` (person, company, team, role, project, idea) and string `attrs` (title, email, url, avatar, start, end, status, ...); `add_entity` tool (same name + kind + parent merges attributes)
- Relations: map-level `links[]`; `link_entities` / `unlink_entities` tools; `move_node` re-parents a subtree and refuses cycles; `delete_node` drops links touching the node
- Change history: every write appends to `history[]` with before/after state; every write tool takes an optional `effectiveDate`; `get_history`, `snapshot_as_of` and `diff_between` (joined, left, moved, renamed, changed, links added/removed)
- Org queries: `projects_of`, `members_of`, `reports_of` (team and role nodes looked through)
- Org exports: `export_orgchart` (Mermaid flowchart TB + mindkeeper-map JSON with links), `export_csv`, `import_csv` (manager by row id, name or node id; updates land in history)
- `examples/`: 40-person sample company as CSV and as a mindmap.json with dated history, plus an org chart walkthrough in the README

### Changed
- `export_html` inlines mindkeeper-map.js 1.2, so kinds, titles and links render in the exported page
- The server reports its version from package.json (was a fixed 1.0.0)

### Unchanged
- Existing mindmap.json files load as before; the new fields are optional (a legacy file gains a `history` key on its first edit)

## [1.5.2] - 2026-05-10

### Changed
- Demo uses mindkeeper-map.js instead of a D3.js force-directed graph

## [1.5.0] - 2026-05-10

### Removed
- `get_last_session`, `export_svg` and `export_png` tools

## [1.3.0] - 2026-05-10

### Added
- `export_html` and `import_claude_export`

## [1.0.0] - 2026-05-03

### Added
- `add_idea` tool — capture ideas hierarchically with optional parent attachment and tags
- `update_node` tool — refine text and tags of an existing idea
- `delete_node` tool — remove a node; children are orphaned (kept, not deleted)
- `search_ideas` tool — weighted full-text search (exact > substring > token) across text and tags
- `get_mindmap` tool — retrieve the full tree or any subtree by node ID
- `export_markdown` tool — export the mindmap as a nested Markdown list
- Persistent JSON storage at `~/.mindkeeper/mindmap.json`
- Atomic write strategy: temp file → backup (`.bak`) → rename
- Serialised write queue to prevent concurrent-access file corruption
- TypeScript strict-mode codebase (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
- ESM output targeting Node 18+
- `bin` entry for global install via `npm install -g`
