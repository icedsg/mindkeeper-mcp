#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  addIdea,
  updateNode,
  deleteNode,
  searchNodes,
  getSubtree,
  getLastSession,
  exportMarkdown,
  exportMermaid,
  exportOPML,
  exportJSON,
} from "./mindmap.js";
import {
  loadConfig,
  saveConfig,
  pushToGist,
  pullFromGist,
} from "./storage.js";
import type { MindNode, Mindmap } from "./types.js";

const server = new Server(
  { name: "mindkeeper-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Tree builder (used by get_mindmap) ───────────────────────────────────────

interface TreeNode {
  id: string;
  text: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  children: TreeNode[];
}

function buildTree(nodes: Record<string, MindNode>, rootId: string): TreeNode | null {
  const node = nodes[rootId];
  if (!node) return null;
  return {
    id: node.id,
    text: node.text,
    tags: node.tags,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    children: node.children
      .map((childId) => buildTree(nodes, childId))
      .filter((n): n is TreeNode => n !== null),
  };
}

// ── Tool definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "add_idea",
      description:
        "Capture a new idea or concept into the persistent mindmap. " +
        "ONLY use this when the user themselves has expressed an idea, question, goal, task, topic, or interest — " +
        "including casual searches ('how to cook biryani'), projects they mention, or anything they bring up. " +
        "NEVER invent, generate, or seed example nodes. NEVER add content Claude thought of. " +
        "Before adding, check if the same idea already exists (use search_ideas) to avoid duplicates. " +
        "Attach it to an existing node with parentId to build hierarchical structure. " +
        "Returns the new node with its ID (needed for future parentId references).",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The idea or concept text to capture",
          },
          parentId: {
            type: "string",
            description:
              "ID of an existing node to attach this idea under. Omit to create a root-level idea.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional topic tags. Leading # is stripped and values are lowercased automatically. " +
              "Pass either [\"roadmap\", \"q3\"] or [\"#roadmap\", \"#q3\"] — both work.",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "update_node",
      description:
        "Edit the text or tags of an existing node. " +
        "Use this when an idea has been refined, clarified, or its scope has changed. " +
        "Does not change parent/child relationships — use add_idea + delete_node to restructure.",
      inputSchema: {
        type: "object",
        properties: {
          nodeId: {
            type: "string",
            description: "ID of the node to update",
          },
          newText: {
            type: "string",
            description: "Replacement text for the node",
          },
          newTags: {
            type: "array",
            items: { type: "string" },
            description:
              "Replacement tag list (full set — overwrites existing tags). " +
              "Leading # is stripped and values are lowercased automatically.",
          },
        },
        required: ["nodeId", "newText"],
      },
    },
    {
      name: "delete_node",
      description:
        "Remove a node from the mindmap. " +
        "Child nodes are orphaned (kept in the map but disconnected from the tree). " +
        "Use search_ideas first if you are unsure of the nodeId.",
      inputSchema: {
        type: "object",
        properties: {
          nodeId: {
            type: "string",
            description: "ID of the node to delete",
          },
        },
        required: ["nodeId"],
      },
    },
    {
      name: "search_ideas",
      description:
        "Search the mindmap for nodes matching a query string. " +
        "Scores nodes by exact match > substring > per-token matches in text and tags. " +
        "Use this to find a node ID before updating/deleting, or to surface related ideas.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search terms — partial words and phrases both work",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_mindmap",
      description:
        "Retrieve the mindmap as a nested tree. " +
        "With no arguments, returns the full tree from the root plus any orphaned nodes. " +
        "Pass nodeId to get just that subtree (the node and all its descendants).",
      inputSchema: {
        type: "object",
        properties: {
          nodeId: {
            type: "string",
            description:
              "ID of a node to get its subtree. Omit to retrieve the entire mindmap.",
          },
        },
      },
    },
    {
      name: "get_last_session",
      description:
        "Call this at the START of every conversation to see what the user was last working on. " +
        "Returns the most recently added or updated nodes (up to 5 by default), their tags, " +
        "and their parent path so you know the context. Use this to greet the user with what was " +
        "last on their mind — e.g. 'Last time you were thinking about X, want to continue?' " +
        "Never skip this at session start if the mindmap may have content.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max number of recent nodes to return (default 5, max 20)",
          },
        },
      },
    },
    {
      name: "export_json",
      description:
        "Export the full mindmap as raw JSON — the exact contents of mindmap.json. " +
        "Use this to save a backup, import into the visualizer at the project website, or inspect the raw data structure.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "export_markdown",
      description:
        "Export the full mindmap as a Markdown nested list, ready to copy into a document or note. " +
        "Tags are shown inline. Orphaned nodes are listed in a separate section.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "export_mermaid",
      description:
        "Export the full mindmap as a Mermaid flowchart diagram. " +
        "Paste the output into any Markdown renderer that supports Mermaid (GitHub, Notion, Obsidian) to get a visual graph.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "export_opml",
      description:
        "Export the full mindmap as OPML (Outline Processor Markup Language). " +
        "OPML is supported by dedicated mindmap apps such as MindNode, OmniOutliner, and XMind for import.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "sync_cloud",
      description:
        "Sync the mindmap with GitHub Gist cloud storage. " +
        "Requires ~/.mindkeeper/config.json with cloud credentials (see README). " +
        "Use direction='push' to upload local state, 'pull' to download and overwrite local. " +
        "First push auto-creates a private Gist and saves the gistId back to config.",
      inputSchema: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["push", "pull"],
            description: "push = upload local → cloud | pull = download cloud → local",
          },
        },
        required: ["direction"],
      },
    },
    {
      name: "cloud_status",
      description:
        "Check whether cloud sync is configured and show the current config (token is masked). " +
        "Returns the provider, gistId (if any), and setup instructions if not configured.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

// ── Tool handler ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "add_idea": {
        const node = await addIdea(
          args["text"] as string,
          args["parentId"] as string | undefined,
          args["tags"] as string[] | undefined
        );
        console.error(`[mindkeeper] tool add_idea -> ${node.id}`);
        return ok({ node });
      }

      case "update_node": {
        const node = await updateNode(
          args["nodeId"] as string,
          args["newText"] as string,
          args["newTags"] as string[] | undefined
        );
        console.error(`[mindkeeper] tool update_node ${node.id}`);
        return ok({ node });
      }

      case "delete_node": {
        const result = await deleteNode(args["nodeId"] as string);
        console.error(`[mindkeeper] tool delete_node ${result.deleted}`);
        return ok(result);
      }

      case "search_ideas": {
        const results = await searchNodes(args["query"] as string);
        console.error(`[mindkeeper] tool search_ideas "${args["query"]}" -> ${results.length} hits`);
        return ok({ count: results.length, results });
      }

      case "get_mindmap": {
        const nodeId = args["nodeId"] as string | undefined;
        if (nodeId !== undefined) {
          const nodes = await getSubtree(nodeId);
          const rootNode = nodes[0];
          if (!rootNode) return ok({ tree: null });
          const nodeMap: Record<string, MindNode> = {};
          for (const n of nodes) nodeMap[n.id] = n;
          const tree = buildTree(nodeMap, nodeId);
          console.error(`[mindkeeper] tool get_mindmap subtree ${nodeId} (${nodes.length} nodes)`);
          return ok({ tree });
        } else {
          const map: Mindmap = await exportJSON();
          const tree = map.rootId ? buildTree(map.nodes, map.rootId) : null;
          const orphans = Object.values(map.nodes)
            .filter((n) => n.parentId === undefined && n.id !== map.rootId)
            .map((n) => buildTree(map.nodes, n.id))
            .filter((n): n is TreeNode => n !== null);
          const totalNodes = Object.keys(map.nodes).length;
          console.error(`[mindkeeper] tool get_mindmap full (${totalNodes} nodes)`);
          return ok({ tree, orphans, totalNodes });
        }
      }

      case "get_last_session": {
        const limit = Math.min((args["limit"] as number | undefined) ?? 5, 20);
        const session = await getLastSession(limit);
        console.error(`[mindkeeper] tool get_last_session (${session.recentNodes.length} nodes)`);
        return ok(session);
      }

      case "export_json": {
        const map = await exportJSON();
        const json = JSON.stringify(map, null, 2);
        console.error(`[mindkeeper] tool export_json (${Object.keys(map.nodes).length} nodes)`);
        return { content: [{ type: "text" as const, text: json }] };
      }

      case "export_markdown": {
        const markdown = await exportMarkdown();
        console.error(`[mindkeeper] tool export_markdown (${markdown.length} chars)`);
        return { content: [{ type: "text" as const, text: markdown }] };
      }

      case "export_mermaid": {
        const mermaid = await exportMermaid();
        console.error(`[mindkeeper] tool export_mermaid (${mermaid.length} chars)`);
        return { content: [{ type: "text" as const, text: mermaid }] };
      }

      case "export_opml": {
        const opml = await exportOPML();
        console.error(`[mindkeeper] tool export_opml (${opml.length} chars)`);
        return { content: [{ type: "text" as const, text: opml }] };
      }

      case "sync_cloud": {
        const direction = args["direction"] as "push" | "pull";
        const cfg = await loadConfig();

        if (!cfg.cloud) {
          return ok({
            error: "Cloud sync not configured.",
            setup: [
              "Create ~/.mindkeeper/config.json with your GitHub credentials:",
              JSON.stringify(
                {
                  cloud: {
                    provider: "github_gist",
                    token: "ghp_YOUR_PERSONAL_ACCESS_TOKEN",
                    gistId: "(leave blank — auto-created on first push)",
                  },
                },
                null,
                2
              ),
              "Generate a token at: https://github.com/settings/tokens (needs 'gist' scope)",
            ],
          });
        }

        if (cfg.cloud.provider !== "github_gist") {
          throw new Error(`Unsupported provider: ${cfg.cloud.provider}`);
        }

        const gistCfg = cfg.cloud;

        if (direction === "push") {
          const mindmap = await exportJSON();
          const { gistId, url } = await pushToGist(mindmap, gistCfg);
          if (!gistCfg.gistId) {
            cfg.cloud.gistId = gistId;
            await saveConfig(cfg);
          }
          const nodeCount = Object.keys(mindmap.nodes).length;
          console.error(`[mindkeeper] sync_cloud push -> gist ${gistId}`);
          return ok({ direction: "push", gistId, url, nodeCount });
        } else {
          const mindmap = await pullFromGist(gistCfg);
          const { saveMindmap } = await import("./storage.js");
          await saveMindmap(mindmap);
          const nodeCount = Object.keys(mindmap.nodes).length;
          console.error(`[mindkeeper] sync_cloud pull <- gist ${gistCfg.gistId}`);
          return ok({ direction: "pull", gistId: gistCfg.gistId, nodeCount });
        }
      }

      case "cloud_status": {
        const cfg = await loadConfig();
        if (!cfg.cloud) {
          return ok({
            configured: false,
            message: "No cloud config found at ~/.mindkeeper/config.json",
          });
        }
        const raw = cfg.cloud as unknown as { token: string; [key: string]: unknown };
        const { token, ...rest } = raw;
        return ok({
          configured: true,
          ...rest,
          token: token ? `${token.slice(0, 6)}${"*".repeat(10)}` : "(missing)",
        });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mindkeeper] ERROR tool=${name} ${message}`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mindkeeper] MCP server started (stdio)");
}

main().catch((err) => {
  console.error("[mindkeeper] Fatal:", err);
  process.exit(1);
});
