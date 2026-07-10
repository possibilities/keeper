## Description

**Size:** M
**Files:** src/agent/run-capture.ts, src/agent/main.ts, src/agent/transcript-watch.ts, src/agent/launch-handle.ts, src/agent/pair-subcommands.ts, test/agent-run-capture.test.ts, test/agent-run-capture-golden.test.ts

### Approach

Layer 2: `keeper agent run <cli> "<ask>" --resume <name-or-id>` resumes
and captures. parseRunArgs gains `--resume` (both `--resume v` and
`--resume=v` spellings, raw string out — resolution stays handler-side);
help text visibly disambiguates it from the existing `--session` tmux
GROUPING flag. Handler: resolve via the resume-policy module with
requireHarness = the `<cli>` positional → bad_args naming both harnesses
on mismatch; `--model`/`--effort`/`--preset` alongside `--resume` is
bad_args (the resumed session owns its config); the fresh-launch
readiness gate is skipped on resume (guard the existing not-both-explicit
block — the gate itself stays for fresh runs). Launch composes the resume
argv (claude: handler mints + pins the child uuid; codex/pi/hermes: the
resolved target). Capture: an isResume marker rides the launch handle and
TranscriptWatchOptions; claude discovery stays strict-pinned (the pinned
CHILD id resolves the child file); codex discovery under isResume resolves
the rollout BY the known target uuid, bypassing the fresh-launch
created-at floor that would reject the pre-existing file; the stop-scan
anchors at the resume startedAtMs watermark so the file's PRE-resume
terminal stop marker is never captured as the answer. The envelope's
resume_target is the POST-resume id (claude: the pinned child; others:
the unchanged target). Fresh-launch discovery, stop-scan, and envelope
goldens stay byte-unchanged — gate every new branch behind isResume.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/run-capture.ts:183 — parseRunArgs (mirror the --session both-spellings shape at :289-301); :107 buildRunCaptureEnvelope; :516 resolveResume (the post-stop resume_target seam)
- src/agent/main.ts:1096-1200 — runRunCaptureSubcommand (readiness gate at :1165, the preset harness-equality bad_args pattern at :2008 to mirror)
- src/agent/transcript-watch.ts:228-246 — findClaudeTranscriptPath strict pin; :248-286 findCodexTranscriptPath created-at floor (the branch isResume bypasses); :77 START_SLOP_MS
- src/agent/launch-handle.ts:217 — startedAtMs sampling; ResolvedHandle threading via src/agent/pair-subcommands.ts:41

**Optional** (reference as needed):
- test/agent-run-capture-golden.test.ts — byte-pinned envelopes that must not move for fresh runs
- docs/adr/0034 — the codex same-rollout probe fact this design encodes

### Risks

- The codex watermark is load-bearing: the resumed rollout already contains a terminal stop marker; a scan not anchored past it returns the OLD answer as completed — cover with a fixture-driven test
- Golden churn: adding the flag must not reorder or reshape fresh-run envelopes

### Test notes

parseRunArgs arms (both spellings, conflict flags); fixture-driven
transcript tests: a codex-shaped rollout with a pre-resume stop marker +
post-resume stop → capture returns the post-resume message; claude
child-pin resolution; goldens re-run to prove fresh-path stability. One
manual end-to-end `run --resume` against a real dead partner recorded in
Evidence.

## Acceptance

- [ ] A resumed capture run returns an envelope whose message is the resumed session's NEW final answer, never a pre-resume stop, for both a claude and a codex partner
- [ ] The envelope's resume_target is the post-resume id (claude: a new child id; codex: the original uuid), and feeding it back into a second resume continues the latest lineage
- [ ] Harness mismatch, unknown target, live target, and config flags alongside the resume flag each produce a distinct actionable bad_args/error outcome with the envelope written
- [ ] A fresh (non-resume) run's envelope and transcript discovery are byte-identical to before the change, proven by the existing goldens
- [ ] Fast-suite fixtures cover the resume watermark (pre-resume stop excluded) and both discovery branches

## Done summary

## Evidence
