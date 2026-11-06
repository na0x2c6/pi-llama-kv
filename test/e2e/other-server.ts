// A server that has no slots and rejects what it does not know, in front of a
// live llama-server: `node test/e2e/other-server.ts [model]`.
import { createServer } from "node:http";
import { join } from "node:path";
import { agentDir, check, finish, open, repo, serverUrl, SessionManager } from "./harness.ts";

let slotQuestions = 0;
let completions = 0;
let pinned = 0;

const proxy = createServer(async (req, res) => {
  const url = req.url ?? "";
  if (!url.includes("/chat/completions")) {
    if (url.startsWith("/slots")) slotQuestions++;
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString();
  completions++;
  if ("id_slot" in JSON.parse(body)) {
    pinned++;
    res.writeHead(400).end('{"error":{"message":"unknown parameter id_slot"}}');
    return;
  }
  const upstream = await fetch(`${serverUrl}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream" });
  for await (const chunk of upstream.body!) res.write(chunk);
  res.end();
});
await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
const { port } = proxy.address() as { port: number };

const manager = SessionManager.create(repo, join(agentDir, "sessions"));
const session = await open(manager, `http://127.0.0.1:${port}`);
await session.prompt("Say hello in one short sentence.");
await session.prompt("Say goodbye in one short sentence.");
const reply = manager.getEntries().filter((entry) => entry.type === "message").at(-1) as
  | { message: { stopReason?: string } }
  | undefined;

check("both prompts were answered", completions === 2 && reply?.message.stopReason === "stop", { completions, reply });
check("no request carried a slot", pinned === 0, pinned);
check("the slots were asked about once", slotQuestions === 1, slotQuestions);

session.dispose();
proxy.close();
finish();
