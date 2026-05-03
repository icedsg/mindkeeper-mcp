# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
