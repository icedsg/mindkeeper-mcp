export type EntityKind = "person" | "company" | "team" | "role" | "project" | "idea";

export const ENTITY_KINDS: EntityKind[] = ["person", "company", "team", "role", "project", "idea"];

export interface MindNode {
  id: string;
  text: string;
  kind?: EntityKind;
  attrs?: Record<string, string>;
  parentId?: string;
  children: string[];
  createdAt: string;
  updatedAt: string;
  tags: string[];
}

// Many-to-many relation beside the tree (person works on project, company owns project, ...)
export interface MindLink {
  id: string;
  from: string;
  to: string;
  type: string;
  label?: string;
  createdAt: string;
}

export type HistoryOp = "add" | "update" | "delete" | "move" | "link" | "unlink";

// Node state kept in history (children are derived from parentId, so they are left out)
export type NodeState = Omit<MindNode, "children" | "createdAt" | "updatedAt">;

// One change, appended on every write. at = when it was recorded; effectiveDate = when it really
// happened (e.g. a hire backdated to 2026-01-15), used by snapshot_as_of and diff_between.
export interface HistoryEntry {
  at: string;
  op: HistoryOp;
  nodeId: string;
  linkId?: string;
  before?: NodeState | MindLink;
  after?: NodeState | MindLink;
  effectiveDate?: string;
  rootBefore?: string | null;
  orphaned?: string[];
}

export interface Mindmap {
  nodes: Record<string, MindNode>;
  rootId: string | null;
  links?: MindLink[];
  history?: HistoryEntry[];
}

export interface GistCloudConfig {
  provider: "github_gist";
  token: string;
  gistId?: string;
}

export type CloudConfig = GistCloudConfig;

export interface MindkeeperConfig {
  cloud?: CloudConfig;
}
