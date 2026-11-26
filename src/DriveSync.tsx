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
import { decideSync, isEmptyDocument, unwrapEnvelope, wrapDocument, type SyncEnvelope } from './sync';

type ConnState = 'disconnected' | 'connecting' | 'connected' | 'syncing' | 'error';

const LS_FOLDER = 'nestline.folderId';
const LS_DEVICE = 'nestline.deviceId';
const LS_LOCAL_UPDATED = 'nestline.localUpdatedAt';
const LS_LAST_SYNCED = 'nestline.lastSyncedAt';

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
  const tokenRef = useRef<string | null>(null);
  const fileIdRef = useRef<string | null>(null);
  const documentRef = useRef(document);
  documentRef.current = document;
  const appliedRemoteRef = useRef<DocumentModel | null>(null);
  const uploadTimerRef = useRef<number | null>(null);
  const connectedRef = useRef(false);

  const uploadNow = useCallback(async (doc: DocumentModel, updatedAt: string) => {
    const token = tokenRef.current;
    if (!token) return;
    const envelope = wrapDocument(doc, updatedAt, deviceId());
    const meta = await uploadFileText(token, folderId, SYNC_FILE_NAME, JSON.stringify(envelope), fileIdRef.current ?? undefined);
    fileIdRef.current = meta.id;
    writeLs(LS_LAST_SYNCED, updatedAt);
  }, [folderId]);

  const handleFailure = useCallback((error: unknown) => {
    if (error instanceof DriveError && error.status === 401) {
      tokenRef.current = null;
      connectedRef.current = false;
      setConn('error');
      setMessage('Google 認証の期限が切れました。再接続してください。');
      return;
    }
    setConn('error');
    setMessage(error instanceof Error ? error.message : 'Drive 同期でエラーが発生しました');
  }, []);

  const firstRunRef = useRef(true);

  // Track local edits; debounce-upload while connected.
  // The first run is just the mount (initial IndexedDB load): do not stamp it,
  // otherwise a fresh device would look "newer" than the Drive copy.
  useEffect(() => {
    if (firstRunRef.current) { firstRunRef.current = false; return; }
    if (appliedRemoteRef.current === document) {
      appliedRemoteRef.current = null;
      return;
    }
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
  }, [document, uploadNow, handleFailure]);

  const applyRemote = useCallback((envelope: SyncEnvelope) => {
    appliedRemoteRef.current = envelope.document;
    writeLs(LS_LOCAL_UPDATED, envelope.updatedAt);
    writeLs(LS_LAST_SYNCED, envelope.updatedAt);
    onRemoteDocument(envelope.document);
  }, [onRemoteDocument]);

  const saveConflictCopy = useCallback(async (envelope: SyncEnvelope) => {
    const token = tokenRef.current;
    if (!token) return;
    await uploadFileText(token, folderId, conflictName(), JSON.stringify(envelope));
  }, [folderId]);

  const connect = useCallback(async () => {
    setConn('connecting');
    setMessage(null);
    try {
      const token = await requestAccessToken(true);
      tokenRef.current = token;
      const meta = await findFile(token, folderId, SYNC_FILE_NAME);
      fileIdRef.current = meta?.id ?? null;
      let remote: SyncEnvelope | null = null;
      if (meta) {
        const text = await downloadFileText(token, meta.id);
        remote = unwrapEnvelope(JSON.parse(text) as unknown);
        if (!remote) throw new Error('Drive 上の同期ファイルの形式が不正です');
      }
      const localUpdated = readLs(LS_LOCAL_UPDATED);
      const lastSynced = readLs(LS_LAST_SYNCED);
      const localDoc = documentRef.current;
      const decision = decideSync(localUpdated, remote?.updatedAt ?? null, lastSynced);
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
        writeLs(LS_LAST_SYNCED, remote.updatedAt);
      }
      connectedRef.current = true;
      setConn('connected');
    } catch (error) {
      tokenRef.current = null;
      connectedRef.current = false;
      handleFailure(error);
    }
  }, [applyRemote, folderId, handleFailure, saveConflictCopy, uploadNow]);

  const disconnect = useCallback(async () => {
    if (tokenRef.current) await revokeAccessToken(tokenRef.current);
    tokenRef.current = null;
    connectedRef.current = false;
    setConn('disconnected');
    setMessage(null);
  }, []);

  const saveFolder = useCallback(() => {
    writeLs(LS_FOLDER, folderId.trim() || DEFAULT_SYNC_FOLDER_ID);
    setSettingsOpen(false);
    setMessage('同期フォルダを設定しました。再接続すると反映されます。');
  }, [folderId]);

  return (
    <div className="drive-sync" aria-live="polite">
      {conn === 'disconnected' || conn === 'error' ? (
        <button className="drive-connect" onClick={() => void connect()}>
          Google Driveに接続
        </button>
      ) : (
        <>
          <span className="drive-state">
            {conn === 'connecting' ? '接続中…' : conn === 'syncing' ? '同期中…' : 'Drive同期済み'}
          </span>
          <button onClick={() => void connect()}>今すぐ同期</button>
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
