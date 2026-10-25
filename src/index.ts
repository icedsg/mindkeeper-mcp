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
  exportMarkdown,
  exportMermaid,
  exportOPML,
  exportJSON,
  exportHTML,
  importClaudeExport,
  addEntity,
  linkEntities,
  unlinkEntities,
  moveNode,
} from "./mindmap.js";
import {
  loadConfig,
  saveConfig,
  pushToGist,
  pullFromGist,
} from "./storage.js";
import { ENTITY_KINDS } from "./types.js";
import type { EntityKind, MindNode, Mindmap } from "./types.js";

const server = new Server(
  { name: "mindkeeper-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Tree builder (used by get_mindmap) ───────────────────────────────────────

interface TreeNode {
  id: string;
  text: string;
  kind?: EntityKind;
  attrs?: Record<string, string>;
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
    ...(node.kind !== undefined && { kind: node.kind }),
    ...(node.attrs !== undefined && { attrs: node.attrs }),
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
        "Does not change parent/child relationships — use move_node to restructure.",
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
      name: "add_entity",
      description:
        "Add a typed entity — a person, company, team, role, project or idea — to the mindmap. " +
        "Use it for org charts and project records: the tree is the reporting line (manager = parent, " +
        "company/team = parent of its people), and link_entities covers many-to-many relations such as " +
        "who works on which project. Only record people and organisations the user has told you about. " +
        "An entity with the same name and kind under the same parent is merged (attrs/tags added), not duplicated.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Display name, e.g. 'Priya Nair' or 'Acme Ltd'" },
          kind: {
            type: "string",
            enum: ENTITY_KINDS,
            description: "Entity type",
          },
          parentId: {
            type: "string",
            description: "Parent node ID (the manager, team or company). Omit for a root-level entity.",
          },
          attrs: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "Optional attributes as strings, e.g. {title: 'CTO', email, url, start: '2026-01-15', end, status: 'left'}",
          },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
        },
        required: ["name", "kind"],
      },
    },
    {
      name: "link_entities",
      description:
        "Record a relation between two nodes that is not a parent/child line, e.g. a person " +
        "'works_on' a project, a company 'owns' a project, a person 'advises' a company. " +
        "Type is lowercased; the same from/to/type pair is stored once.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Source node ID" },
          to: { type: "string", description: "Target node ID" },
          type: { type: "string", description: "Relation type, e.g. works_on, owns, advises, member_of" },
          label: { type: "string", description: "Optional display label (defaults to the type)" },
        },
        required: ["from", "to", "type"],
      },
    },
    {
      name: "unlink_entities",
      description:
        "Remove a relation made with link_entities. Pass linkId, or from + to (and type to remove only that type).",
      inputSchema: {
        type: "object",
        properties: {
          linkId: { type: "string", description: "ID of the link to remove" },
          from: { type: "string", description: "Source node ID" },
          to: { type: "string", description: "Target node ID" },
          type: { type: "string", description: "Only remove links of this type" },
        },
      },
    },
    {
      name: "move_node",
      description:
        "Move a node (and its subtree) under a new parent — e.g. a person gets a new manager or moves team. " +
        "Omit newParentId to make it a root-level node. Moving a node under its own descendant is refused.",
      inputSchema: {
        type: "object",
        properties: {
          nodeId: { type: "string", description: "ID of the node to move" },
          newParentId: { type: "string", description: "ID of the new parent. Omit for root level." },
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
      name: "export_html",
      description:
        "Generate a self-contained interactive HTML mindmap and save it to ~/.mindkeeper/mindmap-export.html. " +
        "After calling this tool, tell the user to open the file in their browser — no server required. " +
        "The diagram is draggable, zoomable, and uses a side-branch layout with curved connections. " +
        "The toolbar inside the HTML has buttons to download the diagram as PNG or SVG.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "import_claude_export",
      description:
        "Read a conversations.json file exported from Claude.ai and return a structured list of conversations. " +
        "The user must first download their data at claude.ai → Settings → Account → Export Data, " +
        "unzip the archive, and provide the path to conversations.json. " +
        "After calling this tool, YOU (the AI) must analyze the returned conversation list and: " +
        "1) identify major topic clusters across the conversations, " +
        "2) call add_idea to create a root topic node for each cluster, " +
        "3) call add_idea to add notable sub-topics or recurring themes as children, " +
        "4) skip trivial, one-off, or very short conversations. " +
        "Group by theme, not by conversation title. Aim for a clean, meaningful mindmap hierarchy. " +
        "When done, call export_html so the user can visualize the result.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "Absolute path to the conversations.json file from the Claude.ai data export. " +
              "Windows example: C:\\Users\\name\\Downloads\\conversations.json. " +
              "Mac/Linux example: /Users/name/Downloads/conversations.json",
          },
        },
        required: ["filePath"],
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

      case "add_entity": {
        const node = await addEntity(
          args["name"] as string,
          args["kind"] as string,
          args["parentId"] as string | undefined,
          args["attrs"] as Record<string, unknown> | undefined,
          args["tags"] as string[] | undefined
        );
        console.error(`[mindkeeper] tool add_entity -> ${node.id}`);
        return ok({ node });
      }

      case "link_entities": {
        const link = await linkEntities(
          args["from"] as string,
          args["to"] as string,
          args["type"] as string,
          args["label"] as string | undefined
        );
        console.error(`[mindkeeper] tool link_entities -> ${link.id}`);
        return ok({ link });
      }

      case "unlink_entities": {
        const result = await unlinkEntities({
          linkId: args["linkId"] as string | undefined,
          from: args["from"] as string | undefined,
          to: args["to"] as string | undefined,
          type: args["type"] as string | undefined,
        });
        console.error(`[mindkeeper] tool unlink_entities (${result.removed.length})`);
        return ok(result);
      }

      case "move_node": {
        const node = await moveNode(
          args["nodeId"] as string,
          args["newParentId"] as string | undefined
        );
        console.error(`[mindkeeper] tool move_node ${node.id}`);
        return ok({ node });
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
          const links = map.links ?? [];
          return ok({ tree, orphans, totalNodes, ...(links.length > 0 && { links }) });
        }
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

      case "export_html": {
        const result = await exportHTML();
        console.error(`[mindkeeper] tool export_html -> ${result.filePath}`);
        return ok({
          filePath: result.filePath,
          nodeCount: result.nodeCount,
          message: `Mindmap HTML written to ${result.filePath}. Open in your browser — drag, zoom, and use the toolbar to download PNG or SVG.`,
        });
      }

      case "import_claude_export": {
        const filePath = args["filePath"] as string;
        const result = await importClaudeExport(filePath);
        console.error(
          `[mindkeeper] tool import_claude_export ${result.conversationCount} convs from ${filePath}`
        );
        return ok(result);
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
