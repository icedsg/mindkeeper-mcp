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

export interface Mindmap {
  nodes: Record<string, MindNode>;
  rootId: string | null;
  links?: MindLink[];
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
