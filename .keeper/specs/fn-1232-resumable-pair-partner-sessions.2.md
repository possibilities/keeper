## Description

**Size:** M
**Files:** src/agent/harness.ts, src/agent/launch-config.ts, test/agent-harness.test.ts, test/agent-launch-config.test.ts

### Approach

Per-harness resume-launch argv composition: the descriptor registry gains
a resume-launch capability describing how each harness composes resume +
pinned session + new prompt, and the native builder table in launch-config
gains resume branches driven by it — exec-backend's prompt-less resume
mode stays byte-untouched (it serves the daemon restore path). Probe-settled
shapes (docs/adr/0034): claude `--resume <target> --session-id
<fresh-child-uuid> --fork-session [prompt]` (keeper mints and pins the
child uuid — strict transcript resolution keeps working); codex `resume
<target> [prompt]` (verb-position; appends to the SAME rollout). pi
`--session <target> [prompt]` and hermes `--resume <target> -z <prompt>`
are the expected shapes but MUST be live-probed as part of this task
before the builders land; where a harness cannot compose resume + prompt,
the builder fails loud (a typed unsupported error), never silently
dropping the ask. Where the native CLI honors `--` end-of-options before
the prompt positional, emit it (a prompt starting with `-` must not parse
as a flag); probe-verify per CLI and record which do.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/harness.ts:126 — HARNESS_DESCRIPTORS + ResumeArgvForm; :257 buildHarnessResumeArgv (the token source — reuse, never re-inline a switch)
- src/agent/launch-config.ts:162 — the per-harness native-flag builder table the resume branches extend; :210 preset/model/effort flag assembly the resume path must compose with
- src/exec-backend.ts:1111-1119 — the untouched prompt-less resume mode (byte-unchanged is an acceptance item)
- test/agent-harness.test.ts:41,:70 — descriptor completeness assertions to extend

**Optional** (reference as needed):
- docs/adr/0034 — probe transcripts of the claude fork-session and codex same-rollout facts

### Risks

- pi/hermes resume+prompt composition is unverified — the live probe may force a per-harness fallback (fail-loud unsupported) rather than full four-harness coverage; that is an acceptable landing, not a blocker
- The claude child uuid must be minted by the CALLER and threaded to both argv and the launch handle — the builder takes it as input, never generates ids itself

### Test notes

Pure argv assertions per harness (fast tier); the pi/hermes live probes
are manual verification recorded in Evidence, not fast-suite tests.
Fresh-launch argv goldens must not move.

## Acceptance

- [ ] Building a resume launch for claude emits resume + pinned child session + fork flags with the prompt positional; codex emits the verb-position resume with the prompt; each matches a recorded live probe
- [ ] pi and hermes resume+prompt shapes are live-probed and either land as builders matching the probe or fail loud as typed unsupported errors — never a silent prompt drop
- [ ] A prompt beginning with a dash cannot be parsed as a flag by any supported harness (end-of-options guard or probe-verified positional safety)
- [ ] Fresh-launch argv output for every harness is byte-identical to before the change
- [ ] Descriptor completeness tests cover the new capability field for all four harnesses

## Done summary

## Evidence
