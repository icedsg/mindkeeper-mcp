export interface MindNode {
  id: string;
  text: string;
  parentId?: string;
  children: string[];
  createdAt: string;
  updatedAt: string;
  tags: string[];
}

export interface Mindmap {
  nodes: Record<string, MindNode>;
  rootId: string | null;
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
