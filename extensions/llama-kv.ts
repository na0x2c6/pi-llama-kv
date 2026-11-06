// Saves llama-server's KV cache when the conversation leaves a point of the
// session tree, and restores it on the way back.
//
// Saving stops the server for as long as the file takes, and a file is
// hundreds of MiB, so it happens when leaving a branch and when exiting, not
// every turn. A file holds the context checkpoints of its slot too, which
// lets the server roll back to the earlier points of that path.
//
// The server cannot delete or list its files: bounding them is up to the host
// (see README).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { llamaServer, pickMain, pinToMainSlot, sharedSlots } from "../src/llama.ts";
import { ancestorSessions, SavedSlots, sharedDepth } from "../src/storage.ts";

export default function (pi: ExtensionAPI) {
  let saved: SavedSlots | undefined;
  // The point of the conversation the main slot holds, once known.
  let held: string | undefined;

  const pathTo = (ctx: ExtensionContext, id: string | null | undefined): string[] =>
    id ? ctx.sessionManager.getBranch(id).map((entry) => entry.id) : [];

  const save = async (ctx: ExtensionContext) => {
    const entry = held;
    const slot = sharedSlots().main;
    if (!entry || slot === undefined || !saved) return;
    const server = await llamaServer(ctx);
    const identity = await server?.identity();
    if (!server || !identity || saved.entries.get(entry)?.fingerprint === identity.fingerprint) return;
    const filename = `pi-${ctx.sessionManager.getSessionId()}-${entry}.bin`;
    // The server saves a slot once it is idle: anything else on it can stop.
    pi.events.emit("llama-kv:saving", entry);
    try {
      const result = await server.save(slot, filename);
      await saved.set(entry, {
        filename,
        ...identity,
        tokens: result.n_saved as number | undefined,
        bytes: result.n_written as number | undefined,
        savedAt: new Date().toISOString(),
      });
    } catch (err) {
      ctx.ui.notify(`KV cache not saved: ${err}`, "warning");
    }
  };

  // A compaction on the path rewrites the context: only what was saved after
  // it matches.
  const lastCompaction = (ctx: ExtensionContext, path: string[]): number =>
    path.findLastIndex((id) => ctx.sessionManager.getEntry(id)?.type === "compaction");

  const restore = async (ctx: ExtensionContext) => {
    if (!saved || saved.entries.size === 0) return;
    const path = pathTo(ctx, ctx.sessionManager.getLeafId());
    if (path.length === 0) return;
    const server = await llamaServer(ctx);
    const slots = await server?.slots();
    const identity = await server?.identity();
    if (!server || !slots || !identity) return;

    const floor = Math.max(lastCompaction(ctx, path), held ? sharedDepth(path, pathTo(ctx, held)) : -1);
    const candidates = [...saved.entries]
      .filter(([, file]) => file.fingerprint === identity.fingerprint)
      .map(([entry, file]) => ({
        entry,
        filename: file.filename,
        otherBuild: file.build !== identity.build,
        depth: sharedDepth(path, pathTo(ctx, entry)),
      }))
      .filter((candidate) => candidate.depth > floor)
      .sort((a, b) => b.depth - a.depth);

    const slot = pickMain(sharedSlots(), slots);
    let freed = false;
    for (const { entry, filename, otherBuild } of candidates) {
      try {
        // The error is the same for a missing file and for a shared KV pool
        // that the other slots leave no room in. A file of another build may
        // just be of an older format, not worth the cache of the other slots.
        const result = await server.restore(slot, filename).catch(async (err) => {
          held = undefined;
          if (freed || otherBuild) throw err;
          freed = true;
          for (const other of slots) {
            if (other.id !== slot && !other.is_processing) await server.erase(other.id);
          }
          return server.restore(slot, filename);
        });
        held = entry;
        const ms = (result.timings as { restore_ms?: number } | undefined)?.restore_ms;
        const origin = otherBuild ? ", saved by another build of llama-server" : "";
        ctx.ui.notify(`KV cache restored: ${result.n_restored} tokens in ${Math.round(ms ?? 0)} ms${origin}`, "info");
        return;
      } catch (err) {
        // Removed on the host or of an older format, most likely.
        await saved.delete(entry);
        ctx.ui.notify(`KV cache not restored: ${err}`, "warning");
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    const ancestors = await ancestorSessions(ctx.sessionManager.getHeader());
    saved = await SavedSlots.open(join(getAgentDir(), "llama-kv"), id, ancestors);
    held = undefined;
    await restore(ctx);
  });

  pi.on("before_provider_request", (event, ctx) => pinToMainSlot(event.payload, ctx));

  pi.on("agent_settled", (_event, ctx) => {
    held = ctx.sessionManager.getLeafId() ?? undefined;
  });

  pi.on("session_before_tree", async (_event, ctx) => {
    await save(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restore(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await save(ctx);
  });
}
