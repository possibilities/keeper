## Description

**Size:** M
**Files:** plugins/keeper/skills/rename/SKILL.md, plugins/keeper/hooks/hooks.json, plugins/keeper/plugin/hooks/rename.ts, test/claude-rename-command.test.ts, test/agent-plugins.test.ts, CLAUDE.md, README.md, docs/install.md

### Approach

Add a Claude-only plugin skill named `rename` that intentionally shadows Claude's built-in `/rename` in Keeper-managed sessions, plus a fail-open `UserPromptSubmit` hook keyed to the exact raw command. Explicit canonical slugs are validated and returned immediately as native `sessionTitle`; bare rename snapshots the hook-provided parent identity, title, transcript path/cutoff, project, and cwd, builds the bounded input from task 1, calls task 2's metadata inference, revalidates the snapshot, and returns the accepted canonical title through `hookSpecificOutput.sessionTitle`.

The skill's unavoidable small Haiku command turn only acknowledges the metadata result and is excluded from future naming input. Non-matches perform no transcript, filesystem, or subprocess work. Missing Keeper identity, unavailable native hook capability, invalid explicit input, empty context, read/inference failure, stale state, timeout, or cancellation leaves the title unchanged and reports a concise content-free notice; transcript text, file content, raw model output, credentials, and absolute paths never enter logs or notices.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `plugins/keeper/hooks/hooks.json:22-31` — existing UserPromptSubmit event writer registration and hook inventory structure.
- `plugins/keeper/.claude-plugin/plugin.json:1-5` — Keeper plugin identity loaded by managed Claude sessions.
- `src/agent/plugins.ts:66-98` — command/skill/hook plugin discovery boundary.
- `src/transcript/claude.ts:225-232,429-431` — native Claude title record shape and exclusion from conversation entries.
- `src/transcript-worker.ts:147-174,841-895` — strict native `custom-title` parsing and change-only propagation.
- `src/daemon.ts:9946-10026` — daemon production of lifecycle-neutral `TranscriptTitle` events.
- `src/reducer.ts:324-370,11383-11418` — native title priority and deterministic history fold.

**Optional** (reference as needed):
- `src/renamer-worker.ts:108-217` — sole downstream tmux actuator.
- `src/derivers.ts:82-118` — anchored slash-command parsing used by UserPromptSubmit event indexing.
- `test/transcript-worker.test.ts:66-170` — malformed/partial/change-gated native title patterns.
- `docs/adr/0093-harness-specific-session-rename-inference.md` — accepted command, hook, and fail-open boundary.

### Risks

Claude command precedence is host behavior and can drift, so registration must be tested against the supported resource shape without relying on undocumented direct transcript mutation. A hook that imports a broad Keeper graph can violate cold-start and no-`bun:sqlite` constraints. Returning a title after the parent Session or native title changed can overwrite newer human intent.

### Test notes

Inject hook stdin, environment, transcript/input builder, inference runner, clock, and title snapshot probes. Cover exact bare/explicit parsing, near-miss commands, invalid slugs including `/rename @file`, missing Keeper identity, empty context, successful `sessionTitle`, every fail-open outcome, stale session/title/transcript/cutoff, cancellation, logging redaction, plugin discovery, and the no-work non-match path.

### Detailed phases

1. Add the Claude skill with exact name/argument help, Haiku command-turn posture, and instructions that do not perform source work or recursively invoke rename.
2. Add a dependency-light hook that recognizes only the complete `/rename` token, validates explicit input, and uses injected task-1/task-2 seams for bare inference.
3. Revalidate parent identity/title/transcript state before returning native `sessionTitle`; keep every failure fail-open and content-free.
4. Pin plugin discovery, command precedence assumptions, native title output, propagation compatibility, and non-match cold path in deterministic tests.
5. Consolidate hook inventory and harness-specific rename behavior in operator-facing docs without duplicating ADR rationale.

### Alternatives

Reusing Claude's built-in rename is rejected because it cannot carry Keeper's bounded input and path policy. Appending `custom-title`, writing Keeper projections, or renaming tmux directly is rejected because each bypasses the native title source. A standalone global skill is rejected because the feature belongs only to Keeper-managed Claude sessions.

### Non-functional targets

A non-rename UserPromptSubmit invocation performs constant-time command matching and no file/process work. The hook always exits zero, imports no SQLite or third-party package graph, emits size-bounded JSON, and exposes no transcript/file/model/auth data. A matching bare invocation inherits task 2's twenty-second bound.

### Rollout

The skill and hook load together from the Keeper Claude plugin on the next managed launch. If hook capability or command precedence is unavailable, rename fails open without title mutation; rollback removes the skill and hook together, restoring Claude's built-in command while preserving all existing native titles.

## Acceptance

- [ ] Keeper-managed Claude sessions discover a `/rename` skill that shadows the built-in command, accepts no argument for inference, and accepts only an already-canonical explicit slug; `/rename @file` remains invalid.
- [ ] The exact UserPromptSubmit hook returns valid explicit slugs through native `sessionTitle` without transcript or inference work and uses the bounded transcript/Haiku path only for bare rename.
- [ ] The hook is inert without Keeper-managed identity and for near-miss commands, and it never loads the rename skill or inference process recursively.
- [ ] Bare rename captures and revalidates parent Session id, current native title, transcript path/cutoff, project, and cwd so a stale or overlapping result cannot overwrite newer intent.
- [ ] Empty context, invalid input, unreadable transcript, unavailable route/model/auth/native capability, malformed output, timeout, cancellation, or stale state leaves the existing title unchanged with bounded content-free feedback.
- [ ] Success mutates no JSONL, Keeper database, Event projection, or tmux surface directly; Claude's native title record remains the source consumed asynchronously by existing transcript-worker, reducer, and renamer paths.
- [ ] The command turn and all command scaffolding are excluded from future naming projections, and no sensitive input/output appears in logs, notices, or persisted child artifacts.
- [ ] Hook/resource, explicit/bare, failure, stale-result, redaction, non-match, and native title-output tests are deterministic and run without a real Claude process, daemon, Worker, socket, git, or tmux.
- [ ] README, install guidance, and the imperative hook inventory describe the current harness-specific contract without duplicating ADR history.

## Done summary
Added Claude native /rename parity: a shadowing plugin skill plus a fail-open UserPromptSubmit hook that returns explicit canonical slugs immediately via native sessionTitle, and derives bare-rename candidates through task 1's bounded transcript projection and task 2's isolated Haiku metadata inference, revalidating session/transcript state before committing. Consolidated hook inventory and rename docs across CLAUDE.md, README.md, and docs/install.md.
## Evidence
