import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentModel } from './model';
import {
  DEFAULT_SYNC_FOLDER_ID,
  DriveError,
  SYNC_FILE_NAME,
  downloadFileText,
  findFile,
  requestAccessToken,
  revokeAccessToken,
  uploadFileText,
} from './drive';
import { decideSync, hashDocument, isEmptyDocument, unwrapEnvelope, wrapDocument, type SyncEnvelope } from './sync';

type ConnState = 'disconnected' | 'connecting' | 'connected' | 'syncing' | 'error';

const LS_FOLDER = 'nestline.folderId';
const LS_DEVICE = 'nestline.deviceId';
const LS_LOCAL_UPDATED = 'nestline.localUpdatedAt';
const LS_LAST_SYNCED = 'nestline.lastSyncedAt';
const LS_LAST_HASH = 'nestline.lastSyncedHash';
const LS_AUTO = 'nestline.autoConnect';
const POLL_MS = 45_000;

function readLs(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeLs(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch { /* storage may be unavailable */ }
}
function deviceId(): string {
  let id = readLs(LS_DEVICE);
  if (!id) { id = crypto.randomUUID(); writeLs(LS_DEVICE, id); }
  return id;
}
function nowIso(): string { return new Date().toISOString(); }
function conflictName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `nestline-conflict-${stamp}.json`;
}

interface Props {
  document: DocumentModel;
  onRemoteDocument: (document: DocumentModel) => void;
}

