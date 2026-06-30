## Description

**Size:** M
**Files:** src/agent/run-capture.ts (new), src/agent/dispatch.ts, src/agent/main.ts, cli/agent.ts, README.md, test/agent-run-capture.test.ts (new), test/agent-run-capture-depgraph.test.ts (new, or extend test/agent-self-invoke.test.ts)

### Approach

Add two additive, posture-free verbs that compose the EXISTING detached-launch + wait + show primitives in one process. New module `src/agent/run-capture.ts` (NOT `run.ts` — taken by the job-control spawn layer) holds the compose helper + the result-envelope builder, built from `resolveHandle` / `runWaitForStop` / `runShowLastMessage` (`src/agent/pair-subcommands.ts`) — never reimplementing spawn/wait/transcript logic. `agent run <cli> <prompt>`: assemble the per-CLI launch argv (reuse `buildPairLaunchArgv`), `launchAgentwrapInTmux` detached, hold `result.id` LOCALLY (the robustness payoff — no cross-process re-resolution, avoids the `PATH_CEILING_MS + SLOP_MS` kill margin + self-transcript-collision), then `runWaitForStop` → `runShowLastMessage` on that pinned handle → build envelope → emit ONE JSON line → exit. `agent wait <handle>`: `resolveHandle` → wait → show → the SAME envelope. Both are NEW dispatch kinds — NOT the existing `run` kind (already taken by agent-launch); use distinct names (e.g. `run-capture`/`wait-capture`) classified in `splitSubcommand` (`dispatch.ts`) + new handler branches in `main()` modeled on `runTranscriptSubcommand` (`main.ts:624`), emitting JSON ONLY (no bare-text prelude like `show-last-message`). Add a `now()` seam to the run-capture deps for deterministic `elapsed_seconds`. Forward `--stop-timeout-ms` (default `DEFAULT_STOP_TIMEOUT_MS` = 600s). Document the verbs in `USAGE`/`AGENTWRAP_HELP`, the `cli/agent.ts` header, the `main.ts` composable-verb comments, and the README launcher block.

### Result contract (uniform envelope — decision A)

ONE JSON shape for EVERY terminal state, schema-versioned (integer `schema_version: 1`, matching `TMUX_SCHEMA_VERSION` / `PAIR_AGENTWRAP_SCHEMA_VERSION`), snake_case keys (matches pair YAML):
`{schema_version, agent, handle, transcript_path, resume_target, message, message_found, elapsed_seconds, outcome}`.
`outcome` closed set → exit code:
- `completed` — stop seen, message found → exit 0.
- `no_message` — stop seen, no final message (e.g. tool-only final turn; `message_found: false`) → exit 0.
- `timed_out` — stop-wait elapsed; best-effort partial message captured via `findLastMessage` → exit 4 (RETRYABLE).
- `no_transcript` — transcript path never appeared → exit 4 (RETRYABLE).
- `launch_failed` — detached launch failed → exit 1.
- `bad_args` — unknown `<cli>` / missing prompt / unresolvable handle → exit 2 (BAD_ARGS).
On a failure outcome the envelope STILL emits (nulls where unknown) — never the legacy `tmuxErrorJson` shape; the uniform envelope is the whole point. `resume_target` = `transcriptSessionId` (`handle.sessionId`); `null` for codex AND for claude `--continue`/`--resume` launches (a defined state — document it).

### Investigation targets

**Required** (read before coding):
- src/agent/pair-subcommands.ts:61 (`resolveHandle`), :235/:265 (`runWaitForStop`/`runShowLastMessage`), :221 (`VerbDeps`) — compose from these; do not reimplement.
- src/agent/main.ts:624-682 (`runTranscriptSubcommand` — the handler template), :1006-1037 (the `dispatch.kind` routing block), ~:1090-1096 (`launchAgentwrapInTmux` call site + the inline `Date.now`), :109 (`MainDeps` seam — add `now()`).
- src/agent/dispatch.ts:22-32 (`Dispatch` union — add distinct kinds), :174-226 (`splitSubcommand` — classify the new tokens), the `USAGE`/`AGENTWRAP_HELP` constants.
- src/pair-command.ts:208 (`buildPairLaunchArgv` — reuse for launch argv), :379 (`PAIR_AGENTWRAP_SCHEMA_VERSION` — the schema-version style to mirror).
- src/agent/tmux-launch.ts:146 (`transcriptSessionId` = `resume_target`; codex writes null).
- cli/agent.ts:25-28 (the dep-graph guardrail — `run-capture.ts` must stay db-free).

