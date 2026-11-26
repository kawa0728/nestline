import type { DocumentModel, NodeId, OutlineNode } from './model';

export interface VisibleNode { id: NodeId; depth: number }
export type DropPosition = 'before' | 'after' | 'child';

export function getParentId(doc: DocumentModel, childId: NodeId): NodeId | null {
  for (const node of Object.values(doc.nodes)) if (node.children.includes(childId)) return node.id;
  return null;
}

export function getAncestors(doc: DocumentModel, id: NodeId): NodeId[] {
  const result: NodeId[] = [];
  let current = id;
  while (current !== doc.rootId) {
    const parent = getParentId(doc, current);
    if (!parent) break;
    result.unshift(parent);
    current = parent;
  }
  return result;
}

export function getVisibleNodes(doc: DocumentModel, zoomId: NodeId = doc.rootId): VisibleNode[] {
  const result: VisibleNode[] = [];
  const visit = (id: NodeId, depth: number) => {
    const node = doc.nodes[id];
    if (!node) return;
    if (id !== doc.rootId) result.push({ id, depth });
    if (!node.collapsed) for (const child of node.children) visit(child, depth + (id === doc.rootId ? 0 : 1));
  };
  visit(zoomId, 0);
  return result;
}

function copyDoc(doc: DocumentModel): DocumentModel {
  return { ...doc, nodes: Object.fromEntries(Object.entries(doc.nodes).map(([id, n]) => [id, { ...n, children: [...n.children] }])) };
}

function makeNode(text = ''): OutlineNode {
  return { id: crypto.randomUUID(), text, note: '', collapsed: false, children: [] };
}

export function insertSibling(doc: DocumentModel, id: NodeId, text = ''): { document: DocumentModel; id: NodeId } {
  const parentId = getParentId(doc, id);
  if (!parentId) return { document: doc, id };
  const next = copyDoc(doc);
  const parent = next.nodes[parentId];
  const node = makeNode(text);
  parent.children.splice(parent.children.indexOf(id) + 1, 0, node.id);
  next.nodes[node.id] = node;
  return { document: next, id: node.id };
}

export function indentNode(doc: DocumentModel, id: NodeId): DocumentModel {
  const parentId = getParentId(doc, id);
  if (!parentId) return doc;
  const parent = doc.nodes[parentId];
  const index = parent.children.indexOf(id);
  if (index <= 0) return doc;
  const previousId = parent.children[index - 1];
  const next = copyDoc(doc);
  next.nodes[parentId].children.splice(index, 1);
  next.nodes[previousId].children.push(id);
  return next;
}

export function outdentNode(doc: DocumentModel, id: NodeId): DocumentModel {
  const parentId = getParentId(doc, id);
  if (!parentId || parentId === doc.rootId) return doc;
  const grandId = getParentId(doc, parentId);
  if (!grandId) return doc;
  const next = copyDoc(doc);
  const siblings = next.nodes[parentId].children;
  siblings.splice(siblings.indexOf(id), 1);
  const parentIndex = next.nodes[grandId].children.indexOf(parentId);
  next.nodes[grandId].children.splice(parentIndex + 1, 0, id);
  return next;
}

function descendants(doc: DocumentModel, id: NodeId): NodeId[] {
  const result: NodeId[] = [];
  const visit = (current: NodeId) => { result.push(current); for (const child of doc.nodes[current]?.children ?? []) visit(child); };
  visit(id);
  return result;
}

export function deleteSubtree(doc: DocumentModel, id: NodeId): { document: DocumentModel; previousId: NodeId | null } {
  if (id === doc.rootId) return { document: doc, previousId: null };
  const parentId = getParentId(doc, id);
  if (!parentId) return { document: doc, previousId: null };
  const next = copyDoc(doc);
  const siblings = next.nodes[parentId].children;
  const index = siblings.indexOf(id);
  siblings.splice(index, 1);
  const all = descendants(doc, id);
  all.forEach((nodeId) => delete next.nodes[nodeId]);
  const visible = getVisibleNodes(next);
  return { document: next, previousId: visible.find((item) => item.id === (siblings[index - 1] ?? parentId))?.id ?? visible.at(-1)?.id ?? null };
}

