// Characters a file name cannot hold, plus those that break a [[link]].
const UNSAFE_NAME = /[\\/:*?"<>|#^[\]]/g;

export function noteName(query: string): string {
  return query.replace(UNSAFE_NAME, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 200).trim();
}

// The name to offer for a new note, or "" when there is none or a Markdown note anywhere already has it.
// Checked against every file, not the results on screen. An attachment's bare name does not count, but its
// full file name does: "photo.png" means that image, not a new note called "photo.png".
export function newNoteName(query: string, files: { basename: string; extension: string }[]): string {
  const name = noteName(query);
  const lower = name.toLowerCase();
  const typed = query.trim().toLowerCase();
  const taken = (file: { basename: string; extension: string }) => {
    const base = file.basename.toLowerCase();
    return (file.extension === "md" && base === lower) || `${base}.${file.extension.toLowerCase()}` === typed;
  };
  return name && !files.some(taken) ? name : "";
}

// Copy markers the system or the user appends: "方案 1", "方案 copy", "方案 副本", "方案 (2)".
const COPY_SUFFIX = /[\s_-]*(?:copy|副本|[(（]?\d{1,2}[)）]?)$/i;
const WORD = /[\p{L}\p{N}]+/gu;
const CONTAINED_MIN_LENGTH = 4;
const CONTAINED_MIN_RATIO = 0.6;

function nameWords(name: string): string[] {
  return name.normalize("NFKC").toLowerCase().replace(COPY_SUFFIX, "").match(WORD) ?? [];
}

// 3: the same name but for spacing, punctuation or a copy marker. 2: the same words in another order.
// 1: one name holds most of the other. 0: unrelated.
export function nameCloseness(a: string, b: string): number {
  const wordsA = nameWords(a);
  const wordsB = nameWords(b);
  const joinedA = wordsA.join("");
  const joinedB = wordsB.join("");
  if (!joinedA || !joinedB) return 0;
  if (joinedA === joinedB) return 3;
  if ([...wordsA].sort().join(" ") === [...wordsB].sort().join(" ")) return 2;
  const [short, long] = joinedA.length <= joinedB.length ? [joinedA, joinedB] : [joinedB, joinedA];
  return short.length >= CONTAINED_MIN_LENGTH && short.length / long.length >= CONTAINED_MIN_RATIO && long.includes(short) ? 1 : 0;
}
