## Description

**Size:** S
**Files:** src/agent/codex-session-index.ts, src/agent/run-capture.ts, src/agent/main.ts,
src/agent/dispatch.ts, test/agent-run-capture.test.ts, test/agent-codex-session-index.test.ts

### Approach

Populate the run-capture envelope's `resume_target` for codex by parsing the session uuid from
the already-resolved `rollout-<ts>-<uuid>.jsonl` transcript path, via an injected seam.
claude/pi are UNCHANGED (they keep `handle.sessionId`).

- **Pure helper** (`src/agent/codex-session-index.ts`): add `codexSessionIdFromRolloutPath(p:
  string): string | null` — extract the trailing uuid from a `rollout-…-<uuid>.jsonl`
  basename; return null on any shape mismatch. No FS, no imports beyond `node:path` basename
  parsing. Unit-testable in isolation.
- **Seam** (`src/agent/run-capture.ts`): add an OPTIONAL field to `RunCaptureDeps` (near the
  other seams), e.g. `resolveCodexResumeTarget?: (args: { transcriptPath: string }) => string |
  null`. In `captureFromHandle`, keep `handle.sessionId` when non-null; else, when `agent ===
  "codex"` and a transcript resolved, call the seam. Apply it in the branches that HAVE a
  transcript: `completed`/`no_message` and `timed_out`. Leave `no_transcript` null (the rollout
  never appeared → the id is genuinely unknowable). Do NOT touch the claude/pi path or the
  envelope key set.
- **Bind** (`src/agent/main.ts`, `runCaptureSeams`): bind `resolveCodexResumeTarget` to a fn
  that calls the pure helper on the resolved `transcriptPath`. Wire it for BOTH capture call
  sites (`agent run` and `agent wait`) — `agent wait` already recovers cwd/startedAtMs from
  run.json, so a codex handle resolves too.
- **Docs**: one forward-facing line in `dispatch.ts` `KEEPER_AGENT_HELP` run block noting codex
  `resume_target` is discovered from the rollout (claude/pi from the pinned session id).

### Investigation targets

**Required** (read before coding):
- src/agent/run-capture.ts: the `resume_target` field on the envelope + its assembly, the
  `RunCaptureDeps` seam bag, and `captureFromHandle`'s outcome branches (completed/no_message,
  timed_out, no_transcript) — find the single `const resumeTarget = handle.sessionId` and the
  per-branch fills.
- src/agent/main.ts: `runCaptureSeams` (the seam-binding site) + both capture call sites
  (`agent run`, `agent wait`).
- src/agent/codex-session-index.ts: `findCodexSessionId` + `startCodexSessionNameIndexer` (for
  context — the rollout filename shape `rollout-<ts>-<uuid>.jsonl` and how CODEX_HOME resolves);
  the new pure helper lands here.
- src/agent/launch-handle.ts: `tmuxTranscriptSessionId` — confirm it stays null for codex (no
  change); understand why claude/pi are pinned.
- src/agent/transcript-watch.ts: `findCodexTranscriptPath` — the resolver that already produces
  the `rollout-…-<uuid>.jsonl` path the helper parses.

**Optional** (reference as needed):
- test/agent-codex-session-index.test.ts: the existing sandboxed-`CODEX_HOME` pattern (mkdtemp +
  synthetic rollout) to mirror for the helper / seam-binding test.
- test/agent-run-capture.test.ts: where `captureFromHandle`/`composeRunCapture` are driven with
  fake `waitForStop`/`showLastMessage` seams — inject a fake `resolveCodexResumeTarget` here.

### Risks

- **Do not change the envelope shape** — `resume_target` already exists; no new key, no
  `schema_version` bump. The golden full-key-set test must stay green unchanged.
- **claude/pi untouched** — the `handle.sessionId` path stays authoritative for them; only the
  codex-and-null-sessionId case reaches the seam. Pin claude/pi resume_target unchanged.
- **Post-stop only** — never call the resolver at launch (the id does not exist yet). It lives
  inside `captureFromHandle` after transcript resolution.
- **`no_transcript` stays null** — do not fabricate an id when no rollout resolved.
- **Dep-free contract** — `run-capture.ts` must keep importing TYPES only; the resolver is an
  injected seam bound in `main.ts`, not a direct `codex-session-index` import in run-capture.

### Test notes

Pure tier only. (1) Unit-test `codexSessionIdFromRolloutPath`: a valid `rollout-…-<uuid>.jsonl`
→ the uuid; a non-rollout / malformed name → null. (2) In `captureFromHandle` tests inject a
fake `resolveCodexResumeTarget` and assert `resume_target` is filled for a codex
completed/timed_out run and null for no_transcript; assert a claude run still uses
`handle.sessionId`. (3) Optional seam-binding test: sandbox `CODEX_HOME` at a tmpdir with a
planted rollout, assert the bound seam resolves the id. No real `~/.codex`, no tmux/subprocess.

## Acceptance

- [ ] `codexSessionIdFromRolloutPath` parses the uuid from a `rollout-<ts>-<uuid>.jsonl` path
  (null on mismatch), pure + unit-tested.
- [ ] `captureFromHandle` fills `resume_target` for codex from the resolved transcript on
  completed/no_message/timed_out; no_transcript stays null; claude/pi keep `handle.sessionId`.
- [ ] Seam bound in `runCaptureSeams` for both `agent run` and `agent wait`; `run-capture.ts`
  keeps its types-only/dep-free contract.
- [ ] Envelope schema + key set UNCHANGED (no version bump); golden test green.
- [ ] `dispatch.ts` help notes codex resume_target discovery; `bun test` green.

## Done summary

## Evidence
