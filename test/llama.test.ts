import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pickMain, pinToMainSlot, sharedSlots, type SlotState } from "../src/llama.ts";

const idle = (id: number) => ({ id, is_processing: false });
const busy = (id: number) => ({ id, is_processing: true });

describe("pickMain", () => {
  it("starts on the lowest idle slot", () => {
    assert.equal(pickMain({}, [busy(0), idle(1), idle(2)]), 1);
  });

  it("stays on its slot across requests", () => {
    assert.equal(pickMain({ main: 2 }, [idle(0), idle(1), idle(2)]), 2);
  });

  it("moves when another client holds its slot and one is free", () => {
    const state = { main: 0 };
    assert.equal(pickMain(state, [busy(0), idle(1)]), 1);
    assert.equal(state.main, 1);
  });

  it("waits on its slot when nothing is free", () => {
    assert.equal(pickMain({ main: 0 }, [busy(0), busy(1)]), 0);
  });

  it("leaves a slot another extension took alone while another one is idle", () => {
    assert.equal(pickMain({ summary: 0 }, [idle(0), idle(1)]), 1);
  });

  it("takes the summary slot when it is the only one", () => {
    assert.equal(pickMain({ summary: 0 }, [idle(0)]), 0);
  });

  it("forgets a slot the server no longer has", () => {
    assert.equal(pickMain({ main: 3 }, [idle(0), idle(1)]), 0);
  });
});

describe("pinToMainSlot", () => {
  const llama = (baseUrl = "http://llama/v1") => ({
    model: { api: "openai-completions", baseUrl, id: "m" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
  }) as never;
  const realFetch = globalThis.fetch;
  let asked: string[];
  let answer: () => Response;

  beforeEach(() => {
    for (const key of Object.keys(sharedSlots())) delete sharedSlots()[key as keyof SlotState];
    asked = [];
    answer = () => Response.json([idle(0), idle(1)]);
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      return answer();
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("pins to the slot llama-server shows", async () => {
    assert.deepEqual(await pinToMainSlot({ model: "m" }, llama()), { model: "m", id_slot: 0 });
  });

  it("stays on the main slot once after a stopped request, without asking the server", async () => {
    await pinToMainSlot({}, llama());
    asked = [];
    sharedSlots().keep = true;
    assert.deepEqual(await pinToMainSlot({}, llama()), { id_slot: 0 });
    assert.deepEqual(asked, []);
    assert.equal(sharedSlots().keep, false);
  });

  it("stays on its slot when the status of llama-server cannot be read", async () => {
    await pinToMainSlot({}, llama());
    answer = () => {
      throw new Error("timeout");
    };
    assert.deepEqual(await pinToMainSlot({}, llama()), { id_slot: 0 });
  });

  it("sends no slot to a server without them, after a model on llama-server", async () => {
    await pinToMainSlot({}, llama());
    answer = () => new Response("", { status: 404 });
    assert.equal(await pinToMainSlot({}, llama("http://other-1/v1")), undefined);
  });

  it("sends no slot to another API", async () => {
    await pinToMainSlot({}, llama());
    const other = { ...(llama() as object), model: { api: "anthropic-messages", baseUrl: "http://other/v1", id: "m" } };
    assert.equal(await pinToMainSlot({}, other as never), undefined);
  });

  it("does not keep a slot on another server", async () => {
    await pinToMainSlot({}, llama());
    sharedSlots().keep = true;
    answer = () => new Response("", { status: 404 });
    assert.equal(await pinToMainSlot({}, llama("http://other-2/v1")), undefined);
    assert.equal(sharedSlots().keep, false);
  });

  it("asks a server without slots once", async () => {
    answer = () => new Response("", { status: 404 });
    await pinToMainSlot({}, llama("http://other-3/v1"));
    await pinToMainSlot({}, llama("http://other-3/v1"));
    assert.equal(asked.length, 1);
  });
});
