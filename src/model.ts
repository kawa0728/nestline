export type NodeId = string;

export interface OutlineNode {
  id: NodeId;
  text: string;
  note: string;
  collapsed: boolean;
  children: NodeId[];
}

export interface DocumentModel {
  version: number;
  rootId: NodeId;
  nodes: Record<NodeId, OutlineNode>;
}

export function createEmptyDocument(): DocumentModel {
  const rootId = crypto.randomUUID();
  return {
    version: 1,
    rootId,
    nodes: {
      [rootId]: { id: rootId, text: '', note: '', collapsed: false, children: [] },
    },
  };
}

export function isDocumentModel(value: unknown): value is DocumentModel {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<DocumentModel>;
  if (doc.version !== 1 || typeof doc.rootId !== 'string' || !doc.nodes || typeof doc.nodes !== 'object') return false;
  const root = (doc.nodes as Record<string, unknown>)[doc.rootId] as Partial<OutlineNode> | undefined;
  return !!root && root.id === doc.rootId && typeof root.text === 'string' && Array.isArray(root.children);
}
