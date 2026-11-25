import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { createEmptyDocument, type DocumentModel, type NodeId } from './model';
import { loadDocument, saveDocument } from './storage';
import { collapseAll, deleteSubtree, duplicateSubtree, expandAll, expandToDepth, getAncestors, getParentId, getVisibleNodes, indentNode, insertSibling, moveSibling, moveTo, outdentNode, setCollapsed, updateNodeText, type DropPosition } from './tree';
import { getFilteredVisibleNodes, type OutlineFilter } from './filter';
import { renderNode } from './render';

type SaveState = '読み込み中' | '保存中' | '保存済み' | '保存エラー';
type Snapshot = { past: DocumentModel[]; present: DocumentModel; future: DocumentModel[] };

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
  const visible = useMemo(() => filter
    ? getFilteredVisibleNodes(document, zoomId, filter, editingId)
    : getVisibleNodes(document, zoomId), [document, zoomId, filter, editingId]);

  const commit = (next: DocumentModel) => {
    if (next === document) return;
    setHistory((current) => ({ past: [...current.past, copySnapshot(current.present)].slice(-100), present: next, future: [] }));
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
    setStatus('保存中');
    const timer = window.setTimeout(() => saveDocument(document).then(() => setStatus('保存済み')).catch(() => setStatus('保存エラー')), 250);
    return () => window.clearTimeout(timer);
  }, [document]);

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
          <input aria-label="ノードを検索" type="search" placeholder="検索…" value={searchText} onChange={(event) => updateSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); clearFilter(); } }} />
          {filter && <button className="clear-filter" aria-label="フィルタを解除" title="フィルタを解除 (Esc)" onClick={clearFilter}>×</button>}
        </div>
        <div className="save-status" aria-live="polite"><span className={`status-dot ${status === '保存エラー' ? 'error' : ''}`} />{status}</div>
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
      <section className="outline" aria-label="アウトライン" onDragOver={(e) => e.preventDefault()}>
        {visible.length === 0 && <div className="empty-state"><span className="empty-bullet">•</span><span>{filter ? '一致するノードがありません' : 'ここから考えを組み立てます'}</span></div>}
        {visible.map(({ id, depth: level }) => {
          const node = document.nodes[id];
          const hasChildren = node.children.length > 0;
          return <div className={`outline-row ${dropHint?.id === id ? `drop-${dropHint.position}` : ''} ${dragId === id ? 'dragging' : ''}`} key={id} style={{ marginLeft: `${level * 24}px` }}
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
            {hasChildren && !node.collapsed && node.children.map((childId) => <div key={`drop-before-${childId}`} className="drop-target before" onDragOver={(e) => { e.preventDefault(); setDropHint({ id: childId, position: 'before' }); }} onDrop={(e) => handleDrop(e, childId, 'before')} />)}
          </div>;
        })}
        <button className="add-root" onClick={() => { const parent = currentRoot ?? document.nodes[document.rootId]; const node = { id: crypto.randomUUID(), text: '', note: '', collapsed: false, children: [] as NodeId[] }; const next = { ...document, nodes: { ...document.nodes, [node.id]: node, [parent.id]: { ...parent, children: [...parent.children, node.id] } } }; commit(next); focusNode(node.id); }}>＋ ノードを追加</button>
      </section>
      <footer className="helpbar">Enter 追加 · Tab / Shift+Tab 階層変更 · Shift+Enter 改行 · Ctrl+↑↓ 並べ替え · Ctrl+Shift+Space 折りたたみ · Alt+→ ズーム · Alt+← ズーム解除</footer>
    </main>
  );
}
