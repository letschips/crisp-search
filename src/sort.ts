export type SortOrder = "recent" | "relevance" | "modified" | "created" | "name";

// Menu and settings order; the first one is the default.
export const SORT_ORDERS: Record<SortOrder, string> = {
  recent: "相关度 + 最近修改",
  relevance: "相关度",
  modified: "最近修改",
  created: "最近创建",
  name: "名称",
};

export function isSortOrder(value: unknown): value is SortOrder {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SORT_ORDERS, value);
}

interface Ranked {
  path: string;
  basename: string;
  score: number;
}

type Stat = { mtime: number; ctime: number } | undefined;

const DAY = 86_400_000;
// An edit today adds up to 30 % to the score, half as much a week later: enough to settle near-ties,
// not enough to lift a weak match over a strong one.
const RECENT_BOOST = 0.3;
const HALF_LIFE_DAYS = 7;

const names = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// The comparator for an order, or undefined for plain relevance.
export function resultOrder<T extends Ranked>(
  order: SortOrder,
  stat: (path: string) => Stat,
  now = Date.now(),
): ((a: T, b: T) => number) | undefined {
  // Each path is looked up once per sort, not on every comparison.
  const stats = new Map<string, Stat>();
  const cached = (path: string) => {
    if (!stats.has(path)) stats.set(path, stat(path));
    return stats.get(path);
  };
  const time = (key: "mtime" | "ctime") => (a: T, b: T) => (cached(b.path)?.[key] ?? 0) - (cached(a.path)?.[key] ?? 0);
  switch (order) {
    case "relevance":
      return undefined;
    case "modified":
      return time("mtime");
    case "created":
      return time("ctime");
    case "name":
      return (a, b) => names.compare(a.basename, b.basename);
    case "recent": {
      const boosted = (r: T) => {
        const age = Math.max(0, now - (cached(r.path)?.mtime ?? 0)) / DAY;
        return r.score * (1 + RECENT_BOOST * 0.5 ** (age / HALF_LIFE_DAYS));
      };
      return (a, b) => boosted(b) - boosted(a);
    }
  }
}
