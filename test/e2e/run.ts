// Runs the extension against a live llama-server started with --slot-save-path:
// `node test/e2e/run.ts [model]`. Not part of `npm test`.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir, check, finish, notes, open, repo, SessionManager, waitFor } from "./harness.ts";

const manager = SessionManager.create(repo, join(agentDir, "sessions"));
let session = await open(manager);
const index = join(agentDir, "llama-kv", manager.getSessionId(), "kv.json");
const kv = () => JSON.parse(readFileSync(index, "utf8")) as Record<string, { filename: string; tokens?: number; bytes?: number }>;

const messages = () =>
  manager.getEntries().filter((entry) => entry.type === "message") as { id: string; message: { role: string } }[];
const lastOf = (role: string) => messages().filter((entry) => entry.message.role === role).at(-1)!.id;
const lastUsage = () =>
  (manager.getEntry(lastOf("assistant")) as unknown as { message: { usage: { input: number; cacheRead: number } } }).message.usage;
const restored = () => notes.some((note) => note.startsWith("KV cache restored"));

await session.prompt("We are writing a CLI in Go called logsum in cmd/logsum/main.go that sums the numbers of a log file. Answer with one short sentence.");
await session.prompt("Next, logsum must skip lines that are not numbers and report how many it skipped. Answer with one short sentence.");
const user2 = lastOf("user");
const assistant2 = lastOf("assistant");
// agent_settled comes after prompt() returns.
await new Promise((done) => setTimeout(done, 300));

await session.navigateTree(user2, { summarize: false });
check("the KV of the leaf was saved on leaving", existsSync(index) && Boolean(kv()[assistant2]));
console.log(`  saved: ${JSON.stringify(kv()[assistant2])}`);
check("a point the slot covers needs no restore", !restored(), notes);

await session.prompt("Instead of skipping them, logsum should stop at the first bad line with exit code 2. Answer with one short sentence.");
await new Promise((done) => setTimeout(done, 300));

notes.length = 0;
await session.navigateTree(assistant2, { summarize: false });
check("the abandoned branch came back from the file", restored(), notes);
await session.prompt("Add a --verbose flag. Answer with one short sentence.");
const usage = lastUsage();
console.log(`  first request after restore: ${JSON.stringify({ input: usage.input, cacheRead: usage.cacheRead })}`);
check("the next request used the restored KV", usage.cacheRead > usage.input, usage);
await new Promise((done) => setTimeout(done, 300));

// A file removed on the host is only a missed restore.
const assistant4 = lastOf("assistant");
await session.navigateTree(lastOf("user"), { summarize: false });
const index2 = kv();
index2[assistant4] = { ...index2[assistant4], filename: "gone.bin" };
writeFileSync(index, JSON.stringify(index2));
const file = manager.getSessionFile()!;
await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" } as never);
session.dispose();
notes.length = 0;
const resumed = SessionManager.open(file, join(agentDir, "sessions"));
session = await open(resumed);
await waitFor("the resume", () => notes.length > 0, 30_000);
console.log(`  after resume: ${JSON.stringify(notes)}`);
check("resume restores what covers the leaf", restored(), notes);
session.dispose();
finish();
