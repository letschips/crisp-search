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
