import { describe, expect, it } from 'vitest';
import type { DocumentModel, NodeId, OutlineNode } from './model';
import { appendImportedDocument, convertLatexText, exportJson, exportLatex, exportMarkdown, exportOpml, importJson, importMarkdown, importOpml } from './io';

function outlineShape(doc: DocumentModel, id: NodeId = doc.rootId): unknown[] {
  return doc.nodes[id].children.map((childId) => ({ text: doc.nodes[childId].text, note: doc.nodes[childId].note, children: outlineShape(doc, childId) }));
}

function fixture(): DocumentModel {
  const ids = ['root', 'a', 'b', 'c', 'd'];
  const nodes: Record<string, OutlineNode> = Object.fromEntries(ids.map((id) => [id, { id, text: id, note: '', collapsed: false, children: [] }]));
  nodes.root.children = ['a', 'd'];
  nodes.a.children = ['b'];
  nodes.b.children = ['c'];
  nodes.a.note = 'a note & detail';
  return { version: 1, rootId: 'root', nodes };
}

describe('Markdown import/export', () => {
  it('round-trips heading, three list levels, math text, and multiline bodies', () => {
    const source = '# Research\n- Parent\n  - Child\n    - Deep node with $E=mc^2$\n      continued line\n# Notes\n- final';
    const imported = importMarkdown(source);
    const exported = exportMarkdown(imported);
    expect(exported).toContain('- Research\n  - Parent\n    - Child\n      - Deep node with $E=mc^2$\n        continued line');
    expect(outlineShape(importMarkdown(exported))).toEqual(outlineShape(imported));
  });

  it('round-trips a node continuation that resembles a heading or list marker', () => {
    const doc = importMarkdown('- Parent\n  # text, not a heading\n  \\- literal list marker');
    expect(doc.nodes[doc.nodes[doc.rootId].children[0]].text).toBe('Parent\n# text, not a heading\n- literal list marker');
    expect(outlineShape(importMarkdown(exportMarkdown(doc)))).toEqual(outlineShape(doc));
  });
});

describe('OPML and JSON import/export', () => {
  it('round-trips nested OPML text and note attributes with XML escaping', () => {
    const doc = fixture();
    const opml = exportOpml(doc);
    const imported = importOpml(opml);
    expect(outlineShape(imported)).toEqual(outlineShape(doc));
    expect(imported.nodes[imported.nodes[imported.rootId].children[0]].note).toBe('a note & detail');
    expect(opml).toContain('_note="a note &amp; detail"');
  });

  it('round-trips a zoomed JSON subtree and rejects invalid documents', () => {
    const doc = fixture();
    const json = exportJson(doc, 'a');
    const imported = importJson(json);
    expect(imported.nodes[imported.rootId].children).toEqual(['a']);
    expect(imported.nodes.a.children).toEqual(['b']);
    expect(() => importJson('{"hello":"world"}')).toThrow(/形式ではありません/);
    expect(() => importJson(JSON.stringify({ ...doc, nodes: { ...doc.nodes, a: { ...doc.nodes.a, children: ['missing'] } } }))).toThrow(/存在しない子ノード/);
    expect(() => importOpml('<html><outline text="no"/></html>')).toThrow(/OPML/);
  });

  it('appends imported branches with fresh IDs and leaves the source document untouched', () => {
    const current = fixture();
    const imported = importMarkdown('- Added\n  - nested');
    const combined = appendImportedDocument(current, imported);
    expect(combined.nodes.root.children).toHaveLength(3);
    const added = combined.nodes[combined.nodes.root.children[2]];
    expect(added.text).toBe('Added');
    expect(combined.nodes[added.children[0]].text).toBe('nested');
    expect(current.nodes.root.children).toHaveLength(2);
    expect(added.id).not.toBe(imported.nodes[imported.rootId].children[0]);
  });
});

describe('LaTeX export', () => {
  it('keeps math intact while converting Markdown and escaping plain text', () => {
    const result = convertLatexText('Total_50% & #tag ^ ~ \\ $x_1+50%$ **bold_1** *it_2* `code_3` [a_b](https://x_y.com)');
    expect(result).toContain('Total\\_50\\% \\& \\#tag \\textasciicircum{} \\textasciitilde{} \\textbackslash{}');
    expect(result).toContain('$x_1+50%$');
    expect(result).toContain('\\textbf{bold\\_1}');
    expect(result).toContain('\\textit{it\\_2}');
    expect(result).toContain('\\texttt{code\\_3}');
    expect(result).toContain('\\href{https://x\\_y.com}{a\\_b}');
    expect(convertLatexText('`$code$`')).toBe('\\texttt{\\$code\\$}');
    expect(convertLatexText('```\nraw_20%\n```')).toContain('\\begin{verbatim}\nraw_20%\n\\end{verbatim}');
  });

  it('includes the fixed layer definition and complete standalone document', () => {
    const result = exportLatex(fixture(), 'layer');
    expect(result.text).toContain('\\documentclass[11pt,a4paper,oneside]{ltjsarticle}');
    expect(result.text).toContain('\\newenvironment{layer}{%');
    expect(result.text).toContain('\\setcounter{maxdepth}{99}');
    expect(result.text).toContain('\\begin{document}');
    expect(result.text).toContain('\\end{document}');
    expect(result.text).toContain('a\n\\begin{layer}\n  b\n  \\begin{layer}\n    c');
  });

  it('warns on itemize depth beyond four and falls back to leftskip paragraphs', () => {
    const deep = importMarkdown('- one\n  - two\n    - three\n      - four\n        - five');
    const result = exportLatex(deep, 'itemize');
    expect(result.exceededDepth).toBe(true);
    expect(result.text).toContain('\\leftskip=13mm');
    expect(result.text).not.toContain('\\hspace');
    expect(exportLatex(fixture(), 'itemize').exceededDepth).toBe(false);
  });
});
