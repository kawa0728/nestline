import { describe, expect, it } from 'vitest';
import type { DocumentModel, OutlineNode } from './model';
import { collapseAll, deleteSubtree, duplicateSubtree, expandAll, expandToDepth, getVisibleNodes, indentNode, insertSibling, moveSibling, moveTo, outdentNode } from './tree';

function fixture(): DocumentModel {
  const ids = ['root', 'a', 'b', 'c', 'd', 'e'];
  const nodes: Record<string, OutlineNode> = Object.fromEntries(ids.map((id) => [id, { id, text: id, note: '', collapsed: false, children: [] }]));
  nodes.root.children = ['a', 'b', 'c'];
  nodes.a.children = ['d'];
  nodes.d.children = ['e'];
  return { version: 1, rootId: 'root', nodes };
}

describe('tree operations', () => {
  it('inserts a sibling, indents and outdents without mutating the source', () => {
    const doc = fixture();
    const inserted = insertSibling(doc, 'b');
    expect(inserted.document.nodes.root.children).toEqual(['a', 'b', inserted.id, 'c']);
    const indented = indentNode(doc, 'b');
    expect(indented.nodes.root.children).toEqual(['a', 'c']);
    expect(indented.nodes.a.children).toEqual(['d', 'b']);
    expect(outdentNode(indented, 'b').nodes.root.children).toEqual(['a', 'b', 'c']);
    expect(doc.nodes.root.children).toEqual(['a', 'b', 'c']);
  });

  it('deletes a subtree, duplicates it with fresh IDs, and reorders siblings', () => {
    const doc = fixture();
    const copy = duplicateSubtree(doc, 'a');
    const copiedRoot = copy.document.nodes[copy.id];
    expect(copy.document.nodes.root.children).toEqual(['a', copy.id, 'b', 'c']);
    expect(copiedRoot.text).toBe('a');
    expect(copiedRoot.children).not.toContain('d');
    expect(copy.document.nodes[copiedRoot.children[0]].text).toBe('d');
    expect(moveSibling(doc, 'b', -1).nodes.root.children).toEqual(['b', 'a', 'c']);
    const deleted = deleteSubtree(doc, 'a').document;
    expect(deleted.nodes.root.children).toEqual(['b', 'c']);
    expect(deleted.nodes.d).toBeUndefined();
  });

  it('moves before, after, and as a child while preventing cycles', () => {
    const doc = fixture();
    expect(moveTo(doc, 'c', 'a', 'before').nodes.root.children).toEqual(['c', 'a', 'b']);
    expect(moveTo(doc, 'a', 'b', 'after').nodes.root.children).toEqual(['b', 'a', 'c']);
    const nested = moveTo(doc, 'b', 'a', 'child');
    expect(nested.nodes.a.children).toEqual(['d', 'b']);
    expect(moveTo(nested, 'a', 'b', 'child')).toBe(nested);
  });
});

describe('visible outline projection', () => {
  it('respects collapsed nodes and zoom roots', () => {
    const doc = fixture();
    expect(getVisibleNodes(doc).map((item) => [item.id, item.depth])).toEqual([['a', 0], ['d', 1], ['e', 2], ['b', 0], ['c', 0]]);
    doc.nodes.a.collapsed = true;
    expect(getVisibleNodes(doc).map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(getVisibleNodes(doc, 'a').map((item) => [item.id, item.depth])).toEqual([['a', 0]]);
    doc.nodes.a.collapsed = false;
    expect(getVisibleNodes(doc, 'a').map((item) => [item.id, item.depth])).toEqual([['a', 0], ['d', 1], ['e', 2]]);
  });

  it('expands, collapses, and expands only to the requested depth', () => {
    const doc = fixture();
    expect(collapseAll(doc).nodes.a.collapsed).toBe(true);
    expect(expandAll(collapseAll(doc)).nodes.a.collapsed).toBe(false);
    const shallow = expandToDepth(doc, 0);
    expect(shallow.nodes.a.collapsed).toBe(true);
    expect(shallow.nodes.root.collapsed).toBe(false);
    expect(expandToDepth(doc, 2).nodes.a.collapsed).toBe(false);
    expect(expandToDepth(doc, 2).nodes.d.collapsed).toBe(true);
    expect(expandToDepth(doc, 3).nodes.d.collapsed).toBe(false);
  });
});
