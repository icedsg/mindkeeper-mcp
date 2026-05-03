# mindkeeper-mcp

An MCP server that captures ideas from conversations and organises them into a persistent mindmap. Each idea is stored as a node that can be linked to a parent, tagged, searched, and exported — surviving across sessions.

Data is stored in `~/.mindkeeper/mindmap.json` with atomic writes and automatic backups.

## Features

- **Persistent** — mindmap survives across conversations and restarts
- **Hierarchical** — nest ideas under parents to build tree structure
- **Searchable** — weighted full-text search across text and tags
- **Safe writes** — atomic temp-file → backup → rename strategy
- **Concurrency-safe** — serialised write queue prevents file corruption
- **Export** — Markdown nested list or raw JSON

## Installation

### Global install (recommended)

```bash
npm install -g mindkeeper-mcp
```

### Local install

```bash
git clone https://github.com/your-username/mindkeeper-mcp
cd mindkeeper-mcp
npm install
npm run build
```

## Configuration

### Claude Desktop

Edit `claude_desktop_config.json`:

| Platform | Location |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/claude/claude_desktop_config.json` |

**Global install:**

```json
{
  "mcpServers": {
    "mindkeeper": {
      "command": "mindkeeper-mcp"
    }
  }
}
```

**Local install (absolute path):**

```json
{
  "mcpServers": {
    "mindkeeper": {
      "command": "node",
      "args": ["/absolute/path/to/mindkeeper-mcp/build/index.js"]
    }
  }
}
```

### Claude Code (CLI)

```bash
# Global install
claude mcp add mindkeeper -- mindkeeper-mcp

# Local install
claude mcp add mindkeeper -- node /path/to/mindkeeper-mcp/build/index.js
```

## Tools

| Tool | Description |
|---|---|
| `add_idea` | Capture a new idea, optionally attached to a parent node |
| `update_node` | Edit the text or tags of an existing idea |
| `delete_node` | Remove an idea; children are orphaned (kept, not deleted) |
| `search_ideas` | Full-text search across idea text and tags |
| `get_mindmap` | Retrieve the full tree, or a subtree from a given node |
| `export_markdown` | Export the mindmap as a nested Markdown list |

## Usage examples

**Capture a top-level idea:**
```
add_idea  text="Product strategy for Q3"  tags=["strategy","q3"]
```

**Add a sub-idea under an existing node:**
```
add_idea  text="Launch in EU market"  parentId="<id from previous call>"  tags=["launch"]
```

**Refine an idea:**
```
update_node  nodeId="<id>"  newText="Launch in EU market — target Germany first"
```

**Find related ideas:**
```
search_ideas  query="EU launch"
```

**See the whole map:**
```
get_mindmap
```

**Export for a document:**
```
export_markdown
```

## Data storage

The mindmap is stored in `~/.mindkeeper/mindmap.json`. A backup is kept at `~/.mindkeeper/mindmap.json.bak` and is overwritten on every save.

To reset: delete or rename `mindmap.json`. The server creates a fresh empty map on next use.

## Development

```bash
npm run dev    # tsx watch mode — restarts on file change
npm run build  # compile TypeScript to ./build
npm test       # run test suite (requires bash)
```

## Troubleshooting

**Server not found after global install**

Ensure npm's global bin directory is on your `PATH`:
```bash
npm config get prefix   # e.g. /usr/local
# Add /usr/local/bin to PATH if missing
```

**Permission denied on `~/.mindkeeper`**

```bash
mkdir -p ~/.mindkeeper
chmod 755 ~/.mindkeeper
```

**Mindmap is empty after restart**

Check the file exists and is valid JSON:
```bash
cat ~/.mindkeeper/mindmap.json | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).rootId))"
```

If the file is corrupt, restore from backup:
```bash
cp ~/.mindkeeper/mindmap.json.bak ~/.mindkeeper/mindmap.json
```

**stdio errors in Claude Desktop logs**

The server logs all operations to stderr (visible in Claude Desktop's MCP logs). Normal log lines start with `[mindkeeper]`. Anything else is an unexpected error.
