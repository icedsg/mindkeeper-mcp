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
  exportJSON,
} from "./mindmap.js";
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
        "Use this whenever the user shares an idea, insight, goal, task, or any thought worth keeping. " +
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
              "Optional topic tags for grouping and filtering (e.g. [\"project\", \"urgent\"])",
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
              "Replacement tag list. Provide the full desired set — this overwrites existing tags.",
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
      name: "export_markdown",
      description:
        "Export the full mindmap as a Markdown nested list, ready to copy into a document or note. " +
        "Tags are shown inline. Orphaned nodes are listed in a separate section.",
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

      case "export_markdown": {
        const markdown = await exportMarkdown();
        console.error(`[mindkeeper] tool export_markdown (${markdown.length} chars)`);
        return { content: [{ type: "text" as const, text: markdown }] };
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