export default function DriveSync({ document, onRemoteDocument }: Props) {
  const [conn, setConn] = useState<ConnState>('disconnected');
  const [message, setMessage] = useState<string | null>(null);
  const [folderId, setFolderId] = useState<string>(() => readLs(LS_FOLDER) ?? DEFAULT_SYNC_FOLDER_ID);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const tokenRef = useRef<{ token: string; expiresAt: number } | null>(null);
  const fileIdRef = useRef<string | null>(null);
  const documentRef = useRef(document);
  documentRef.current = document;
  const appliedRemoteRef = useRef<DocumentModel | null>(null);
  const uploadTimerRef = useRef<number | null>(null);
  const connectedRef = useRef(false);
  const dirtyRef = useRef(false);
  const firstRunRef = useRef(true);
  const syncingRef = useRef(false);

  const markSynced = useCallback((doc: DocumentModel, updatedAt: string) => {
    writeLs(LS_LAST_SYNCED, updatedAt);
    writeLs(LS_LAST_HASH, hashDocument(doc));
    dirtyRef.current = false;
  }, []);

  const handleFailure = useCallback((error: unknown) => {
    if (error instanceof DriveError && error.status === 401) {
      setConn('error');
      setMessage('Google 認証の期限が切れました。「再接続」を押してください。');
      return;
    }
    setConn('error');
    setMessage(error instanceof Error ? error.message : 'Drive 同期でエラーが発生しました');
  }, []);

  // Silent-first token acquisition. Consent UI is only used when the caller
  // explicitly allows it (a user click on the connect button).
  const ensureToken = useCallback(async (allowConsent: boolean): Promise<string> => {
    const current = tokenRef.current;
    if (current && current.expiresAt - Date.now() > 60_000) return current.token;
    try {
      const fresh = await requestAccessToken('');
      tokenRef.current = fresh;
      return fresh.token;
    } catch (silentError) {
      if (!allowConsent) throw silentError;
      const fresh = await requestAccessToken('consent');
      tokenRef.current = fresh;
      return fresh.token;
    }
  }, []);

  // Run a Drive call; on 401, silently refresh the token once and retry.
  const withRetry = useCallback(async <T,>(fn: (token: string) => Promise<T>): Promise<T> => {
    const token = await ensureToken(false);
    try {
      return await fn(token);
    } catch (error) {
      if (error instanceof DriveError && error.status === 401) {
        tokenRef.current = null;
        const fresh = await ensureToken(false);
        return fn(fresh);
      }
      throw error;
    }
  }, [ensureToken]);

  const uploadNow = useCallback(async (doc: DocumentModel, updatedAt: string) => {
    const envelope = wrapDocument(doc, updatedAt, deviceId());
    const meta = await withRetry((token) =>
      uploadFileText(token, folderId, SYNC_FILE_NAME, JSON.stringify(envelope), fileIdRef.current ?? undefined));
    fileIdRef.current = meta.id;
    markSynced(doc, updatedAt);
  }, [folderId, markSynced, withRetry]);

  const saveConflictCopy = useCallback(async (envelope: SyncEnvelope) => {
    await withRetry((token) => uploadFileText(token, folderId, conflictName(), JSON.stringify(envelope)));
  }, [folderId, withRetry]);

  const applyRemote = useCallback((envelope: SyncEnvelope) => {
    appliedRemoteRef.current = envelope.document;
    writeLs(LS_LOCAL_UPDATED, envelope.updatedAt);
    markSynced(envelope.document, envelope.updatedAt);
    onRemoteDocument(envelope.document);
  }, [markSynced, onRemoteDocument]);

  const fetchRemote = useCallback(async (): Promise<SyncEnvelope | null> => {
    const meta = await withRetry((token) => findFile(token, folderId, SYNC_FILE_NAME));
    fileIdRef.current = meta?.id ?? null;
    if (!meta) return null;
    const text = await withRetry((token) => downloadFileText(token, meta.id));
    const remote = unwrapEnvelope(JSON.parse(text) as unknown);
    if (!remote) throw new Error('Drive 上の同期ファイルの形式が不正です');
    return remote;
  }, [folderId, withRetry]);

  // Full reconciliation against Drive (used on connect and on manual sync).
  const syncNow = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setConn('syncing');
    try {
      const remote = await fetchRemote();
      const localUpdated = readLs(LS_LOCAL_UPDATED);
      const lastSynced = readLs(LS_LAST_SYNCED);
      const localDoc = documentRef.current;
      // Writes made by this same device (e.g. another tab) are never conflicts.
      if (remote && remote.deviceId === deviceId()) {
        if (remote.updatedAt !== lastSynced && Date.parse(remote.updatedAt) > Date.parse(localUpdated ?? '')) {
          applyRemote(remote);
        } else if (dirtyRef.current) {
          await uploadNow(localDoc, localUpdated ?? nowIso());
        }
        setConn('connected');
        return;
      }
      const decision = decideSync(localUpdated, remote?.updatedAt ?? null, lastSynced, dirtyRef.current);
      if (decision === 'use-remote' && remote) {
        if (!lastSynced && !isEmptyDocument(localDoc)) {
          await saveConflictCopy(wrapDocument(localDoc, localUpdated ?? nowIso(), deviceId()));
          setMessage('初回接続のため、接続前のローカル文書を競合コピーとして Drive に保存しました。');
        }
        applyRemote(remote);
      } else if (decision === 'use-local') {
        const stamp = localUpdated ?? nowIso();
        writeLs(LS_LOCAL_UPDATED, stamp);
        await uploadNow(localDoc, stamp);
      } else if (decision === 'conflict' && remote) {
        const localStamp = localUpdated ?? nowIso();
        if (Date.parse(remote.updatedAt) > Date.parse(localStamp)) {
          await saveConflictCopy(wrapDocument(localDoc, localStamp, deviceId()));
          applyRemote(remote);
        } else {
          await saveConflictCopy(remote);
          await uploadNow(localDoc, localStamp);
        }
        setMessage('両側で変更があったため、新しい方を正とし、古い方を競合コピーとして Drive に保存しました。');
      } else if (remote) {
        markSynced(localDoc, remote.updatedAt);
      }
      setConn('connected');
    } finally {
      syncingRef.current = false;
    }
  }, [applyRemote, fetchRemote, markSynced, saveConflictCopy, uploadNow]);

  // Lightweight pull used by polling/focus: only applies remote when local is clean.
  const pullRemote = useCallback(async () => {
    if (!connectedRef.current || syncingRef.current) return;
    try {
      const remote = await fetchRemote();
      if (!remote) return;
      const lastSynced = readLs(LS_LAST_SYNCED);
      if (remote.updatedAt === lastSynced) return;
      if (remote.deviceId === deviceId()) return;
      if (!dirtyRef.current) {
        applyRemote(remote);
        setMessage(null);
      } else {
        setMessage('Drive 側に新しい変更があります。「今すぐ同期」を押すと取り込みます。');
      }
    } catch {
      // Polling failures stay silent; the next edit or manual sync will surface errors.
    }
  }, [applyRemote, fetchRemote]);

  // Track local edits by content hash: only real changes count as dirty.
  useEffect(() => {
    if (firstRunRef.current) { firstRunRef.current = false; return; }
    if (appliedRemoteRef.current === document) {
      appliedRemoteRef.current = null;
      return;
    }
    const lastHash = readLs(LS_LAST_HASH);
    if (lastHash && hashDocument(document) === lastHash) {
      dirtyRef.current = false;
      return;
    }
    dirtyRef.current = true;
    const stamp = nowIso();
    writeLs(LS_LOCAL_UPDATED, stamp);
    if (!connectedRef.current) return;
    if (uploadTimerRef.current) window.clearTimeout(uploadTimerRef.current);
    uploadTimerRef.current = window.setTimeout(() => {
      setConn('syncing');
      uploadNow(documentRef.current, stamp)
        .then(() => { setConn('connected'); setMessage(null); })
        .catch(handleFailure);
    }, 2000);
    return () => { if (uploadTimerRef.current) window.clearTimeout(uploadTimerRef.current); };
  }, [document, handleFailure, uploadNow]);

  const connect = useCallback(async (allowConsent: boolean) => {
    setConn('connecting');
    setMessage(null);
    try {
      await ensureToken(allowConsent);
      connectedRef.current = true;
      writeLs(LS_AUTO, '1');
      await syncNow();
      setConn('connected');
    } catch (error) {
      connectedRef.current = false;
      tokenRef.current = null;
      if (allowConsent) handleFailure(error);
      else setConn('disconnected');
    }
  }, [ensureToken, handleFailure, syncNow]);

  // Auto-connect silently on load when this device connected before.
  useEffect(() => {
    if (readLs(LS_AUTO) === '1') void connect(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While connected: poll Drive and re-check on focus/visibility.
  useEffect(() => {
    if (conn !== 'connected' && conn !== 'syncing') return;
    const interval = window.setInterval(() => void pullRemote(), POLL_MS);
    const onVisible = () => { if (window.document.visibilityState === 'visible') void pullRemote(); };
    const onFocus = () => void pullRemote();
    window.document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [conn, pullRemote]);

  const disconnect = useCallback(async () => {
    if (tokenRef.current) await revokeAccessToken(tokenRef.current.token);
    tokenRef.current = null;
    connectedRef.current = false;
    writeLs(LS_AUTO, null);
    setConn('disconnected');
    setMessage(null);
  }, []);

  const saveFolder = useCallback(() => {
    writeLs(LS_FOLDER, folderId.trim() || DEFAULT_SYNC_FOLDER_ID);
    setSettingsOpen(false);
    setMessage('同期フォルダを設定しました。再接続すると反映されます。');
  }, [folderId]);

  const isConnected = conn === 'connected' || conn === 'syncing' || conn === 'connecting';

  return (
    <div className="drive-sync" aria-live="polite">
      {!isConnected ? (
        <button className="drive-connect" onClick={() => void connect(true)}>
          {conn === 'error' ? 'Google Driveに再接続' : 'Google Driveに接続'}
        </button>
      ) : (
        <>
          <span className="drive-state">
            {conn === 'connecting' ? '接続中…' : conn === 'syncing' ? '同期中…' : 'Drive同期済み'}
          </span>
          <button onClick={() => void syncNow().catch(handleFailure)}>今すぐ同期</button>
          <button onClick={() => void disconnect()}>切断</button>
        </>
      )}
      <button className="drive-settings-toggle" aria-label="同期フォルダ設定" title="同期フォルダ設定" onClick={() => setSettingsOpen((v) => !v)}>⚙</button>
      {settingsOpen && (
        <div className="drive-settings">
          <label>
            同期フォルダ ID
            <input value={folderId} onChange={(e) => setFolderId(e.target.value)} placeholder={DEFAULT_SYNC_FOLDER_ID} />
          </label>
          <button onClick={saveFolder}>保存</button>
        </div>
      )}
      {message && <div className="drive-message" role="status">{message}</div>}
    </div>
  );
}
