/**
 * Generic id-keyed JSON collection with atomic writes.
 *
 * Same persistence contract as CrmStore (src/store.ts): a single file, loaded
 * once into a Map, written back atomically (temp file + rename) through a
 * serialised promise chain so concurrent callers can't interleave. A file that
 * exists but doesn't parse is treated as corruption and throws — refusing to
 * proceed rather than overwriting a good store with an empty one.
 *
 * Used for the auth/billing stores (users, plans, subscriptions, orders).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class JsonStore<T extends { id: string }> {
  private readonly path: string;
  private records = new Map<string, T>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.path = filePath;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      // A genuinely-absent file may start empty; any other read error must
      // throw so the next persist() can't clobber an unreadable-but-present store.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.loaded = true;
        return;
      }
      throw err;
    }
    const arr = JSON.parse(raw) as T[];
    for (const r of Array.isArray(arr) ? arr : []) {
      if (r && typeof r.id === 'string') this.records.set(r.id, r);
    }
    this.loaded = true;
  }

  get(id: string): T | undefined {
    return this.records.get(id);
  }

  all(): T[] {
    return [...this.records.values()];
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  find(pred: (r: T) => boolean): T | undefined {
    return this.all().find(pred);
  }

  filter(pred: (r: T) => boolean): T[] {
    return this.all().filter(pred);
  }

  /** Insert or replace by id, then flush to disk atomically. */
  async put(rec: T): Promise<T> {
    await this.load();
    this.records.set(rec.id, rec);
    await this.persist();
    return rec;
  }

  async delete(id: string): Promise<boolean> {
    await this.load();
    const existed = this.records.delete(id);
    if (existed) await this.persist();
    return existed;
  }

  /** Serialise writes so concurrent callers can't interleave temp/rename. */
  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.all(), null, 2);
    const next = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true }); // data dir may not exist yet
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, this.path);
    });
    // Keep the chain alive past a failure: the next persist() must not chain
    // onto a rejected promise (that would skip every future write for the process).
    this.writeChain = next.catch(() => {});
    return next;
  }
}
