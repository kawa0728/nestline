import { describe, expect, it, vi } from 'vitest';
import { renderNode, renderNodeHtml } from './render';

describe('node rendering', () => {
  it('renders supported Markdown and exposes tags as filter buttons', () => {
    const html = renderNodeHtml('**bold** *italic* _emphasis_ `code` [link](https://example.com) ~~gone~~ #chemistry');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('<del>gone</del>');
    expect(html).toContain('data-tag="chemistry"');
    expect(renderNodeHtml('#tag at line start')).toContain('data-tag="tag"');
    expect(renderNodeHtml('# this is plain text')).toContain('# this is plain text');
  });

  it('protects inline math before Markdown parsing and supports block math', () => {
    const inline = renderNodeHtml('$E=mc^2$ は **重要**');
    expect(inline).toContain('class="katex"');
    expect(inline).toContain('<strong>重要</strong>');
    expect(inline).not.toContain('$E=mc^2$');
    const block = renderNodeHtml('$$\\frac{a}{b}$$');
    expect(block).toContain('class="math-block"');
    expect(block).toContain('katex-display');
  });

  it('shows malformed math as red raw text and keeps code nodes unformatted', () => {
    const invalid = renderNodeHtml('$\\frac{1}$');
    expect(invalid).toContain('class="math-error"');
    expect(invalid).toContain('$\\frac{1}$');
    const code = renderNodeHtml('```\n**raw** $x$ <script>\n```');
    expect(code).toContain('class="code-node"');
    expect(code).toContain('**raw** $x$ &lt;script&gt;');
    expect(code).not.toContain('<strong>');
  });

  it('passes the complete generated markup through the sanitizer', () => {
    const sanitizer = vi.fn((html: string) => html.replace('<script>alert(1)</script>', ''));
    const html = renderNode('<script>alert(1)</script> **safe**', sanitizer);
    expect(sanitizer).toHaveBeenCalledOnce();
    expect(html).not.toContain('<script>');
    expect(html).toContain('<strong>safe</strong>');
  });
});
