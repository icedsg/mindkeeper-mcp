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
