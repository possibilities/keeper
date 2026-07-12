## Description

**Size:** M
**Files:** plugins/keeper/pi-extension/keeper-events.ts, plugins/keeper/pi-extension/rename-command.ts, test/pi-extension.test.ts, CLAUDE.md, README.md, docs/install.md

### Approach

Register `/rename` inside the existing `KEEPER_JOB_ID` arming boundary. Snapshot the Pi native session id, active leaf, and current Session title; consume task 1's bounded JSON turn contract; and return a visible no-op before model resolution when the turn is empty. Resolve only `openai-codex/gpt-5.3-codex-spark`, with no model fallback, through Pi's command-context registry and OAuth-aware request configuration, then invoke one lower-level completion without changing the live model, appending messages, or launching any process.

Keep Pi extension startup dependency-light: the host inference surface is loaded invocation-locally behind an injected seam, and import/API-shape failures fail only the command. Use at most 16 KiB of transcript text, minimal/disabled reasoning, a 64-token response cap, and a 20-second AbortController timeout. Accept only a successful terminal completion with text, strip unsafe controls/bidi formatting, apply the canonical `src/slug.ts` 64-character ASCII slug contract through an explicitly drift-tested isolated helper, and reject an empty result.

Serialize with a monotonically increasing in-process generation token. Immediately before mutation, require that the invocation is still newest and the native session id, active leaf, and pre-call title all match; a newer turn, branch navigation, session replacement, manual title change, timeout, or later `/rename` discards the result. On success call `pi.setSessionName()` exactly once. Map `session_info_changed` to the existing lifecycle-neutral `TranscriptTitle` event, and replay the current non-empty title on Pi `session_start` so a missed fail-open write heals after resume/reload; Keeper's reducer and renamer worker remain the only DB/tmux path. Command success means Pi accepted the title—never wait for the asynchronous reducer/tmux projection.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `plugins/keeper/pi-extension/keeper-events.ts:1-42` — ephemeral arming, isolation, events-writer, and fail-open invariants
- `plugins/keeper/pi-extension/keeper-events.ts:429-637` — safe transcript id/clamp/timeout/JSON bridge patterns to reuse
- `plugins/keeper/pi-extension/keeper-events.ts:640-702` — factory registration and `KEEPER_JOB_ID` gate
- `src/reducer.ts:321-362` and `src/reducer.ts:9503-9540` — existing session_title/TranscriptTitle precedence and history fold
- `src/slug.ts:14-48` — canonical normalization contract the isolated command helper must match
- `docs/adr/0041-pi-direct-inference-for-metadata-commands.md` — required host-inference and fail-open boundary
- Installed Pi extension/model declarations and current Pi AI guidance — registerCommand, setSessionName, session_info_changed, OAuth request resolution, completion response/stop semantics

**Optional** (reference as needed):
- `plugins/keeper/pi-extension/task-facade.ts:76-144` — cancellation, timeout, malformed-result, and pure injection patterns
- `test/pi-extension.test.ts:207-531` — pure helper and fake extension API conventions
- `src/renamer-worker.ts:100-228` — downstream title-to-tmux actuator; do not call it directly

### Risks

- Static host-package imports can turn optional command drift into Pi launch failure; preserve an invocation-local dynamic boundary and update the existing CLAUDE.md rule narrowly rather than weakening the events writer.
- OAuth/model APIs evolve with the installed Pi version; structural adapters and injected completion/auth seams must make drift a visible command error and keep tests offline.
- Pi can switch sessions while an idle command awaits inference; the stale snapshot check is load-bearing protection against writing into the replacement session.
- A fail-open title event can be lost after Pi persistence; session-start replay is the positive-evidence healing path, without direct DB or tmux writes.

### Test notes

Extend the fake Pi API with command registration, session manager identity/leaf access, title access/mutation, UI notifications, and model/auth/completion seams. Cover unarmed registration, transcript error versus valid empty turn, missing model/auth, timeout/abort/error/length/non-text completion, output sanitization and slug drift corpus, overlapping invocations, leaf/session/title staleness, exactly-once setSessionName, title-event lifecycle neutrality, failed event write, and session-start replay. No test starts Pi, Keeper, a daemon, tmux, or a real model.

## Acceptance

- [ ] `/rename` registers only when `KEEPER_JOB_ID` is non-empty; a valid empty Latest turn returns before model lookup/completion and leaves Pi, Keeper, and tmux title state unchanged.
- [ ] The command resolves only `openai-codex/gpt-5.3-codex-spark` through Pi's OAuth-aware host boundary and performs one bounded direct completion with no child process, live-model change, conversation message, tool call, auth/transcript logging, or expensive-model fallback.
- [ ] Only successful complete text can become a title; timeout, cancellation, auth/import/API error, incomplete stop reason, missing text, unsafe or empty normalized output, and every stale snapshot leave the existing title unchanged.
- [ ] Accepted output matches the canonical 64-character `[a-z0-9-]+` slug contract, and the command calls `pi.setSessionName()` exactly once only after session/leaf/title/newest-invocation revalidation.
- [ ] Every non-empty Pi `session_info_changed` title emits one bounded lifecycle-neutral `TranscriptTitle`; current title replay on `session_start` heals Keeper/tmux convergence without direct projection or tmux mutation.
- [ ] Command feedback distinguishes no prompt, busy/stale, timeout, model/auth failure, invalid output, and success without revealing transcript text, model output, or credentials.
- [ ] `CLAUDE.md` preserves the dependency-free events-writer load rule while documenting the narrow invocation-local host-model exception; `docs/install.md` documents managed availability/OAuth/model prerequisites, and README remains concise.
- [ ] `bun test test/pi-extension.test.ts` and the full fast suite are green without real model, process, daemon, worker, socket, git, or tmux activity.

## Done summary
Registered /rename inside the KEEPER_JOB_ID arming boundary: consumes the branch-aware keeper transcript pi turn contract, resolves openai-codex/gpt-5.3-codex-spark through Pi's OAuth-aware model registry with a bounded direct completion, and revalidates session/leaf/title before calling pi.setSessionName() exactly once. Every non-empty session_info_changed title mints a lifecycle-neutral TranscriptTitle event for Keeper's existing title projection/renamer; session_start replays the current title to self-heal a missed write.
## Evidence
