// Google Drive access for Nestline sync.
// Auth: Google Identity Services token flow (access token kept in memory only).
// Scope note: this build requests the full Drive scope so the app can use the
// designated "Nestline" folder (60_開発/Nestline) that was created outside the app.
// Tightening path: switch to drive.file + Google Picker (needs an API key) later.
export const GOOGLE_CLIENT_ID: string =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_GOOGLE_CLIENT_ID
  ?? '522315552208-o35nb4b5i45ajb7oksd4ae9kcc11qthg.apps.googleusercontent.com';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const DEFAULT_SYNC_FOLDER_ID = '1spwJJDE8k6RZ36j93yKoJR7j73GJez9H'; // 60_開発/Nestline
export const SYNC_FILE_NAME = 'nestline-document.json';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const API_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

interface TokenResponse { access_token?: string; error?: string }
interface TokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void;
}
interface GisOAuth2 {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    callback: (response: TokenResponse) => void;
    error_callback?: (error: unknown) => void;
  }) => TokenClient;
  revoke: (token: string, done?: () => void) => void;
}

let gisPromise: Promise<GisOAuth2> | null = null;

function loadGis(): Promise<GisOAuth2> {
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const google = (window as unknown as { google?: { accounts: { oauth2: GisOAuth2 } } }).google;
      if (google?.accounts?.oauth2) { resolve(google.accounts.oauth2); return; }
      const script = document.createElement('script');
      script.src = GIS_SRC;
      script.async = true;
      script.onload = () => {
        const loaded = (window as unknown as { google?: { accounts: { oauth2: GisOAuth2 } } }).google;
        if (loaded?.accounts?.oauth2) resolve(loaded.accounts.oauth2);
        else reject(new Error('Google Identity Services の読み込みに失敗しました'));
      };
      script.onerror = () => reject(new Error('Google Identity Services の読み込みに失敗しました'));
      document.head.appendChild(script);
    });
  }
  return gisPromise;
}

export async function requestAccessToken(interactive: boolean): Promise<string> {
  const oauth2 = await loadGis();
  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.access_token) resolve(response.access_token);
        else reject(new Error(response.error ?? 'アクセストークンを取得できませんでした'));
      },
      error_callback: () => reject(new Error('Google 認証がキャンセルされました')),
    });
    client.requestAccessToken({ prompt: interactive ? 'consent' : '' });
  });
}

export async function revokeAccessToken(token: string): Promise<void> {
  try {
    const oauth2 = await loadGis();
    oauth2.revoke(token);
  } catch { /* revocation is best-effort */ }
}

export class DriveError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function driveFetch(token: string, url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    throw new DriveError(response.status, `Drive API エラー (${response.status})`);
  }
  return response;
}

export interface DriveFileMeta { id: string; name: string }

export async function findFile(token: string, folderId: string, name: string): Promise<DriveFileMeta | null> {
  const q = `name = '${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`;
  const params = new URLSearchParams({ q, fields: 'files(id,name)', pageSize: '1' });
  const response = await driveFetch(token, `${API_BASE}/files?${params.toString()}`);
  const data = (await response.json()) as { files?: DriveFileMeta[] };
  return data.files?.[0] ?? null;
}

export async function downloadFileText(token: string, fileId: string): Promise<string> {
  const response = await driveFetch(token, `${API_BASE}/files/${fileId}?alt=media`);
  return response.text();
}

export async function uploadFileText(
  token: string,
  folderId: string,
  name: string,
  text: string,
  existingId?: string,
): Promise<DriveFileMeta> {
  const boundary = `nestline-${Math.random().toString(36).slice(2)}`;
  const metadata = existingId
    ? { name, mimeType: 'application/json' }
    : { name, mimeType: 'application/json', parents: [folderId] };
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: application/json',
    '',
    text,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const url = existingId
    ? `${UPLOAD_BASE}/files/${existingId}?uploadType=multipart&fields=id,name`
    : `${UPLOAD_BASE}/files?uploadType=multipart&fields=id,name`;
  const response = await driveFetch(token, url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return (await response.json()) as DriveFileMeta;
}
