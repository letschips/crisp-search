// Fold Latin accents only: decomposing the whole string would also split Hangul and remove kana voicing.
const LATIN_CLUSTER = /(?![\x00-\x7f])\p{Script=Latin}\p{M}*|[A-Za-z]\p{M}+/gu;
const MARKS = /\p{M}/gu;
const NON_ASCII = /[^\x00-\x7f]/;
const EXTRA: Record<string, string> = {
  ø: "o", ł: "l", đ: "d", ð: "d", ħ: "h", ı: "i",
  ß: "ss", æ: "ae", œ: "oe", þ: "th",
};

function foldCluster(cluster: string): string {
  const plain = cluster.normalize("NFD").replace(MARKS, "");
  const replacement = EXTRA[plain.toLowerCase()];
  return replacement ?? plain;
}

// Case is kept for the engine's case-insensitive literal regex, without lowercasing whole note bodies.
export function foldAccents(text: string): string {
  return NON_ASCII.test(text) ? text.replace(LATIN_CLUSTER, foldCluster) : text;
}

export function searchText(text: string): string {
  return foldAccents(text).toLowerCase();
}

export interface MappedText {
  text: string;
  // Changed clusters only: folded start/end, original start/end (all UTF-16 offsets).
  changes: [number, number, number, number][];
}

export function mappedSearchText(original: string): MappedText {
  const changes: MappedText["changes"] = [];
  if (!NON_ASCII.test(original)) return { text: original.toLowerCase(), changes };
  let delta = 0;
  const text = original.replace(LATIN_CLUSTER, (cluster: string, at: number) => {
    const value = foldCluster(cluster);
    changes.push([at + delta, at + delta + value.length, at, at + cluster.length]);
    delta += value.length - cluster.length;
    return value;
  }).toLowerCase();
  return { text, changes };
}

export function originalRange(mapped: MappedText, start: number, end: number): [number, number] {
  const offset = (at: number, endOffset: boolean) => {
    // The last changed cluster beginning at or before this character determines its offset.
    let lo = 0;
    let hi = mapped.changes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (mapped.changes[mid][0] <= at) lo = mid + 1;
      else hi = mid;
    }
    const change = mapped.changes[lo - 1];
    if (!change) return at + Number(endOffset);
    const [, foldedEnd, originalStart, originalEnd] = change;
    if (at < foldedEnd) return endOffset ? originalEnd : originalStart;
    return at + originalEnd - foldedEnd + Number(endOffset);
  };
  return [offset(start, false), offset(end - 1, true)];
}
