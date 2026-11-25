import type { DocumentModel, NodeId } from './model';
import type { VisibleNode } from './tree';

export type OutlineFilter = { kind: 'search' | 'tag'; value: string };

const tagPattern = /(^|[^\p{L}\p{M}\p{N}_-])#([\p{L}\p{M}\p{N}_-]+)/gu;

export function extractTags(text: string): string[] {
  return [...text.matchAll(tagPattern)].map((match) => match[2]);
}

function matches(nodeText: string, filter: OutlineFilter): boolean {
  if (filter.kind === 'search') return nodeText.toLocaleLowerCase().includes(filter.value.trim().toLocaleLowerCase());
  return extractTags(nodeText).includes(filter.value);
}

/** Return each hit plus its path back to the active zoom root. */
export function getFilterNodeIds(doc: DocumentModel, zoomId: NodeId, filter: OutlineFilter, pinnedId?: NodeId | null): Set<NodeId> {
  const included = new Set<NodeId>();
  if (!filter.value.trim() || !doc.nodes[zoomId]) return included;
  const addPath = (id: NodeId, path: NodeId[]) => {
    included.add(id);
    for (const ancestor of path) included.add(ancestor);
  };
  const visit = (id: NodeId, ancestors: NodeId[]) => {
    const node = doc.nodes[id];
    if (!node) return;
    if (matches(node.text, filter)) addPath(id, ancestors);
    const nextPath = id === doc.rootId ? ancestors : [...ancestors, id];
    for (const childId of node.children) visit(childId, nextPath);
  };
  visit(zoomId, []);
  if (pinnedId && doc.nodes[pinnedId]) {
    let current: NodeId | null = pinnedId;
    while (current) {
      included.add(current);
      if (current === zoomId) break;
      const parent = Object.values(doc.nodes).find((node) => node.children.includes(current!));
      current = parent?.id ?? null;
    }
  }
  return included;
}

/** Flatten only matches and their ancestors; never changes the document's collapsed flags. */
export function getFilteredVisibleNodes(doc: DocumentModel, zoomId: NodeId, filter: OutlineFilter, pinnedId?: NodeId | null): VisibleNode[] {
  const included = getFilterNodeIds(doc, zoomId, filter, pinnedId);
  const result: VisibleNode[] = [];
  const visit = (id: NodeId, depth: number) => {
    const node = doc.nodes[id];
    if (!node) return;
    if (id !== doc.rootId && included.has(id)) result.push({ id, depth });
    // Filter projection follows hits through collapsed branches without changing their state.
    for (const childId of node.children) visit(childId, depth + (id === doc.rootId ? 0 : 1));
  };
  visit(zoomId, 0);
  return result;
}
