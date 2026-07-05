import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CrmStore } from '../src/store';
import type { Lead } from '../src/types';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'leadscout-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function lead(id: string, name = 'Test Cafe'): Lead {
  return {
    kind: 'no-website',
    business: {
      id,
      name,
      address: 'MG Road',
      googleMapsUri: '',
      types: ['cafe'],
      location: { lat: 12.9, lng: 77.6 },
    },
    leadScore: 65,
    scoreReasons: [],
    needs: ['A website'],
    pitchAngles: ['They have no site'],
  };
}

describe('CrmStore', () => {
  it('records a scan and reports new ids, then not-new on rescan', async () => {
    const store = new CrmStore(dir);
    const first = await store.recordScan([lead('a'), lead('b')], 'scan-1');
    expect(first.size).toBe(2);

    const second = await store.recordScan([lead('a'), lead('c')], 'scan-2');
    expect([...second]).toEqual(['c']); // only c is new the second time
    expect(store.get('a')?.firstSeenScan).toBe('scan-1');
    expect(store.get('a')?.lastSeenScan).toBe('scan-2');
  });

  it('persists status across store instances', async () => {
    const store = new CrmStore(dir);
    await store.recordScan([lead('a')], 'scan-1');
    await store.setStatus('a', 'won');

    const reopened = new CrmStore(dir);
    await reopened.load();
    expect(reopened.get('a')?.status).toBe('won');
  });

  it('marks contacted with a timestamp and appends notes', async () => {
    const store = new CrmStore(dir);
    await store.recordScan([lead('a')], 'scan-1');
    await store.setStatus('a', 'contacted');
    await store.addNote('a', 'Left a voicemail');
    const rec = store.get('a')!;
    expect(rec.lastContactedAt).toBeDefined();
    expect(rec.notes).toHaveLength(1);
    expect(rec.notes[0].text).toBe('Left a voicemail');
  });

  it('suppresses by name match', async () => {
    const store = new CrmStore(dir);
    await store.recordScan([lead('a', 'Corner Cafe'), lead('b', 'Other Shop')], 'scan-1');
    const n = await store.importSuppression(['corner cafe']);
    expect(n).toBe(1);
    expect(store.get('a')?.suppressed).toBe(true);
    expect(store.get('b')?.suppressed).toBe(false);
  });

  it('writes valid JSON to .crm.json', async () => {
    const store = new CrmStore(dir);
    await store.recordScan([lead('a')], 'scan-1');
    const raw = JSON.parse(await readFile(join(dir, '.crm.json'), 'utf8'));
    expect(Array.isArray(raw)).toBe(true);
    expect(raw[0].id).toBe('a');
  });
});

describe('CrmStore regressions (review fixes)', () => {
  it('addNote on a fresh instance preserves previously persisted notes', async () => {
    const a = new CrmStore(dir);
    await a.recordScan([lead('x')], 'scan-1');
    await a.addNote('x', 'first');
    await a.addNote('x', 'second');

    const fresh = new CrmStore(dir); // simulates server restart
    await fresh.addNote('x', 'third'); // first op, no explicit load()
    expect(fresh.get('x')?.notes.map((n) => n.text)).toEqual(['first', 'second', 'third']);
  });

  it('setFollowUp(id, undefined) clears an existing follow-up', async () => {
    const store = new CrmStore(dir);
    await store.recordScan([lead('x')], 'scan-1');
    await store.setFollowUp('x', '2026-01-01T00:00:00Z');
    expect(store.get('x')?.followUpAt).toBe('2026-01-01T00:00:00Z');
    await store.setFollowUp('x', undefined);
    expect(store.get('x')?.followUpAt).toBeUndefined();
  });

  it('load() throws on a corrupt store instead of silently starting empty', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, '.crm.json'), '{not json', 'utf8');
    const store = new CrmStore(dir);
    await expect(store.load()).rejects.toThrow();
  });

  it('importSuppression tolerates records without businessSnapshot', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, '.crm.json'), JSON.stringify([{ id: 'legacy' }]), 'utf8');
    const store = new CrmStore(dir);
    await store.load();
    await expect(store.importSuppression(['anything'])).resolves.toBe(0);
  });
});
