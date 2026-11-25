import { useEffect, useState } from 'react';
import { createEmptyDocument, type DocumentModel } from './model';
import { loadDocument, saveDocument } from './storage';

type SaveState = '読み込み中' | '保存中' | '保存済み' | '保存エラー';

export default function App() {
  const [document, setDocument] = useState<DocumentModel>(() => createEmptyDocument());
  const [status, setStatus] = useState<SaveState>('読み込み中');

  useEffect(() => {
    let active = true;
    loadDocument().then((loaded) => {
      if (active) { setDocument(loaded); setStatus('保存済み'); }
    }).catch(() => { if (active) setStatus('保存エラー'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (status === '読み込み中') return;
    setStatus('保存中');
    const timer = window.setTimeout(() => {
      saveDocument(document).then(() => setStatus('保存済み')).catch(() => setStatus('保存エラー'));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [document]);

  const root = document.nodes[document.rootId];
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">N</span><span>Nestline</span></div>
        <div className="save-status" aria-live="polite"><span className={`status-dot ${status === '保存エラー' ? 'error' : ''}`} />{status}</div>
      </header>
      <section className="outline" aria-label="アウトライン">
        {root.children.length === 0 ? (
          <div className="empty-state"><span className="empty-bullet">•</span><span>ここから考えを組み立てます</span></div>
        ) : null}
      </section>
    </main>
  );
}
