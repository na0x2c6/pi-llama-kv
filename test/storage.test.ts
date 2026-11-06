import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ancestorSessions, SavedSlots, sharedDepth } from "../src/storage.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "storage-test-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("SavedSlots", () => {
  const entry = { filename: "f.bin", fingerprint: "m:1", savedAt: "now" };

  it("is there after a restart and forgets what was deleted", async () => {
    const saved = await SavedSlots.open(root, "s1");
    await saved.set("a", entry);
    await saved.set("b", entry);
    await saved.delete("a");
    const reopened = await SavedSlots.open(root, "s1");
    assert.deepEqual([...reopened.entries.keys()], ["b"]);
  });

  it("reaches the files of the session a fork came from", async () => {
    await (await SavedSlots.open(root, "parent")).set("a", entry);
    const fork = await SavedSlots.open(root, "fork", ["parent"]);
    assert.deepEqual(fork.entries.get("a"), entry);
  });
});

describe("ancestorSessions", () => {
  it("follows parentSession up to the first session", async () => {
    const first = join(root, "first.jsonl");
    const second = join(root, "second.jsonl");
    writeFileSync(first, `${JSON.stringify({ id: "s1" })}\n{}\n`);
    writeFileSync(second, `${JSON.stringify({ id: "s2", parentSession: first })}\n`);
    assert.deepEqual(await ancestorSessions({ id: "s3", parentSession: second }), ["s2", "s1"]);
  });

  it("stops at a parent that is gone", async () => {
    assert.deepEqual(await ancestorSessions({ parentSession: join(root, "gone.jsonl") }), []);
  });
});

describe("sharedDepth", () => {
  it("is the last shared position", () => {
    assert.equal(sharedDepth(["a", "b", "c"], ["a", "b", "x"]), 1);
  });

  it("covers a path that contains the other", () => {
    assert.equal(sharedDepth(["a", "b"], ["a", "b", "c"]), 1);
  });

  it("is -1 for paths without a common root", () => {
    assert.equal(sharedDepth(["a"], ["b"]), -1);
    assert.equal(sharedDepth([], ["b"]), -1);
  });
});
