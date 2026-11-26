import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from './model';
import { decideSync, unwrapEnvelope, wrapDocument } from './sync';

const t1 = '2026-11-26T00:00:00.000Z';
const t2 = '2026-11-26T01:00:00.000Z';
const t3 = '2026-11-26T02:00:00.000Z';

describe('sync envelope', () => {
  it('round-trips a document', () => {
    const doc = createEmptyDocument();
    const env = wrapDocument(doc, t1, 'device-a');
    expect(unwrapEnvelope(JSON.parse(JSON.stringify(env)))).toEqual(env);
  });
  it('rejects foreign payloads', () => {
    expect(unwrapEnvelope(null)).toBeNull();
    expect(unwrapEnvelope({ app: 'other', formatVersion: 1, updatedAt: t1, deviceId: 'x', document: createEmptyDocument() })).toBeNull();
    expect(unwrapEnvelope({ app: 'nestline', formatVersion: 1, updatedAt: 'not-a-date', deviceId: 'x', document: createEmptyDocument() })).toBeNull();
  });
});

describe('decideSync', () => {
  it('uploads when remote is missing', () => {
    expect(decideSync(t1, null, null)).toBe('use-local');
    expect(decideSync(null, null, null)).toBe('in-sync');
  });
  it('downloads when local has never been stamped', () => {
    expect(decideSync(null, t1, null)).toBe('use-remote');
  });
  it('is in sync when timestamps match', () => {
    expect(decideSync(t2, t2, t1)).toBe('in-sync');
  });
  it('follows the side that changed since the last sync', () => {
    expect(decideSync(t1, t2, t1)).toBe('use-remote');
    expect(decideSync(t2, t1, t1)).toBe('use-local');
  });
  it('flags a conflict when both sides changed since the last sync', () => {
    expect(decideSync(t2, t3, t1)).toBe('conflict');
    expect(decideSync(t3, t2, t1)).toBe('conflict');
  });
  it('without a sync baseline, the newer timestamp wins', () => {
    expect(decideSync(t1, t2, null)).toBe('use-remote');
    expect(decideSync(t2, t1, null)).toBe('use-local');
  });
});
