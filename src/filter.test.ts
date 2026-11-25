import { describe, expect, it } from 'vitest';
import type { DocumentModel, OutlineNode } from './model';
import { extractTags, getFilterNodeIds, getFilteredVisibleNodes } from './filter';

function fixture(): DocumentModel {
  const nodes: Record<string, OutlineNode> = {
    root: { id: 'root', text: '', note: '', collapsed: false, children: ['a', 'other'] },
    a: { id: 'a', text: 'parent', note: '', collapsed: true, children: ['hit'] },
    hit: { id: 'hit', text: 'A special needle #research', note: '', collapsed: false, children: [] },
    other: { id: 'other', text: 'different #daily', note: '', collapsed: false, children: ['other-hit'] },
    'other-hit': { id: 'other-hit', text: 'another needle', note: '', collapsed: false, children: [] },
  };
  return { version: 1, rootId: 'root', nodes };
}

describe('outline filtering', () => {
  it('returns text matches and their ancestors, even under collapsed nodes', () => {
    const doc = fixture();
    const filter = { kind: 'search' as const, value: 'needle' };
    expect([...getFilterNodeIds(doc, 'root', filter)]).toEqual(['hit', 'a', 'other-hit', 'other']);
    expect(getFilteredVisibleNodes(doc, 'root', filter).map((item) => item.id)).toEqual(['a', 'hit', 'other', 'other-hit']);
    expect(doc.nodes.a.collapsed).toBe(true);
  });

  it('restricts hits to the current zoom subtree and pins the actively edited node', () => {
    const doc = fixture();
    const filter = { kind: 'search' as const, value: 'needle' };
    expect(getFilteredVisibleNodes(doc, 'a', filter).map((item) => item.id)).toEqual(['a', 'hit']);
    doc.nodes.hit.text = 'no longer a match while editing';
    expect(getFilterNodeIds(doc, 'a', filter, 'hit').has('hit')).toBe(true);
  });

  it('matches tags exactly and extracts multiple tags', () => {
    const doc = fixture();
    expect(extractTags('See #research, #chem2 and not x#embedded')).toEqual(['research', 'chem2']);
    expect(getFilteredVisibleNodes(doc, 'root', { kind: 'tag', value: 'research' }).map((item) => item.id)).toEqual(['a', 'hit']);
    expect(getFilteredVisibleNodes(doc, 'root', { kind: 'tag', value: 'daily' }).map((item) => item.id)).toEqual(['other']);
  });
});
