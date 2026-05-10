# mindkeeper-mcp

An MCP server that captures ideas from conversations and organises them into a persistent mindmap. Ideas are stored as nodes that can be linked to a parent, tagged, searched, exported, and synced to the cloud — surviving across sessions.

Data is stored in `~/.mindkeeper/mindmap.json` with atomic writes and automatic backups.

## Features

- **Persistent** — mindmap survives across conversations and restarts
- **Hierarchical** — nest ideas under parents to build tree structure
- **Searchable** — weighted full-text search across text and tags
- **Deduplication** — same idea under the same parent is never added twice
- **Safe writes** — atomic temp-file → backup → rename strategy
- **Concurrency-safe** — serialised write queue prevents file corruption
- **Export** — Markdown, Mermaid diagram, OPML, JSON, or interactive HTML (with PNG/SVG download)
- **Import** — build a mindmap from your Claude.ai conversation history
- **Cloud sync** — backup and restore via private GitHub Gist

## Installation

### Global install (recommended)

```bash
npm install -g mindkeeper-mcp
```

### Local install

```bash
git clone https://github.com/icedsg/mindkeeper-mcp
cd mindkeeper-mcp
npm install
npm run build
```

## Configuration

### Claude Desktop

Edit `claude_desktop_config.json`. The quickest way to open it: in Claude Desktop, go to **Settings → Developer → Edit Config**.

Alternatively, find the file at:

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

After editing the config, **restart Claude Desktop** for the server to connect.

### Claude Code (CLI)

```bash
# Global install
claude mcp add mindkeeper -- mindkeeper-mcp

# Local install
claude mcp add mindkeeper -- node /path/to/mindkeeper-mcp/build/index.js
```

## Automatic topic capture (recommended)

Add this to your Claude Desktop system prompt (Settings → Profile → Custom Instructions) to make mindkeeper capture your topics automatically:

```
You have mindkeeper-mcp connected.
- After each of my messages, if I mention a new topic, question, goal, or interest — call add_idea to record it. Only capture what I say, never your own responses.
- Before adding, call search_ideas to avoid duplicates.
```

## Tools

| Tool | Description |
|---|---|
| `add_idea` | Capture a new idea, optionally attached to a parent node |
| `update_node` | Edit the text or tags of an existing idea |
| `delete_node` | Remove an idea; children are orphaned (kept, not deleted) |
| `search_ideas` | Full-text search across idea text and tags |
| `get_mindmap` | Retrieve the full tree, or a subtree from a given node |
| `export_markdown` | Export as a nested Markdown list |
| `export_mermaid` | Export as a Mermaid flowchart — paste into GitHub, Notion, or Obsidian |
| `export_opml` | Export as OPML — import into MindNode, OmniOutliner, or XMind |
| `export_json` | Export raw JSON — use with the [online visualizer](https://icedsg.github.io/mindkeeper-mcp/visualize.html) |
| `export_html` | Generate a self-contained interactive HTML file saved to `~/.mindkeeper/mindmap-export.html` — open in browser, drag, zoom, export PNG or SVG |
| `import_claude_export` | Parse a `conversations.json` from Claude.ai's data export and build a mindmap from your conversation history |
| `sync_cloud` | Push or pull the mindmap to/from a private GitHub Gist |
| `cloud_status` | Show current cloud sync configuration |

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

**Visualize interactively:**
```
export_html   # opens in browser — drag, zoom, download PNG or SVG from the toolbar
```

**Or paste into an online renderer:**
```
export_json   # drop the output into the visualizer at the project website
```

## Cloud sync

Create `~/.mindkeeper/config.json`:

```json
{
  "cloud": {
    "provider": "github_gist",
    "token": "ghp_YOUR_PERSONAL_ACCESS_TOKEN"
  }
}
```

Generate a token at [github.com/settings/tokens](https://github.com/settings/tokens) with the `gist` scope. The first `sync_cloud direction="push"` auto-creates a private Gist and saves the `gistId` back to config.

## Visualizer

Export your mindmap as JSON and drop it into the browser-based visualizer at [icedsg.github.io/mindkeeper-mcp/visualize.html](https://icedsg.github.io/mindkeeper-mcp/visualize.html) for zoomable, draggable, multi-layout exploration.

## Import from Claude.ai

Turn your entire Claude.ai conversation history into a structured mindmap in three steps.

### Step 1 — Export your Claude.ai data

1. Open [claude.ai](https://claude.ai) and go to **Settings → Account**
2. Scroll to **Export Data** and click **Export**
3. Claude emails you a download link within a few minutes
4. Download the ZIP and unzip it — find `conversations.json` inside

### Step 2 — Import and build the mindmap

Tell Claude:

```
Import my Claude export from /path/to/conversations.json into my mindmap
```

Replace the path with the actual location:
- **Windows:** `C:\Users\YourName\Downloads\claude-export\conversations.json`
- **Mac/Linux:** `/Users/YourName/Downloads/claude-export/conversations.json`

Claude reads every conversation, clusters them by theme, and populates the mindmap. Trivial or very short conversations are skipped automatically.

### Step 3 — Visualise the result

```
Export the mindmap as HTML
```

The HTML file is saved to `~/.mindkeeper/mindmap-export.html` and opens in any browser — no server needed. Inside the file, use the toolbar buttons to download a **PNG** or **SVG** image.

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

## License & Credits

MIT License — see [LICENSE](LICENSE).

**Open-source dependencies:**

| Package | License | Used for |
|---|---|---|
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | MCP server protocol |
| [uuid](https://github.com/uuidjs/uuid) | MIT | Node ID generation |
| [D3.js](https://d3js.org) | ISC | Force graph & tree views in the web visualizer |

**Original work:**

[`mindkeeper-map.js`](docs/mindkeeper-map.js) — the interactive mindmap renderer used in the exported HTML and web visualizer is original code with no external dependencies. Algorithms: slot-based tree layout, cubic-bezier links, canvas `measureText` node sizing, per-node drag coexisting with canvas pan.