export function moveSibling(doc: DocumentModel, id: NodeId, direction: -1 | 1): DocumentModel {
  const parentId = getParentId(doc, id);
  if (!parentId) return doc;
  const siblings = doc.nodes[parentId].children;
  const index = siblings.indexOf(id);
  const target = index + direction;
  if (target < 0 || target >= siblings.length) return doc;
  const next = copyDoc(doc);
  const list = next.nodes[parentId].children;
  [list[index], list[target]] = [list[target], list[index]];
  return next;
}

export function duplicateSubtree(doc: DocumentModel, id: NodeId): { document: DocumentModel; id: NodeId } {
  const parentId = getParentId(doc, id);
  if (!parentId) return { document: doc, id };
  const next = copyDoc(doc);
  const remap = new Map<NodeId, NodeId>();
  for (const oldId of descendants(doc, id)) remap.set(oldId, crypto.randomUUID());
  for (const oldId of descendants(doc, id)) {
    const old = doc.nodes[oldId];
    const newId = remap.get(oldId)!;
    next.nodes[newId] = { ...old, id: newId, children: old.children.map((child) => remap.get(child)!) };
  }
  const rootCopyId = remap.get(id)!;
  const siblings = next.nodes[parentId].children;
  siblings.splice(siblings.indexOf(id) + 1, 0, rootCopyId);
  return { document: next, id: rootCopyId };
}

export function moveTo(doc: DocumentModel, id: NodeId, targetId: NodeId, position: DropPosition): DocumentModel {
  if (id === doc.rootId || id === targetId || descendants(doc, id).includes(targetId)) return doc;
  const sourceParentId = getParentId(doc, id);
  if (!sourceParentId) return doc;
  const destinationParentId = position === 'child' ? targetId : getParentId(doc, targetId);
  if (!destinationParentId) return doc;
  const next = copyDoc(doc);
  next.nodes[sourceParentId].children.splice(next.nodes[sourceParentId].children.indexOf(id), 1);
  const destination = next.nodes[destinationParentId];
  const insertAt = position === 'child' ? destination.children.length : destination.children.indexOf(targetId) + (position === 'after' ? 1 : 0);
  destination.children.splice(insertAt, 0, id);
  destination.collapsed = position === 'child' ? false : destination.collapsed;
  return next;
}

export function setCollapsed(doc: DocumentModel, id: NodeId, collapsed: boolean): DocumentModel {
  if (doc.nodes[id]?.collapsed === collapsed) return doc;
  const next = copyDoc(doc); next.nodes[id].collapsed = collapsed; return next;
}

export function expandAll(doc: DocumentModel): DocumentModel {
  const next = copyDoc(doc); Object.values(next.nodes).forEach((node) => { node.collapsed = false; }); return next;
}

export function collapseAll(doc: DocumentModel): DocumentModel {
  const next = copyDoc(doc); Object.values(next.nodes).forEach((node) => { if (node.id !== doc.rootId && node.children.length) node.collapsed = true; }); return next;
}

export function expandToDepth(doc: DocumentModel, depth: number): DocumentModel {
  const next = copyDoc(doc);
  const visibleLevels = Math.max(1, depth);
  const visit = (id: NodeId, level: number) => {
    const node = next.nodes[id];
    node.collapsed = id !== doc.rootId && node.children.length > 0 && level >= visibleLevels - 1;
    for (const child of node.children) visit(child, level + 1);
  };
  visit(doc.rootId, -1);
  return next;
}

export function updateNodeText(doc: DocumentModel, id: NodeId, text: string): DocumentModel {
  if (!doc.nodes[id] || doc.nodes[id].text === text) return doc;
  const next = copyDoc(doc); next.nodes[id].text = text; return next;
}
