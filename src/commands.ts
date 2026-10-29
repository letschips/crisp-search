import { pinyinKeys } from "./engine";

export interface CommandEntry {
  id: string;
  name: string;
}

export interface CommandMatch extends CommandEntry {
  score: number;
  ranges: [number, number][];
}

interface PreparedCommand extends CommandEntry {
  lower: string;
  initials: string;
  pinyin: string[];
}

const WORD_BOUNDARY = /[\s:：\-_/（(]/;
const RECENT_BOOST = 1.5;

function prepare(entry: CommandEntry): PreparedCommand {
  const lower = entry.name.toLowerCase();
  const words = lower.match(/[a-z0-9]+/g) ?? [];
  return { ...entry, lower, initials: words.map((w) => w[0]).join(""), pinyin: pinyinKeys(entry.name) };
}

// 3: starts a word, 2: inside a word, 1.5: pinyin or English initials from the start, 1: initials inside.
function scorePart(command: PreparedCommand, part: string, ranges: [number, number][]): number {
  const at = command.lower.indexOf(part);
  if (at !== -1) {
    ranges.push([at, at + part.length]);
    return at === 0 || WORD_BOUNDARY.test(command.lower[at - 1]) ? 3 : 2;
  }
  if (!/^[a-z0-9]+$/.test(part)) return 0;
  if (command.initials.startsWith(part) || command.pinyin.some((key) => key.startsWith(part))) return 1.5;
  return command.initials.includes(part) ? 1 : 0;
}

export class CommandIndex {
  private readonly commands: PreparedCommand[];

  constructor(entries: CommandEntry[]) {
    this.commands = entries.map(prepare);
  }

  search(query: string, recent: string[] = []): CommandMatch[] {
    const parts = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const recency = (id: string) => {
      const at = recent.indexOf(id);
      return at === -1 ? 0 : 1 - at / recent.length;
    };
    const matches: CommandMatch[] = [];
    for (const command of this.commands) {
      const ranges: [number, number][] = [];
      let score = 0;
      for (const part of parts) {
        const partScore = scorePart(command, part, ranges);
        if (partScore === 0) {
          score = -1;
          break;
        }
        score += partScore;
      }
      if (score < 0) continue;
      ranges.sort((a, b) => a[0] - b[0]);
      matches.push({ id: command.id, name: command.name, score: score + recency(command.id) * RECENT_BOOST, ranges });
    }
    return matches.sort(
      (a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name, "zh"),
    );
  }
}
