// Which slot files exist for which entries, under
// <agent dir>/llama-kv/<session id>/kv.json. The files themselves are only
// reachable through the server, which may be another machine.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_LINEAGE = 32;

interface Header {
  id?: string;
  parentSession?: string;
}

// The sessions a session was forked from, nearest first. Entries keep their
// ids in a fork, so what the parents saved still applies.
export async function ancestorSessions(header: Header | null): Promise<string[]> {
  const ids: string[] = [];
  let parent = header?.parentSession;
  while (parent && ids.length < MAX_LINEAGE) {
    let first: Header;
    try {
      first = JSON.parse((await readFile(parent, "utf8")).split("\n", 1)[0]) as Header;
    } catch {
      break;
    }
    if (!first.id) break;
    ids.push(first.id);
    parent = first.parentSession;
  }
  return ids;
}

// The position of the last entry two paths share, -1 if none. Each path runs
// from the root.
export function sharedDepth(a: string[], b: string[]): number {
  let depth = -1;
  while (depth + 1 < a.length && depth + 1 < b.length && a[depth + 1] === b[depth + 1]) depth++;
  return depth;
}

export interface SavedSlot {
  filename: string;
  fingerprint: string;
  build?: string;
  tokens?: number;
  bytes?: number;
  savedAt: string;
}

export class SavedSlots {
  private readonly file: string;
  readonly entries: Map<string, SavedSlot>;

  private constructor(file: string, entries: Map<string, SavedSlot>) {
    this.file = file;
    this.entries = entries;
  }

  static async open(root: string, sessionId: string, ancestors: string[] = []): Promise<SavedSlots> {
    const dir = join(root, sessionId);
    await mkdir(dir, { recursive: true });
    const entries = new Map<string, SavedSlot>();
    for (const id of [sessionId, ...ancestors]) {
      const text = await readFile(join(root, id, "kv.json"), "utf8").catch(() => "{}");
      for (const [entry, saved] of Object.entries(JSON.parse(text) as Record<string, SavedSlot>)) {
        if (!entries.has(entry)) entries.set(entry, saved);
      }
    }
    return new SavedSlots(join(dir, "kv.json"), entries);
  }

  private flush(): Promise<void> {
    return writeFile(this.file, JSON.stringify(Object.fromEntries(this.entries), null, 2));
  }

  async set(entry: string, saved: SavedSlot): Promise<void> {
    this.entries.set(entry, saved);
    await this.flush();
  }

  async delete(entry: string): Promise<void> {
    this.entries.delete(entry);
    await this.flush();
  }
}
