/**
 * CRM persistence — a single JSON file (`<leadsRoot>/.crm.json`) keyed by
 * Business.id, holding lead status/notes/tags/follow-ups across scans. Plain
 * JSON is fine to low thousands of leads; node:sqlite is the upgrade path.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write can't corrupt the
 * store. A single process owns it; the server serialises writes through here.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CrmRecord, Lead, LeadStatus } from './types';

export class CrmStore {
  private readonly root: string;
  private readonly path: string;
  private records = new Map<string, CrmRecord>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(leadsRoot: string) {
    this.root = leadsRoot;
    this.path = join(leadsRoot, '.crm.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      // Only a genuinely-absent file may start empty. Any other read error
      // must throw: silently starting empty would let the next persist()
      // overwrite a good store with a near-empty one.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.loaded = true;
        return;
      }
      throw err;
    }
    // A file that exists but doesn't parse is corruption — refuse to proceed
    // (and therefore to overwrite it) rather than losing every record.
    const arr = JSON.parse(raw) as CrmRecord[];
    for (const r of Array.isArray(arr) ? arr : []) {
      if (r && typeof r.id === 'string') this.records.set(r.id, r);
    }
    this.loaded = true;
  }

  get(id: string): CrmRecord | undefined {
    return this.records.get(id);
  }

  all(): CrmRecord[] {
    return [...this.records.values()];
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  /** Upsert with a shallow patch; unknown ids create a fresh 'new' record. */
  async upsert(id: string, patch: Partial<CrmRecord>): Promise<CrmRecord> {
    await this.load();
    const existing = this.records.get(id);
    const merged: CrmRecord = {
      id,
      status: patch.status ?? existing?.status ?? 'new',
      tags: patch.tags ?? existing?.tags ?? [],
      notes: patch.notes ?? existing?.notes ?? [],
      // 'in' check: a present-but-undefined followUpAt means "clear it".
      followUpAt: 'followUpAt' in patch ? patch.followUpAt : existing?.followUpAt,
      lastContactedAt: patch.lastContactedAt ?? existing?.lastContactedAt,
      suppressed: patch.suppressed ?? existing?.suppressed ?? false,
      firstSeenScan: existing?.firstSeenScan ?? patch.firstSeenScan,
      lastSeenScan: patch.lastSeenScan ?? existing?.lastSeenScan,
      businessSnapshot: { ...existing?.businessSnapshot, ...patch.businessSnapshot } as CrmRecord['businessSnapshot'],
    };
    this.records.set(id, merged);
    await this.persist();
    return merged;
  }

  async setStatus(id: string, status: LeadStatus): Promise<CrmRecord> {
    const patch: Partial<CrmRecord> = { status };
    if (status === 'suppressed') patch.suppressed = true;
    if (status === 'contacted') patch.lastContactedAt = new Date().toISOString();
    return this.upsert(id, patch);
  }

  async addNote(id: string, text: string): Promise<CrmRecord> {
    await this.load(); // must see persisted notes before appending, or they're lost
    const rec = this.records.get(id);
    const notes = [...(rec?.notes ?? []), { ts: new Date().toISOString(), text }];
    return this.upsert(id, { notes });
  }

  async setFollowUp(id: string, iso: string | undefined): Promise<CrmRecord> {
    return this.upsert(id, { followUpAt: iso });
  }

  /**
   * Record every lead seen in a scan: create records for new ids, refresh the
   * business snapshot + lastSeenScan for existing ones. Returns the set of ids
   * that were brand-new (not previously in the store).
   */
  async recordScan(leads: Lead[], scanId: string): Promise<Set<string>> {
    await this.load();
    const newIds = new Set<string>();
    for (const lead of leads) {
      const id = lead.business.id;
      if (!this.records.has(id)) newIds.add(id);
      const existing = this.records.get(id);
      this.records.set(id, {
        id,
        status: existing?.status ?? 'new',
        tags: existing?.tags ?? [],
        notes: existing?.notes ?? [],
        followUpAt: existing?.followUpAt,
        lastContactedAt: existing?.lastContactedAt,
        suppressed: existing?.suppressed ?? false,
        firstSeenScan: existing?.firstSeenScan ?? scanId,
        lastSeenScan: scanId,
        businessSnapshot: {
          name: lead.business.name,
          phone: lead.business.phone,
          email: lead.business.email,
          address: lead.business.address,
          kind: lead.kind,
          leadScore: lead.leadScore,
        },
      });
    }
    await this.persist();
    return newIds;
  }

  /** Import a plain-text do-not-contact file (one name/phone per line). */
  async importSuppression(entries: string[]): Promise<number> {
    await this.load();
    let n = 0;
    for (const rec of this.records.values()) {
      const hay = `${rec.businessSnapshot?.name ?? ''} ${rec.businessSnapshot?.phone ?? ''}`.toLowerCase();
      if (entries.some((e) => e && hay.includes(e.toLowerCase()))) {
        rec.suppressed = true;
        rec.status = 'suppressed';
        n++;
      }
    }
    await this.persist();
    return n;
  }

  /** Serialise writes so concurrent callers can't interleave temp/rename. */
  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.all(), null, 2);
    const next = this.writeChain.then(async () => {
      await mkdir(this.root, { recursive: true }); // leads root may not exist yet
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, this.path);
    });
    // Keep the chain alive past a failure: callers see the rejection via
    // `next`, but the next persist() must not chain onto a rejected promise
    // (that would silently skip every future write for the process lifetime).
    this.writeChain = next.catch(() => {});
    return next;
  }
}
