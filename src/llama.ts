// llama-server's slots.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface Slot {
  id: number;
  is_processing: boolean;
}

const STATUS_TIMEOUT_MS = 5_000;
// Writes the whole KV cache of a slot, while the server does nothing else.
const TRANSFER_TIMEOUT_MS = 180_000;

// Servers that said they have no slots, for as long as pi runs: the question
// would otherwise go out with the key before every request.
const withoutSlots = new Set<string>();

export interface ServerIdentity {
  fingerprint: string;
  build?: string;
}

export class LlamaServer {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly headers: Record<string, string>;

  constructor(baseUrl: string, model: string, apiKey?: string) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }

  private async get(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}?model=${encodeURIComponent(this.model)}`;
    const response = await fetch(url, { headers: this.headers, signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
    return response.json();
  }

  get id(): string {
    return `${this.baseUrl} ${this.model}`;
  }

  // Undefined when the server has no such endpoint, not llama-server or
  // started with --no-slots, and when it does not answer right now.
  async slots(): Promise<Slot[] | undefined> {
    if (withoutSlots.has(this.id)) return undefined;
    const url = `${this.baseUrl}/slots?model=${encodeURIComponent(this.model)}`;
    try {
      const response = await fetch(url, { headers: this.headers, signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
      if (response.status === 404 || response.status === 501) withoutSlots.add(this.id);
      if (!response.ok) return undefined;
      const slots = await response.json();
      return Array.isArray(slots) && slots.length > 0 ? (slots as Slot[]) : undefined;
    } catch {
      return undefined;
    }
  }

  // The fingerprint tells apart what a slot file can be loaded into. The build
  // stays out of it: nearly every rebuild leaves the KV of a model as it was,
  // and the server refuses a file of another format.
  async identity(): Promise<ServerIdentity | undefined> {
    try {
      const props = (await this.get("/props")) as {
        build_info?: string;
        model_path?: string;
        default_generation_settings?: { n_ctx?: number };
      };
      return {
        fingerprint: `${props.model_path}:${props.default_generation_settings?.n_ctx}`,
        build: props.build_info,
      };
    } catch {
      return undefined;
    }
  }

  private async slotAction(slot: number, action: string, filename?: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}/slots/${slot}?action=${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      // The router picks the model from the body.
      body: JSON.stringify({ filename, model: this.model }),
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${action}: HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return (await response.json()) as Record<string, unknown>;
  }

  save(slot: number, filename: string): Promise<Record<string, unknown>> {
    return this.slotAction(slot, "save", filename);
  }

  restore(slot: number, filename: string): Promise<Record<string, unknown>> {
    return this.slotAction(slot, "restore", filename);
  }

  erase(slot: number): Promise<Record<string, unknown>> {
    return this.slotAction(slot, "erase");
  }
}

export async function llamaServer(ctx: ExtensionContext): Promise<LlamaServer | undefined> {
  const model = ctx.model;
  if (!model || model.api !== "openai-completions") return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return undefined;
  return new LlamaServer(model.baseUrl.replace(/\/v1\/?$/, ""), model.id, auth.apiKey);
}

// Which slot is whose. A plain record on globalThis, so that an extension that
// uses slots too can agree on them with no more than this shape.
export interface SlotState {
  main?: number;
  summary?: number;
  // For the next request: it follows one that was stopped on the main slot,
  // which still shows as processing.
  keep?: boolean;
  // Whose slot main is: a model on another server must not get it.
  server?: string;
}

const SHARED = Symbol.for("pi-llama-slots");

export function sharedSlots(): SlotState {
  const holder = globalThis as unknown as Record<symbol, SlotState | undefined>;
  return (holder[SHARED] ??= {});
}

// Stays on the slot that holds the conversation, unless another client took it
// and waiting would cost more than prefilling elsewhere.
export function pickMain(state: SlotState, slots: Slot[]): number {
  const current = slots.find((slot) => slot.id === state.main);
  const idle = slots.filter((slot) => !slot.is_processing && slot.id !== state.summary);
  if (current && (!current.is_processing || idle.length === 0)) return current.id;
  state.main = (idle[0] ?? slots.find((slot) => slot.id !== state.summary) ?? slots[0]).id;
  return state.main;
}

// Without this the server picks the slot most similar to the prompt, and a
// save needs to know which one that was.
export async function pinToMainSlot(payload: unknown, ctx: ExtensionContext): Promise<unknown> {
  const body = payload as Record<string, unknown>;
  if ("id_slot" in body) return undefined;
  const state = sharedSlots();
  const keep = state.keep;
  state.keep = false;
  const server = await llamaServer(ctx);
  if (!server) return undefined;
  const known = state.server === server.id && state.main !== undefined;
  if (keep && known) return { ...body, id_slot: state.main };
  const slots = await server.slots();
  if (slots) {
    state.server = server.id;
    return { ...body, id_slot: pickMain(state, slots) };
  }
  // A failed status request is no reason to leave the conversation's slot.
  return known ? { ...body, id_slot: state.main } : undefined;
}
