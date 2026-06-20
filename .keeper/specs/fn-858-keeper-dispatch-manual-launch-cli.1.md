## Description

**Size:** M
**Files:** src/dispatch-command.ts (new), src/rpc-handlers.ts, test/dispatch-command.test.ts (new), test/rpc-handlers.test.ts

Create the dep-free `src/dispatch-command.ts` leaf module that both the new CLI
handler and `rpc-handlers.ts` import — holding the pure verb::id validator and
the launch-argv/prompt builders. This is the foundation `.3` consumes.

### Approach

- Move `parseDispatchKey` + `rejectDispatchIdToken` + `RETRY_DISPATCH_VERBS` / `RetryDispatchVerb` (currently `src/rpc-handlers.ts:330-416`) into `src/dispatch-command.ts`. The module MUST stay dep-free (no `bun:sqlite`, no `./server-worker`, no `./db`) — mirror the hook's leaf-module discipline.
- DECOUPLE from `BadParamsError` (defined in the heavy `src/server-worker.ts:1342`): have the moved validator return a DISCRIMINATED result `{ ok: true; verb; id } | { ok: false; error: string }` instead of throwing. `rpc-handlers.ts:457` imports it and re-wraps an `{ ok:false }` into `BadParamsError(error)` so the wire contract (`bad_params`) is byte-identical.
- Add `defaultPlanPrompt(verb, id)` → `"/plan:" + verb + " " + id`.
- Add `buildDispatchLaunchArgv(shell, { cwd, claudeName, prompt, model?, effort?, noConfirm })` returning the `"$@"` POSITIONAL form: `[shell, "-l", "-i", "-c", 'exec claude "$@" ; exec "$0" -l -i', shell, ...flags, prompt]` where the prompt rides as the final positional argv element (zero shell escaping). `flags` includes `--agentwrap-no-confirm` (the LIVE flag — `src/autopilot-worker.ts:258`; ignore the stale `--arthack-no-confirm` doc-comment at `:245`) plus `--name <claudeName>`, and `--model`/`--effort` ONLY when supplied (omitted by default). cwd is applied by `ensureLaunched`'s tmux `-c`, mirroring autopilot — the builder need not `cd`.
- Add `validatePromptBytes(s)` (or inline guards): reject NUL bytes and reject length > 96 KB (returns a discriminated/typed result the CLI maps to exit 2).
- Do NOT touch `buildWorkerCommand` / `buildLaunchArgv` in `src/autopilot-worker.ts` — they are byte-pinned and autopilot's prompt is the trusted `/plan:` literal.

### Investigation targets

**Required** (read before coding):
- src/rpc-handlers.ts:330-463 — the validator, `RETRY_DISPATCH_VERBS`, `BadParamsError` import (`:49`), and the `:457` call site to re-point.
- src/server-worker.ts:1342 — `BadParamsError` definition (confirm it must NOT be imported by the leaf).
- test/rpc-handlers.test.ts:367-404 — existing validator tests (split most to the new module's test; keep a re-wrap test here proving `{ok:false}` → `BadParamsError`).
- src/autopilot-worker.ts:249-262,670-676 — the builders to mirror (shape + `--agentwrap-no-confirm`), NOT to modify.

**Optional** (reference as needed):
- test/autopilot-worker.test.ts:613-615,2339-2351 — byte-pin test style to match for the new builder.

### Risks

- The decouple must not leave `rpc-handlers` behavior or its wire error code changed — re-wrap to `BadParamsError` exactly. If decoupling proves entangled, fall back to a CLI-local validator copy (epic Early proof point).

### Test notes

New `test/dispatch-command.test.ts`: validator (one `::`, verb whitelist, empty/nested-sep, path-traversal reject), `defaultPlanPrompt`, byte-pinned `buildDispatchLaunchArgv` (per-slot, with/without model/effort), and an ADVERSARIAL prompt (`'`, `$`, backticks, `$(...)`, newlines, `;`, leading `-`) proving byte-faithful pass-through + NUL/oversize rejection. Keep `test/rpc-handlers.test.ts` green via the re-wrap path.

## Acceptance

- [ ] `src/dispatch-command.ts` exists, is dep-free (no `bun:sqlite`/`server-worker`/`db` imports), and exports the validator (discriminated result), `defaultPlanPrompt`, `buildDispatchLaunchArgv`, and the prompt-bytes guard.
- [ ] `rpc-handlers.ts` imports the moved validator and re-wraps failures into `BadParamsError`; its existing RPC behavior + tests are unchanged.
- [ ] The new builder emits the `"$@"` positional form with an explicit `argv[0]`, includes `--agentwrap-no-confirm`, and omits `--model`/`--effort` unless supplied.
- [ ] New unit tests cover the validator, builder (byte-pinned), adversarial prompt, and NUL/oversize rejection.

## Done summary

## Evidence
