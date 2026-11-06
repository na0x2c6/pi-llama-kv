# pi-llama-kv

A [pi](https://github.com/earendil-works/pi) extension that saves llama-server's KV cache when the conversation leaves a branch of the session tree, and restores it on the way back. Without it, returning to a branch costs a prefill of its whole context.

## Install

```bash
pi -e ./extensions/llama-kv.ts
```

llama-server needs `--slot-save-path <dir>`.

Load it before an extension that records or copies the requests: pi hands each extension the payload the previous one left, and those after this one see the `id_slot`.

## Other servers

There is no setting to turn it off, and none is needed: a model counts as llama-server when pi reaches it through `openai-completions` and `GET /slots` lists slots. For any other model the extension sends no `id_slot`, saves nothing and restores nothing, also when the session switches from a model on llama-server.

Such a server is asked once, with the model's API key, as for any request to it. A 404 or 501 ends that for as long as pi runs; other failures are asked again at the next request.

## What it does

The KV cache of the conversation's slot is saved when leaving a branch and when pi exits. It is restored when moving to or resuming a point that a file covers better than what the slot holds.

A file also holds the slot's context checkpoints, which lets the server roll back to the earlier points of that path. On hybrid and SWA models the rollback lands on the nearest checkpoint, and the rest is prefilled.

It does not save every turn: a file is hundreds of MiB, and the server does nothing else while writing it.

The extension pins the conversation to one slot through `id_slot`, picked from `GET /slots`: the lowest idle slot at first, moving only if another client holds it while another slot is idle.

## Limits

llama-server has no limit for these files, and no way to list or delete them over its API. Bounding them is up to the host, with a timer or a path unit on the directory. A file that is gone is only a missed restore: the extension forgets it and tries the next best one, or the prompt is prefilled as usual.

The index of the files is `<agent dir>/llama-kv/<session id>/kv.json`.

On a unified KV (`--kv-unified`) a restore needs room in the shared pool. When it fails, the extension erases the other idle slots and tries once more.

## Sharing the server

Who owns which slot is a plain record on `globalThis` under `Symbol.for("pi-llama-slots")`, `{ main?: number, summary?: number, keep?: boolean }`. An extension that runs requests on a slot of its own can register it there to keep the conversation off it. One that stops a request on the main slot sets `keep`: that slot still shows as processing, and the next request stays on it instead of giving up the KV.

Before a slot is saved, `llama-kv:saving` goes out on `pi.events`: the server waits for the slot to be idle, so whatever runs on it can stop.

## Development

```bash
npm install
npm run check
npm test
node test/e2e/run.ts [model]    # needs llama-server with --slot-save-path
node test/e2e/other-server.ts [model]
```

`LLAMA_URL` selects the server, and `E2E_EXTENSIONS` loads more extensions, separated by `:`.

## License

Apache-2.0
