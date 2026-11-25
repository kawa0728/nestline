import { isDocumentModel, type DocumentModel, type NodeId, type OutlineNode } from './model';

export type LatexFormat = 'layer' | 'itemize';

function newId(): string { return crypto.randomUUID(); }
function newNode(text = '', note = ''): OutlineNode { return { id: newId(), text, note, collapsed: false, children: [] }; }

function makeDocument(): DocumentModel {
  const root = newNode();
  return { version: 1, rootId: root.id, nodes: { [root.id]: root } };
}

function addNode(doc: DocumentModel, parentId: NodeId, text: string, note = ''): NodeId {
  const node = newNode(text, note);
  doc.nodes[node.id] = node;
  doc.nodes[parentId].children.push(node.id);
  return node.id;
}

export function scopeDocument(doc: DocumentModel, zoomId: NodeId): DocumentModel {
  if (zoomId === doc.rootId || !doc.nodes[zoomId]) {
    return { ...doc, nodes: Object.fromEntries(Object.entries(doc.nodes).map(([id, node]) => [id, { ...node, children: [...node.children] }])) };
  }
  const included = new Set<NodeId>();
  const visit = (id: NodeId) => { included.add(id); for (const child of doc.nodes[id]?.children ?? []) visit(child); };
  visit(zoomId);
  const root = doc.nodes[doc.rootId];
  included.add(doc.rootId);
  return {
    version: doc.version,
    rootId: doc.rootId,
    nodes: Object.fromEntries([...included].map((id) => {
      const node = doc.nodes[id];
      return [id, { ...node, children: id === doc.rootId ? [zoomId] : [...node.children] }];
    })),
  };
}

export function exportMarkdown(doc: DocumentModel, zoomId: NodeId = doc.rootId): string {
  const scoped = scopeDocument(doc, zoomId);
  const lines: string[] = [];
  const write = (id: NodeId, depth: number) => {
    const node = scoped.nodes[id];
    if (!node) return;
    const indent = '  '.repeat(depth);
    const parts = node.text.split(/\r?\n/);
    lines.push(`${indent}- ${parts[0]}`);
    for (const line of parts.slice(1)) lines.push(`${indent}  ${/^[-*]\s/.test(line) ? `\\${line}` : line}`);
    for (const childId of node.children) write(childId, depth + 1);
  };
  for (const childId of scoped.nodes[scoped.rootId].children) write(childId, 0);
  return lines.join('\n');
}

export function importMarkdown(source: string): DocumentModel {
  const doc = makeDocument();
  const headingIds: Array<NodeId | undefined> = [];
  let currentHeading = doc.rootId;
  const bullets: Array<{ indent: number; id: NodeId }> = [];
  let lastNodeId: NodeId | null = null;

  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const bullet = rawLine.match(/^(\s*)([-*])\s+(.*)$/);
    if (bullet) {
      const indent = [...bullet[1]].reduce((columns, char) => columns + (char === '\t' ? 2 : 1), 0);
      while (bullets.length && bullets.at(-1)!.indent >= indent) bullets.pop();
      const parentId = bullets.at(-1)?.id ?? currentHeading;
      const id = addNode(doc, parentId, bullet[3].replace(/^\\([-*])\s/, '$1 '));
      bullets.push({ indent, id });
      lastNodeId = id;
      continue;
    }

    const indented = rawLine.match(/^(\s+)(.*)$/);
    if (indented && bullets.length && indented[1].length > bullets.at(-1)!.indent) {
      const node = doc.nodes[bullets.at(-1)!.id];
      node.text += `\n${indented[2].replace(/^\\([-*])\s/, '$1 ')}`;
      lastNodeId = node.id;
      continue;
    }

    const heading = rawLine.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      bullets.length = 0;
      let parentId = doc.rootId;
      for (let parentLevel = level - 1; parentLevel >= 1; parentLevel--) {
        if (headingIds[parentLevel]) { parentId = headingIds[parentLevel]!; break; }
      }
      headingIds.length = level + 1;
      const id = addNode(doc, parentId, heading[2]);
      headingIds[level] = id;
      currentHeading = id;
      lastNodeId = id;
      continue;
    }

    const continuation = rawLine.match(/^\s+(.*)$/);
    if (continuation && lastNodeId) {
      const node = doc.nodes[lastNodeId];
      node.text += `\n${continuation[1].replace(/^\\([-*])\s/, '$1 ')}`;
    } else {
      bullets.length = 0;
      lastNodeId = addNode(doc, currentHeading, rawLine.trim());
    }
  }
  return doc;
}

