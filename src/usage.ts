// What the user opens: which notes, and which note after which search words. Kept on this device in
// IndexedDB, so it never syncs with the vault. When the database cannot be opened it lasts for the session.

export type UsageTable = "visits" | "queries";

export interface UsageBackend {
  all(table: UsageTable): Promise<[string, unknown][]>;
  put(table: UsageTable, key: string, value: unknown): Promise<void>;
  remove(table: UsageTable, key: string): Promise<void>;
  clear(): Promise<void>;
}

const DAY = 86_400_000;
const HALF_LIFE_DAYS = 14;
const MAX_VISITS = 64;
// Switching back and forth between open notes is one visit, not many.
const VISIT_WINDOW = 5 * 60_000;
// The same size as the boost for a recent edit: settles near-ties, never lifts a weak match over a strong one.
const VISIT_BOOST = 0.3;
const FIRST_OPEN_BOOST = 0.5;
// One open may be a misclick; from the second the note is what these words mean.
const LEARNED_OPENS = 2;
const LEARNED_SHOWN = 3;
const SEPARATOR = "\u0000";

export function usageQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

// Bodies to read first: notes before attachments, which have no body, then the notes used most, then the
// newest. Search words are most likely to be looking for these, so they should not wait for the whole vault.
export function bodyOrder<T>(files: T[], describe: (file: T) => { note: boolean; activity: number; mtime: number }): T[] {
  return files
    .map((file) => ({ file, ...describe(file) }))
    .sort((a, b) => Number(b.note) - Number(a.note) || b.activity - a.activity || b.mtime - a.mtime)
    .map(({ file }) => file);
}

export class UsageStore {
  private readonly visits = new Map<string, number[]>();
  // Search words → note path → opens.
  private readonly queries = new Map<string, Map<string, number>>();

  constructor(
    private readonly backend: UsageBackend,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    const [visits, queries] = await Promise.all([this.backend.all("visits"), this.backend.all("queries")]);
    for (const [path, times] of visits) {
      if (Array.isArray(times)) this.visits.set(path, times.filter((time) => typeof time === "number"));
    }
    for (const [key, count] of queries) {
      const cut = key.indexOf(SEPARATOR);
      if (cut > 0 && typeof count === "number") this.setOpens(key.slice(0, cut), key.slice(cut + 1), count);
    }
  }

  recordVisit(path: string): void {
    const now = this.now();
    const times = this.visits.get(path) ?? [];
    if (times.length && now - times[times.length - 1] < VISIT_WINDOW) return;
    const next = [...times, now].slice(-MAX_VISITS);
    this.visits.set(path, next);
    this.write(this.backend.put("visits", path, next));
  }

  recordOpen(query: string, path: string): void {
    const words = usageQuery(query);
    if (!words) return;
    const count = (this.queries.get(words)?.get(path) ?? 0) + 1;
    this.setOpens(words, path, count);
    this.write(this.backend.put("queries", `${words}${SEPARATOR}${path}`, count));
  }

  // How much a note is in use: its visits, each fading with time.
  activity(path: string): number {
    const now = this.now();
    let weight = 0;
    for (const time of this.visits.get(path) ?? []) weight += 0.5 ** (Math.max(0, now - time) / DAY / HALF_LIFE_DAYS);
    return weight;
  }

  // Multiplier share for a result: 0 for a note never opened, more the more often and recently it was.
  boost(query: string, path: string): number {
    const weight = this.activity(path);
    const opens = this.queries.get(usageQuery(query))?.get(path) ?? 0;
    return VISIT_BOOST * (1 - 0.5 ** weight) + (opens > 0 ? FIRST_OPEN_BOOST : 0);
  }

  // The notes these words have settled on, most opened first.
  learned(query: string): string[] {
    const notes = this.queries.get(usageQuery(query));
    if (!notes) return [];
    return [...notes]
      .filter(([, count]) => count >= LEARNED_OPENS)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, LEARNED_SHOWN)
      .map(([path]) => path);
  }

  rename(oldPath: string, newPath: string): void {
    const times = this.visits.get(oldPath);
    if (times) {
      this.visits.delete(oldPath);
      this.visits.set(newPath, times);
      this.write(this.backend.remove("visits", oldPath));
      this.write(this.backend.put("visits", newPath, times));
    }
    for (const [words, notes] of this.queries) {
      const count = notes.get(oldPath);
      if (count === undefined) continue;
      notes.delete(oldPath);
      notes.set(newPath, count);
      this.write(this.backend.remove("queries", `${words}${SEPARATOR}${oldPath}`));
      this.write(this.backend.put("queries", `${words}${SEPARATOR}${newPath}`, count));
    }
  }

  remove(path: string): void {
    if (this.visits.delete(path)) this.write(this.backend.remove("visits", path));
    for (const [words, notes] of this.queries) {
      if (notes.delete(path)) this.write(this.backend.remove("queries", `${words}${SEPARATOR}${path}`));
    }
  }

  clear(): Promise<void> {
    this.visits.clear();
    this.queries.clear();
    return this.backend.clear();
  }

  private setOpens(words: string, path: string, count: number): void {
    let notes = this.queries.get(words);
    if (!notes) this.queries.set(words, (notes = new Map()));
    notes.set(path, count);
  }

  // Memory stays right for this session when a write fails, so a failure only costs persistence.
  private write(operation: Promise<void>): void {
    operation.catch((error) => console.warn("Crisp Search: could not save usage", error));
  }
}

export const memoryBackend: UsageBackend = {
  all: () => Promise.resolve([]),
  put: () => Promise.resolve(),
  remove: () => Promise.resolve(),
  clear: () => Promise.resolve(),
};

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

export async function openUsageDatabase(name: string): Promise<IDBDatabase> {
  const open = indexedDB.open(name, 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore("visits");
    open.result.createObjectStore("queries");
  };
  return request(open);
}

export function indexedDbBackend(db: IDBDatabase): UsageBackend {
  const write = (table: UsageTable, change: (store: IDBObjectStore) => void) => {
    const tx = db.transaction(table, "readwrite");
    change(tx.objectStore(table));
    return finished(tx);
  };
  return {
    all: async (table) => {
      const store = db.transaction(table).objectStore(table);
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
      return keys.map((key, i): [string, unknown] => [String(key), values[i]]);
    },
    put: (table, key, value) => write(table, (store) => store.put(value, key)),
    remove: (table, key) => write(table, (store) => store.delete(key)),
    clear: () => {
      const tx = db.transaction(["visits", "queries"], "readwrite");
      tx.objectStore("visits").clear();
      tx.objectStore("queries").clear();
      return finished(tx);
    },
  };
}
