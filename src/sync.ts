import { isDocumentModel, type DocumentModel } from './model';

export interface SyncEnvelope {
  app: 'nestline';
  formatVersion: 1;
  updatedAt: string;
  deviceId: string;
  document: DocumentModel;
}

export function wrapDocument(document: DocumentModel, updatedAt: string, deviceId: string): SyncEnvelope {
  return { app: 'nestline', formatVersion: 1, updatedAt, deviceId, document };
}

export function unwrapEnvelope(value: unknown): SyncEnvelope | null {
  if (!value || typeof value !== 'object') return null;
  const env = value as Partial<SyncEnvelope>;
  if (env.app !== 'nestline' || env.formatVersion !== 1) return null;
  if (typeof env.updatedAt !== 'string' || Number.isNaN(Date.parse(env.updatedAt))) return null;
  if (typeof env.deviceId !== 'string') return null;
  if (!isDocumentModel(env.document)) return null;
  return env as SyncEnvelope;
}

export type SyncDecision = 'use-remote' | 'use-local' | 'in-sync' | 'conflict';

/**
 * Decide which side wins at connect time.
 * - lastSyncedAt: updatedAt of the last state both sides agreed on (null = never synced).
 * - When both sides moved since lastSyncedAt, it is a conflict; the caller keeps the
 *   newer side as main and stores the older side as a conflict copy.
 */
export function decideSync(
  localUpdatedAt: string | null,
  remoteUpdatedAt: string | null,
  lastSyncedAt: string | null,
): SyncDecision {
  if (!remoteUpdatedAt) return localUpdatedAt ? 'use-local' : 'in-sync';
  if (!localUpdatedAt) return 'use-remote';
  if (localUpdatedAt === remoteUpdatedAt) return 'in-sync';
  if (lastSyncedAt) {
    const localChanged = localUpdatedAt !== lastSyncedAt;
    const remoteChanged = remoteUpdatedAt !== lastSyncedAt;
    if (localChanged && remoteChanged) return 'conflict';
    if (remoteChanged) return 'use-remote';
    if (localChanged) return 'use-local';
    return 'in-sync';
  }
  return Date.parse(remoteUpdatedAt) > Date.parse(localUpdatedAt) ? 'use-remote' : 'use-local';
}

export function isEmptyDocument(document: DocumentModel): boolean {
  const root = document.nodes[document.rootId];
  return !root || root.children.length === 0;
}