const xmlEscape = (value: string) => value
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');

function xmlUnescape(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const point = entity.toLowerCase().startsWith('#x') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    try { return String.fromCodePoint(point); } catch { return match; }
  });
}

export function exportOpml(doc: DocumentModel, zoomId: NodeId = doc.rootId): string {
  const scoped = scopeDocument(doc, zoomId);
  const write = (id: NodeId, depth: number): string => {
    const node = scoped.nodes[id];
    const indent = '  '.repeat(depth);
    const note = node.note ? ` _note="${xmlEscape(node.note)}"` : '';
    if (!node.children.length) return `${indent}<outline text="${xmlEscape(node.text)}"${note} />`;
    return `${indent}<outline text="${xmlEscape(node.text)}"${note}>\n${node.children.map((childId) => write(childId, depth + 1)).join('\n')}\n${indent}</outline>`;
  };
  const children = scoped.nodes[scoped.rootId].children;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Nestline outline</title></head>\n  <body>\n${children.map((id) => write(id, 2)).join('\n')}\n  </body>\n</opml>`;
}

export function importOpml(source: string): DocumentModel {
  const xml = source.replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  if (!/<opml\b/i.test(xml) || !/<body\b/i.test(xml) || !/<\/opml\s*>/i.test(xml)) throw new Error('有効な OPML 2.0 ファイルではありません。');
  const doc = makeDocument();
  const stack: NodeId[] = [doc.rootId];
  const tokens = xml.match(/<\/?outline\b[^>]*>/gi) ?? [];
  for (const token of tokens) {
    if (/^<\/outline/i.test(token)) {
      if (stack.length === 1) throw new Error('OPML の outline の入れ子が不正です。');
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    const attrSource = token.replace(/^<outline\b|\s*\/?\s*>$/gi, '');
    const attrRegex = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const match of attrSource.matchAll(attrRegex)) attrs[match[1]] = xmlUnescape(match[2] ?? match[3] ?? '');
    const id = addNode(doc, stack.at(-1)!, attrs.text ?? '', attrs._note ?? '');
    if (!/\/\s*>$/.test(token)) stack.push(id);
  }
  if (stack.length !== 1) throw new Error('OPML の outline が閉じられていません。');
  return doc;
}

export function exportJson(doc: DocumentModel, zoomId: NodeId = doc.rootId): string {
  return JSON.stringify(scopeDocument(doc, zoomId), null, 2);
}

function validateDocumentTree(doc: DocumentModel): void {
  const parents = new Map<NodeId, number>();
  for (const [id, node] of Object.entries(doc.nodes)) {
    if (!node || node.id !== id || typeof node.text !== 'string' || typeof node.note !== 'string' || typeof node.collapsed !== 'boolean' || !Array.isArray(node.children) || node.children.some((child) => typeof child !== 'string')) {
      throw new Error('JSON のノード形式が不正です。');
    }
    if (new Set(node.children).size !== node.children.length) throw new Error('同じ親の下に重複した子ノードがあります。');
    for (const childId of node.children) {
      if (!doc.nodes[childId]) throw new Error(`存在しない子ノード ID: ${childId}`);
      parents.set(childId, (parents.get(childId) ?? 0) + 1);
    }
  }
  if (parents.has(doc.rootId)) throw new Error('ルートノードに親があります。');
  for (const id of Object.keys(doc.nodes)) if (id !== doc.rootId && parents.get(id) !== 1) throw new Error(`ノード ${id} の親子関係が不正です。`);
  const visited = new Set<NodeId>();
  const visit = (id: NodeId) => {
    if (visited.has(id)) throw new Error('JSON に循環参照があります。');
    visited.add(id);
    for (const child of doc.nodes[id].children) visit(child);
  };
  visit(doc.rootId);
  if (visited.size !== Object.keys(doc.nodes).length) throw new Error('ルートから到達できないノードがあります。');
}

export function importJson(source: string): DocumentModel {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error('JSON を読み取れません。'); }
  if (!isDocumentModel(value)) throw new Error('Nestline の文書形式ではありません。');
  validateDocumentTree(value);
  return value;
}

function escapeLatexText(text: string): string {
  return text.replace(/[\\{}%&#_$^~]/g, (char) => ({
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '%': '\\%', '&': '\\&', '#': '\\#', '_': '\\_', '$': '\\$', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}',
  })[char]!);
}

function latexInline(source: string): string {
  const substitutions: string[] = [];
  let tokenPrefix = '\uE000NESTLATEX';
  while (source.includes(tokenPrefix)) tokenPrefix += 'X';
  const tokenPattern = new RegExp(`${tokenPrefix}(\\d+)\\uE001`, 'g');
  const protect = (value: string) => {
    const token = `${tokenPrefix}${substitutions.length}\uE001`;
    substitutions.push(value);
    return token;
  };
  let text = source.replace(/(?<!\\)(`+)(.+?)\1(?!`)/g, (_match, _ticks: string, code: string) => protect(`\\texttt{${escapeLatexText(code)}}`));
  text = text.replace(/\$\$([\s\S]*?)\$\$|(?<!\\)\$(?!\s)([^\n$]+?)\$/g, (match) => protect(match));
  text = text.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_match, label: string, url: string) => protect(`\\href{${escapeLatexText(url)}}{${escapeLatexText(label)}}`));
  text = text.replace(/\*\*([^*\n]+)\*\*/g, (_match, body: string) => protect(`\\textbf{${escapeLatexText(body)}}`));
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)|(?<![\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])/gu, (_match, starBody: string | undefined, underscoreBody: string | undefined) => protect(`\\textit{${escapeLatexText(starBody ?? underscoreBody ?? '')}}`));
  text = escapeLatexText(text);
  const expandTokens = (value: string): string => value.replace(tokenPattern, (_match, index: string) => expandTokens(substitutions[Number(index)] ?? ''));
  return expandTokens(text);
}

export function convertLatexText(text: string): string {
  const code = text.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/);
  if (code) return `\\begin{verbatim}\n${code[1]}\n\\end{verbatim}`;
  return latexInline(text).replace(/\r?\n/g, '\\par\n');
}

const LAYER_PREAMBLE = String.raw`\documentclass[11pt,a4paper,oneside]{ltjsarticle}
\usepackage[left=16mm,right=16mm,top=18mm,bottom=18mm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage[hidelinks]{hyperref}
\usepackage{xcolor}
\usepackage{luatexja-fontspec}
\setmainjfont{HaranoAjiMincho}
\setsansjfont{HaranoAjiGothic}
\definecolor{g75}{HTML}{404040}
\definecolor{g50}{HTML}{808080}
\newcounter{pyrdepth}
\newcounter{discardlevel}
\newcounter{maxdepth}
\setcounter{maxdepth}{99}
\newenvironment{layer}{%
  \stepcounter{pyrdepth}%
  \ifnum\value{discardlevel}>0 %
  \else\ifnum\value{pyrdepth}>\value{maxdepth}%
    \setcounter{discardlevel}{\value{pyrdepth}}\setbox0=\vbox\bgroup
  \else
    \par\vspace{1mm}%
    \ifcase\value{pyrdepth}\or \setlength{\leftskip}{13mm}\small\color{g75}%
    \or \setlength{\leftskip}{26mm}\footnotesize\color{g50}%
    \else \setlength{\leftskip}{39mm}\footnotesize\color{g50}\fi
    \ignorespaces
  \fi\fi
}{%
  \ifnum\value{discardlevel}=\value{pyrdepth}\egroup\setcounter{discardlevel}{0}\fi
  \ifnum\value{discardlevel}>0\else\par\vspace{1mm}\fi
  \addtocounter{pyrdepth}{-1}%
}`;

function layerBody(doc: DocumentModel, zoomId: NodeId): string {
  const scoped = scopeDocument(doc, zoomId);
  const render = (id: NodeId, depth: number): string => {
    const node = scoped.nodes[id];
    const text = convertLatexText(node.text);
    if (!node.children.length) return text;
    return `${text}\n${node.children.map((childId) => `${'  '.repeat(depth)}\\begin{layer}\n${'  '.repeat(depth + 1)}${render(childId, depth + 1)}\n${'  '.repeat(depth)}\\end{layer}`).join('\n')}`;
  };
  return scoped.nodes[scoped.rootId].children.map((id) => render(id, 0)).join('\n\n');
}

function itemizeBody(doc: DocumentModel, zoomId: NodeId): { body: string; exceededDepth: boolean } {
  const scoped = scopeDocument(doc, zoomId);
  let exceededDepth = false;
  const renderFallback = (id: NodeId, depth: number): string => {
    exceededDepth = true;
    const node = scoped.nodes[id];
    const indent = `${(depth - 4) * 13}mm`;
    const text = convertLatexText(node.text);
    const children = node.children.map((child) => renderFallback(child, depth + 1)).join('\n');
    return `\\par\\begingroup\\leftskip=${indent}\\noindent ${text}\\par\\endgroup${children ? `\n${children}` : ''}`;
  };
  const renderList = (ids: NodeId[], depth: number): string => {
    if (!ids.length) return '';
    const rows = ids.map((id) => {
      const node = scoped.nodes[id];
      if (depth > 4) return renderFallback(id, depth);
      const children = node.children.length ? `\n${renderList(node.children, depth + 1)}` : '';
      return `${'  '.repeat(depth - 1)}\\item ${convertLatexText(node.text)}${children}`;
    });
    const supported = rows.filter((row) => row.startsWith(`${'  '.repeat(depth - 1)}\\item `));
    const fallback = rows.filter((row) => !row.startsWith(`${'  '.repeat(depth - 1)}\\item `));
    return `${supported.length ? `${'  '.repeat(depth - 1)}\\begin{itemize}\n${supported.join('\n')}\n${'  '.repeat(depth - 1)}\\end{itemize}` : ''}${fallback.length ? `${supported.length ? '\n' : ''}${fallback.join('\n')}` : ''}`;
  };
  return { body: renderList(scoped.nodes[scoped.rootId].children, 1), exceededDepth };
}

export function exportLatex(doc: DocumentModel, format: LatexFormat = 'layer', zoomId: NodeId = doc.rootId): { text: string; exceededDepth: boolean } {
  const selected = format === 'layer' ? LAYER_PREAMBLE : String.raw`\documentclass[11pt,a4paper,oneside]{ltjsarticle}
\usepackage[left=16mm,right=16mm,top=18mm,bottom=18mm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage[hidelinks]{hyperref}
\usepackage{luatexja-fontspec}
\setmainjfont{HaranoAjiMincho}
\setsansjfont{HaranoAjiGothic}`;
  const body = format === 'layer' ? { body: layerBody(doc, zoomId), exceededDepth: false } : itemizeBody(doc, zoomId);
  return { text: `${selected}\n\\begin{document}\n${body.body}\n\\end{document}\n`, exceededDepth: body.exceededDepth };
}

export function appendImportedDocument(current: DocumentModel, imported: DocumentModel): DocumentModel {
  const next: DocumentModel = { ...current, nodes: Object.fromEntries(Object.entries(current.nodes).map(([id, node]) => [id, { ...node, children: [...node.children] }])) };
  const cloneBranch = (id: NodeId, parentId: NodeId) => {
    const source = imported.nodes[id];
    const cloned = newNode(source.text, source.note);
    next.nodes[cloned.id] = cloned;
    next.nodes[parentId].children.push(cloned.id);
    for (const childId of source.children) cloneBranch(childId, cloned.id);
  };
  for (const id of imported.nodes[imported.rootId].children) cloneBranch(id, current.rootId);
  return next;
}