**Optional** (reference as needed):
- test/agent-pair-subcommands.test.ts (faked-transcript fixture + `writeRunJson` pattern), test/agent-run.test.ts (spawn-seam DI), test/agent-self-invoke.test.ts:162-178 (the dep-graph import-scan test to clone), test/helpers/agent-main-harness.ts.

### Risks

- **Dep-graph:** `run-capture.ts` (and `cli/agent.ts`'s reach) must NOT transitively pull `src/db.ts`/`bun:sqlite` — clone the `agent-self-invoke` import-scan test for `run-capture.ts`. (`pair-subcommands.ts`/`transcript-watch.ts` are already db-free, so composing them is safe.)
- **JSON-only:** the new handler must emit exactly one JSON line, no bare-text prelude (`show-last-message` writes raw text before its JSON — do NOT reuse that branch). stdout poisoning breaks every caller.
- **Schema drift:** a forgotten field without a `schema_version` bump — guard with a full-key-set snapshot (assert exactly the 9 keys, no extras like a leaked `read_only`/`changed_files`).
- **In-flight rename:** `scrub-agentwrap-legacy` edits these same files — coordinate/rebase to avoid textual conflicts in `dispatch.ts`/`main.ts`.
- **Codex:** not trust-seeded here → `agent run codex` may hang→time out in untrusted cwds. Verify on claude this increment; document the codex limitation (trust-seeding is step 4).

### Test notes

Unit-test the compose helper + envelope builder with injected spawn/wait/show/`now` seams + faked transcript fixtures (pattern: `test/agent-pair-subcommands.test.ts`) — no real subprocess. Full-key-set snapshot of the envelope for each `outcome` (completed / no_message / timed_out / no_transcript / launch_failed / bad_args). Dispatch-classification test for the new verbs. Dep-graph import-scan test for `run-capture.ts`. The live `agent run` launch is verified OUT-OF-BAND, not in `bun test`.

## Acceptance

- [ ] `agent run <cli> <prompt>` composes launch→wait→show in one process (holding the run-id locally) and emits the uniform run-capture envelope as a single JSON line.
- [ ] `agent wait <handle>` emits the SAME envelope (wait+capture on an existing handle).
- [ ] New verbs use DISTINCT dispatch kinds (not the taken `run`); classified in `splitSubcommand` + handled in `main()`; JSON-only output (no bare-text prelude).
- [ ] Envelope = `{schema_version:1, agent, handle, transcript_path, resume_target, message, message_found, elapsed_seconds, outcome}`, snake_case, with the `outcome` closed set mapped to exit codes (completed/no_message=0, timed_out/no_transcript=4, launch_failed=1, bad_args=2).
- [ ] `--stop-timeout-ms` forwarded (default 600s); a `now()` clock seam added for deterministic `elapsed_seconds`.
- [ ] Dep-graph hygiene test asserts `run-capture.ts` imports no `db`/`bun:sqlite`.
- [ ] `USAGE`/`AGENTWRAP_HELP`, the `cli/agent.ts` header, the `main.ts` composable-verb comments, and the README launcher block document `run`/`wait` (present-tense).
- [ ] Existing behavior unchanged (bare agent launch, `wait-for-stop`, `show-last-message` byte-identical); `bun test` green; no test launches a real subprocess.

## Done summary
Add additive 'agent run <cli> <prompt>' / 'agent wait <handle>' verbs composing detached launch + wait-for-stop + show-last-message in one process, emitting one uniform schema-versioned JSON envelope (9 keys; outcome closed set mapped to exit codes). New db-free src/agent/run-capture.ts holds the seam-injected compose + envelope builder; run-id held locally (no cross-process kill margin). Docs (USAGE/help/cli header/README) + golden/dep-graph/compose tests added; full suite green, no behavior change to existing paths.
## Evidence
