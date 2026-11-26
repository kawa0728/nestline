import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { createEmptyDocument, type DocumentModel, type NodeId } from './model';
import { loadDocument, saveDocument } from './storage';
import { collapseAll, deleteSubtree, duplicateSubtree, expandAll, expandToDepth, getAncestors, getParentId, getVisibleNodes, indentNode, insertSibling, moveSibling, moveTo, outdentNode, setCollapsed, updateNodeText, type DropPosition } from './tree';
import { getFilteredVisibleNodes, type OutlineFilter } from './filter';
import { renderNode } from './render';
import { appendImportedDocument, exportJson, exportLatex, exportMarkdown, exportOpml, importJson, importMarkdown, importOpml, type LatexFormat } from './io';
import DriveSync from './DriveSync';

type SaveState = '読み込み中' | '保存中' | '保存済み' | '保存エラー';
type Snapshot = { past: DocumentModel[]; present: DocumentModel; future: DocumentModel[] };
type ImportFormat = 'markdown' | 'opml' | 'json';
type PendingImport = { document: DocumentModel; fileName: string };

function copySnapshot(doc: DocumentModel): DocumentModel {
  return { ...doc, nodes: Object.fromEntries(Object.entries(doc.nodes).map(([id, node]) => [id, { ...node, children: [...node.children] }])) };
}

