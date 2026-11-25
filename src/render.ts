import DOMPurify from 'dompurify';
import katex from 'katex';
import { marked } from 'marked';

export type HtmlSanitizer = (html: string) => string;

const escapeHtml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

function mathHtml(raw: string, displayMode: boolean): string {
  try {
    const rendered = katex.renderToString(raw, { displayMode, throwOnError: true, trust: false, maxExpand: 1000 });
    return displayMode ? `<div class="math-block">${rendered}</div>` : rendered;
  } catch {
    const source = displayMode ? `$$${raw}$$` : `$${raw}$`;
    return `<span class="math-error">${escapeHtml(source)}</span>`;
  }
}

/** Pure HTML generation before the required sanitization stage; exported for unit tests. */
export function renderNodeHtml(text: string): string {
  const codeBlock = text.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/);
  if (codeBlock) return `<pre class="code-node"><code>${escapeHtml(codeBlock[1])}</code></pre>`;

  const blockMath = text.match(/^\s*\$\$([\s\S]*?)\$\$\s*$/);
  if (blockMath) return mathHtml(blockMath[1], true);

  const substitutions: string[] = [];
  const placeholder = () => `NESTLINEPLACEHOLDER${substitutions.length}END`;
  let source = text.replace(/(?<!\\)(`+)(.+?)\1(?!`)/g, (_match, _ticks: string, code: string) => {
    const token = placeholder();
    substitutions.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });
  source = source.replace(/(?<!\\)\$(?!\s)([^\n$]+?)(?<!\\)\$/g, (_match, formula: string) => {
    const token = placeholder();
    substitutions.push(mathHtml(formula, false));
    return token;
  });
  source = source.replace(/(^|[^\p{L}\p{M}\p{N}_-])#([\p{L}\p{M}\p{N}_-]+)/gmu, (_match, boundary: string, tag: string) => {
    const token = placeholder();
    const escaped = escapeHtml(tag);
    substitutions.push(`<button type="button" class="tag-token" data-tag="${escaped}">#${escaped}</button>`);
    return `${boundary}${token}`;
  });

  // Markdown's raw HTML support is deliberately disabled before parsing.
  source = source.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  let html = marked.parseInline(source, { gfm: true, async: false }) as string;
  html = html.replace(/NESTLINEPLACEHOLDER(\d+)END/g, (_match, index: string) => substitutions[Number(index)] ?? '');
  return html;
}

const defaultSanitizer: HtmlSanitizer = (html) => DOMPurify.sanitize(html, {
  USE_PROFILES: { html: true },
  ADD_ATTR: ['data-tag'],
});

/** Render a node and sanitize all Markdown, tag, and KaTeX markup before it reaches the DOM. */
export function renderNode(text: string, sanitize: HtmlSanitizer = defaultSanitizer): string {
  return sanitize(renderNodeHtml(text));
}