export default function App() {
  const [history, setHistory] = useState<Snapshot>(() => ({ past: [], present: createEmptyDocument(), future: [] }));
  const document = history.present;
  const [status, setStatus] = useState<SaveState>('読み込み中');
  const [zoomId, setZoomId] = useState<NodeId>(() => history.present.rootId);
  const [editingId, setEditingId] = useState<NodeId | null>(null);
  const [searchText, setSearchText] = useState('');
  const [filter, setFilter] = useState<OutlineFilter | null>(null);
  const [depth, setDepth] = useState('2');
  const [dragId, setDragId] = useState<NodeId | null>(null);
  const [dropHint, setDropHint] = useState<{ id: NodeId; position: DropPosition } | null>(null);
  const inputRefs = useRef(new Map<NodeId, HTMLTextAreaElement>());
  const outlineRef = useRef<HTMLElement>(null);
  const rowRefs = useRef(new Map<NodeId, HTMLDivElement>());
  const measuredHeights = useRef(new Map<NodeId, number>());
  const searchRef = useRef<HTMLInputElement>(null);
  const saveSequenceRef = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(720);
  const [measureVersion, setMeasureVersion] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ioMenuRef = useRef<HTMLDetailsElement>(null);
  const [importFormat, setImportFormat] = useState<ImportFormat>('markdown');
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const visible = useMemo(() => filter
    ? getFilteredVisibleNodes(document, zoomId, filter, editingId)
    : getVisibleNodes(document, zoomId), [document, zoomId, filter, editingId]);
  const virtualized = visible.length > 500;
  const virtualLayout = useMemo(() => {
    const offsets = [0];
    let total = 0;
    for (const { id } of visible) {
      const node = document.nodes[id];
      const lineEstimate = Math.max(node.text.split('\n').length, Math.ceil(node.text.length / 95));
      total += measuredHeights.current.get(id) ?? Math.max(36, lineEstimate * 36);
      offsets.push(total);
    }
    return { offsets, total };
  }, [visible, document, measureVersion]);
  let virtualStart = 0;
  let virtualEnd = visible.length;
  if (virtualized) {
    const bottom = scrollTop + viewportHeight;
    while (virtualStart < visible.length && virtualLayout.offsets[virtualStart + 1] <= scrollTop) virtualStart++;
    virtualEnd = virtualStart;
    while (virtualEnd < visible.length && virtualLayout.offsets[virtualEnd] < bottom) virtualEnd++;
    virtualStart = Math.max(0, virtualStart - 12);
    virtualEnd = Math.min(visible.length, virtualEnd + 12);
  }
  const renderedRows = virtualized ? visible.slice(virtualStart, virtualEnd) : visible;
  useLayoutEffect(() => {
    if (!virtualized) return;
    const element = outlineRef.current;
    if (element) setViewportHeight(element.clientHeight || window.innerHeight);
    let changed = false;
    for (const { id } of renderedRows) {
      const row = rowRefs.current.get(id);
      if (!row) continue;
      const height = row.offsetHeight + 2;
      if (Math.abs((measuredHeights.current.get(id) ?? 0) - height) > 1) {
        measuredHeights.current.set(id, height);
        changed = true;
      }
    }
    if (changed) setMeasureVersion((value) => value + 1);
  }, [virtualized, renderedRows, editingId]);
  useEffect(() => {
    if (!virtualized) return;
    const element = outlineRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight || window.innerHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [virtualized]);
  useEffect(() => {
    if (outlineRef.current) outlineRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [zoomId, filter]);

  const commit = (next: DocumentModel) => {
    if (next === document) return;
    setHistory((current) => ({ past: [...current.past, copySnapshot(current.present)].slice(-100), present: next, future: [] }));
  };
  const replaceDocument = (next: DocumentModel) => {
    setHistory({ past: [], present: next, future: [] });
    setZoomId(next.rootId);
  };
  const focusNode = (id: NodeId | null, atEnd = false) => {
    setEditingId(id);
    if (id) requestAnimationFrame(() => {
      const element = inputRefs.current.get(id);
      element?.focus();
      if (atEnd && element) element.setSelectionRange(element.value.length, element.value.length);
    });
  };
  const clearFilter = () => { setSearchText(''); setFilter(null); };
  const updateSearch = (value: string) => {
    setSearchText(value);
    setFilter(value.trim() ? { kind: 'search', value } : null);
  };
  const activateTag = (tag: string) => { setSearchText(''); setFilter({ kind: 'tag', value: tag }); };
  const beginImport = (format: ImportFormat) => {
    setImportFormat(format);
    setPendingImport(null);
    setImportError(null);
    ioMenuRef.current?.removeAttribute('open');
    if (fileInputRef.current) { fileInputRef.current.value = ''; fileInputRef.current.click(); }
  };
  const readImportFile = async (file: File) => {
    try {
      const source = await file.text();
      const imported = importFormat === 'markdown' ? importMarkdown(source) : importFormat === 'opml' ? importOpml(source) : importJson(source);
      setPendingImport({ document: imported, fileName: file.name });
      setImportError(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'ファイルを読み込めませんでした。');
      setPendingImport(null);
    }
  };
  const applyImport = (mode: 'replace' | 'append') => {
    if (!pendingImport) return;
    if (mode === 'replace') {
      const accepted = window.confirm(`「${pendingImport.fileName}」を読み込み、現在の文書を置き換えます。続けますか？`);
      if (!accepted) return;
      commit(pendingImport.document);
      setZoomId(pendingImport.document.rootId);
    } else {
      commit(appendImportedDocument(document, pendingImport.document));
    }
    setEditingId(null);
    clearFilter();
    setPendingImport(null);
    setImportError(null);
  };
  const download = (fileName: string, content: string, mimeType: string) => {
    const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const exportFile = (format: 'markdown' | 'opml' | 'json' | 'latex', scope: 'all' | 'zoom', latexFormat: LatexFormat = 'layer') => {
    const selectedRoot = scope === 'zoom' ? zoomId : document.rootId;
    const suffix = scope === 'zoom' && zoomId !== document.rootId ? '-zoom' : '';
    if (format === 'markdown') download(`nestline${suffix}.md`, exportMarkdown(document, selectedRoot), 'text/markdown');
    if (format === 'opml') download(`nestline${suffix}.opml`, exportOpml(document, selectedRoot), 'text/xml');
    if (format === 'json') download(`nestline${suffix}.json`, exportJson(document, selectedRoot), 'application/json');
    if (format === 'latex') {
      const result = exportLatex(document, latexFormat, selectedRoot);
      if (result.exceededDepth) window.alert('itemize の4階層を超える項目があります。5階層目以降は左インデント付き段落として出力します。');
      download(`nestline${suffix}-${latexFormat}.tex`, result.text, 'application/x-tex');
    }
    ioMenuRef.current?.removeAttribute('open');
  };

  useEffect(() => {
    let active = true;
    loadDocument().then((loaded) => {
      if (active) {
        setHistory({ past: [], present: loaded, future: [] });
        setZoomId(loaded.rootId);
        setStatus('保存済み');
      }
    }).catch(() => { if (active) setStatus('保存エラー'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (status === '読み込み中') return;
    const sequence = ++saveSequenceRef.current;
    setStatus('保存中');
    const timer = window.setTimeout(() => saveDocument(document)
      .then(() => { if (sequence === saveSequenceRef.current) setStatus('保存済み'); })
      .catch(() => { if (sequence === saveSequenceRef.current) setStatus('保存エラー'); }), 250);
    return () => window.clearTimeout(timer);
  }, [document]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      const target = event.target as HTMLElement | null;
      const typing = !!target?.closest('input, textarea, [contenteditable="true"]');
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); return;
      }
      if (event.key === 'Escape') {
        if (helpOpen) { setHelpOpen(false); return; }
        if (filter) { clearFilter(); return; }
      }
      if (event.key === '?' && !typing) { event.preventDefault(); setHelpOpen((open) => !open); }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [helpOpen, filter]);

  useEffect(() => {
    if (!document.nodes[zoomId]) setZoomId(document.rootId);
  }, [document, zoomId]);

  const undo = () => setHistory((current) => {
    if (!current.past.length) return current;
    return { past: current.past.slice(0, -1), present: current.past.at(-1)!, future: [copySnapshot(current.present), ...current.future].slice(0, 100) };
  });
  const redo = () => setHistory((current) => {
    if (!current.future.length) return current;
    return { past: [...current.past, copySnapshot(current.present)].slice(-100), present: current.future[0], future: current.future.slice(1) };
  });

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>, id: NodeId) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const node = document.nodes[id];
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); event.shiftKey ? redo() : undo(); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
    if (event.ctrlKey && event.shiftKey && event.code === 'Space') {
      event.preventDefault(); commit(setCollapsed(document, id, !node.collapsed)); return;
    }
    if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); setZoomId(id); return; }
    if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); setZoomId(getParentId(document, zoomId) ?? document.rootId); return; }
    if ((event.ctrlKey || event.altKey) && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); commit(moveSibling(document, id, event.key === 'ArrowUp' ? -1 : 1)); return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const next = event.shiftKey ? outdentNode(document, id) : indentNode(document, id);
      commit(next); return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!node.text.trim()) {
        const outdented = outdentNode(document, id);
        if (outdented !== document) { commit(outdented); return; }
      }
      const inserted = insertSibling(document, id);
      if (inserted.document !== document) { commit(inserted.document); focusNode(inserted.id); }
      return;
    }
    if (event.key === 'Backspace' && node.text.length === 0) {
      event.preventDefault();
      const index = visible.findIndex((entry) => entry.id === id);
      const previous = visible[index - 1]?.id ?? null;
      const deleted = deleteSubtree(document, id);
      if (deleted.document !== document) { commit(deleted.document); focusNode(previous ?? deleted.previousId, true); }
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const index = visible.findIndex((entry) => entry.id === id);
      const target = visible[index + (event.key === 'ArrowUp' ? -1 : 1)];
      if (target) { event.preventDefault(); focusNode(target.id); }
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, targetId: NodeId, position: DropPosition) => {
    event.preventDefault();
    if (dragId && dragId !== targetId) commit(moveTo(document, dragId, targetId, position));
    setDragId(null); setDropHint(null);
  };

  const ancestors = getAncestors(document, zoomId).filter((id) => id !== document.rootId);
  const crumbIds = [document.rootId, ...ancestors, ...(zoomId !== document.rootId ? [zoomId] : [])];
  const currentRoot = document.nodes[zoomId];

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">N</span><span>Nestline</span></div>
        <div className="search-box">
          <input ref={searchRef} aria-label="ノードを検索" type="search" placeholder="検索…" value={searchText} onChange={(event) => updateSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); clearFilter(); } }} />
          {filter && <button className="clear-filter" aria-label="フィルタを解除" title="フィルタを解除 (Esc)" onClick={clearFilter}>×</button>}
        </div>
        <details className="io-menu" ref={ioMenuRef}>
          <summary>入出力</summary>
          <div className="io-dropdown">
            <div className="io-heading">Markdown</div>
            <div className="io-row"><button onClick={() => exportFile('markdown', 'all')}>全体を書き出す</button><button disabled={zoomId === document.rootId} onClick={() => exportFile('markdown', 'zoom')}>ズーム部分木</button></div>
            <div className="io-heading">OPML</div>
            <div className="io-row"><button onClick={() => exportFile('opml', 'all')}>全体を書き出す</button><button disabled={zoomId === document.rootId} onClick={() => exportFile('opml', 'zoom')}>ズーム部分木</button></div>
            <div className="io-heading">JSON</div>
            <div className="io-row"><button onClick={() => exportFile('json', 'all')}>全体を書き出す</button><button disabled={zoomId === document.rootId} onClick={() => exportFile('json', 'zoom')}>ズーム部分木</button></div>
            <div className="io-heading">LaTeX · layer</div>
            <div className="io-row"><button onClick={() => exportFile('latex', 'all', 'layer')}>全体を書き出す</button><button disabled={zoomId === document.rootId} onClick={() => exportFile('latex', 'zoom', 'layer')}>ズーム部分木</button></div>
            <div className="io-heading">LaTeX · itemize</div>
            <div className="io-row"><button onClick={() => exportFile('latex', 'all', 'itemize')}>全体を書き出す</button><button disabled={zoomId === document.rootId} onClick={() => exportFile('latex', 'zoom', 'itemize')}>ズーム部分木</button></div>
            <div className="io-heading">インポート</div>
            <div className="io-row"><button onClick={() => beginImport('markdown')}>Markdown…</button><button onClick={() => beginImport('opml')}>OPML…</button><button onClick={() => beginImport('json')}>JSON…</button></div>
          </div>
        </details>
        <input ref={fileInputRef} className="file-input-hidden" type="file" accept={importFormat === 'markdown' ? '.md,.markdown,.txt,text/markdown,text/plain' : importFormat === 'opml' ? '.opml,.xml,text/xml,application/xml' : '.json,application/json'} onChange={(event) => { const file = event.target.files?.[0]; if (file) void readImportFile(file); }} />
        <div className="save-status" aria-live="polite">{status === '保存エラー'
          ? <button className="save-error-action" onClick={() => exportFile('json', 'all')} title="現在の文書をJSONでバックアップ">保存エラー · JSONバックアップを保存</button>
          : <><span className="status-dot" />{status}</>}</div>
        <DriveSync document={document} onRemoteDocument={replaceDocument} />
      </header>
      <nav className="toolbar" aria-label="アウトライン操作">
        <div className="breadcrumbs">
          {crumbIds.map((id, index) => <span className="crumb-wrap" key={`${id}-${index}`}>
            {index > 0 && <span className="crumb-separator">/</span>}
            <button className="crumb" onClick={() => setZoomId(id)} title="この階層に戻る">{id === document.rootId ? 'すべて' : document.nodes[id]?.text || '無題'}</button>
          </span>)}
        </div>
        {filter && <div className="active-filter" role="status">{filter.kind === 'tag' ? `タグ: #${filter.value}` : `検索: ${filter.value}`} <button aria-label="フィルタを解除" onClick={clearFilter}>×</button></div>}
        <div className="toolbar-actions">
          <button onClick={undo} disabled={!history.past.length} title="Ctrl+Z">元に戻す</button>
          <button onClick={redo} disabled={!history.future.length} title="Ctrl+Shift+Z">やり直す</button>
          <span className="toolbar-divider" />
          <button onClick={() => commit(expandAll(document))}>すべて展開</button>
          <button onClick={() => commit(collapseAll(document))}>すべて折りたたむ</button>
          <label className="depth-control">深さ <input aria-label="展開する深さ" type="number" min="0" max="99" value={depth} onChange={(e) => setDepth(e.target.value)} /><button onClick={() => commit(expandToDepth(document, Math.max(0, Number(depth) || 0)))}>適用</button></label>
        </div>
      </nav>
      <section ref={outlineRef} className={`outline ${virtualized ? 'virtualized' : ''}`} aria-label="アウトライン" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} onDragOver={(e) => e.preventDefault()}>
        {visible.length === 0 && <div className="empty-state"><span className="empty-bullet">•</span><span>{filter ? '一致するノードがありません' : 'ここから考えを組み立てます'}</span></div>}
        {virtualized && <div aria-hidden="true" style={{ height: virtualLayout.offsets[virtualStart] }} />}
        {renderedRows.map(({ id, depth: level }) => {
          const node = document.nodes[id];
          const hasChildren = node.children.length > 0;
          return <div ref={(element) => { if (element) rowRefs.current.set(id, element); else rowRefs.current.delete(id); }} data-node-id={id} className={`outline-row ${dropHint?.id === id ? `drop-${dropHint.position}` : ''} ${dragId === id ? 'dragging' : ''}`} key={id} style={{ marginLeft: `${level * 24}px` }}
            onDragOver={(e) => { e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); const ratio = (e.clientY - rect.top) / rect.height; const position: DropPosition = ratio < .25 ? 'before' : ratio > .75 ? 'after' : 'child'; setDropHint({ id, position }); }}
            onDrop={(e) => handleDrop(e, id, dropHint?.id === id ? dropHint.position : 'child')}>
            <div className="row-content">
              <button className={`bullet-toggle ${hasChildren ? '' : 'leaf'}`} aria-label={hasChildren ? (node.collapsed ? '展開' : '折りたたむ') : 'ノード'} title={hasChildren ? '展開 / 折りたたみ' : ''} onClick={() => hasChildren && commit(setCollapsed(document, id, !node.collapsed))}>{hasChildren ? (node.collapsed ? '▸' : '▾') : '•'}</button>
              {editingId === id
                ? <textarea ref={(element) => { if (element) inputRefs.current.set(id, element); else inputRefs.current.delete(id); }} rows={Math.max(1, node.text.split('\n').length)} value={node.text} aria-label="ノード本文" onFocus={() => setEditingId(id)} onBlur={() => setEditingId((current) => current === id ? null : current)} onChange={(e) => commit(updateNodeText(document, id, e.target.value))} onKeyDown={(e) => handleKeyDown(e, id)} onDragOver={(e) => e.preventDefault()} />
                : <div className="node-rendered" role="textbox" aria-readonly="true" tabIndex={0} onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); focusNode(id); return; }
                  handleKeyDown(event, id);
                }} onClick={(event) => {
                  const target = event.target as HTMLElement;
                  const tag = target.closest<HTMLElement>('[data-tag]')?.dataset.tag;
                  if (tag) { event.stopPropagation(); activateTag(tag); return; }
                  if (target.closest('a')) return;
                  focusNode(id);
                }} dangerouslySetInnerHTML={{ __html: renderNode(node.text) }} />}
              <div className="row-actions">
                <button draggable title="ドラッグして移動" aria-label="ノードをドラッグして移動" className="drag-handle" onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); setDragId(id); }} onDragEnd={() => { setDragId(null); setDropHint(null); }}>⠿</button>
                <button title="この部分木にズーム" aria-label="ズーム" onClick={() => setZoomId(id)}>↗</button>
                <button title="ノードと子を複製" aria-label="ノードを複製" onClick={() => { const result = duplicateSubtree(document, id); commit(result.document); focusNode(result.id); }}>⧉</button>
                <button title="ノードと子を削除" aria-label="ノードと子を削除" onClick={() => { const index = visible.findIndex((item) => item.id === id); const result = deleteSubtree(document, id); commit(result.document); focusNode(visible[index - 1]?.id ?? result.previousId, true); }}>×</button>
              </div>
            </div>
          </div>;
        })}
        {virtualized && <div aria-hidden="true" style={{ height: Math.max(0, virtualLayout.total - virtualLayout.offsets[virtualEnd]) }} />}
        <button className="add-root" onClick={() => { const parent = currentRoot ?? document.nodes[document.rootId]; const node = { id: crypto.randomUUID(), text: '', note: '', collapsed: false, children: [] as NodeId[] }; const next = { ...document, nodes: { ...document.nodes, [node.id]: node, [parent.id]: { ...parent, children: [...parent.children, node.id] } } }; commit(next); focusNode(node.id); }}>＋ ノードを追加</button>
      </section>
      <footer className="helpbar"><span>Enter 追加 · Tab / Shift+Tab 階層変更 · Shift+Enter 改行 · Ctrl+↑↓ 並べ替え · Ctrl+Shift+Space 折りたたみ · Alt+→ ズーム · Alt+← ズーム解除</span><button onClick={() => setHelpOpen(true)}>ショートカット (?)</button></footer>
      {helpOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHelpOpen(false); }}>
        <section className="import-modal shortcut-modal" role="dialog" aria-modal="true" aria-labelledby="shortcut-title">
          <h2 id="shortcut-title">キーボードショートカット</h2>
          <dl className="shortcut-list">
            <dt>Enter</dt><dd>同じ階層に兄弟ノードを追加。空ノードでは逆インデント</dd>
            <dt>Shift+Enter</dt><dd>ノード内で改行</dd>
            <dt>Tab / Shift+Tab</dt><dd>インデント / 逆インデント</dd>
            <dt>空ノードで Backspace</dt><dd>ノードと子を削除し、前の可視ノードへ移動</dd>
            <dt>↑ / ↓</dt><dd>可視ノード間を移動</dd>
            <dt>Ctrl+↑ / ↓ または Alt+↑ / ↓</dt><dd>ノードを子ごと並べ替え</dd>
            <dt>Ctrl+Shift+Space</dt><dd>選択ノードを折りたたみ / 展開</dd>
            <dt>Alt+→ / Alt+←</dt><dd>選択ノードへズーム / 親階層へ戻る</dd>
            <dt>Ctrl+Z</dt><dd>Undo</dd>
            <dt>Ctrl+Shift+Z または Ctrl+Y</dt><dd>Redo</dd>
            <dt>Ctrl+F</dt><dd>検索欄へ移動</dd>
            <dt>Esc</dt><dd>検索 / タグフィルタを解除</dd>
            <dt>Enter または F2</dt><dd>フォーカス中の表示ノードを編集</dd>
            <dt>?</dt><dd>このヘルプを開閉</dd>
          </dl>
          <div className="modal-actions"><button className="primary-action" autoFocus onClick={() => setHelpOpen(false)}>閉じる</button></div>
        </section>
      </div>}
      {(pendingImport || importError) && <div className="modal-backdrop" role="presentation">
        <section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
          <h2 id="import-title">{pendingImport ? 'インポート方法を選択' : 'インポートできません'}</h2>
          {pendingImport ? <>
            <p><strong>{pendingImport.fileName}</strong> の内容をどう取り込みますか？</p>
            <p className="import-note">置き換えを選ぶと、現在の文書全体がファイルの内容に置き換わります。</p>
            <div className="modal-actions">
              <button className="primary-action" autoFocus onClick={() => applyImport('replace')}>置き換える…</button>
              <button onClick={() => applyImport('append')}>新規ノードとして追加</button>
              <button onClick={() => setPendingImport(null)}>キャンセル</button>
            </div>
          </> : <>
            <p>{importError}</p>
            <div className="modal-actions"><button className="primary-action" onClick={() => setImportError(null)}>閉じる</button></div>
          </>}
        </section>
      </div>}
    </main>
  );
}
