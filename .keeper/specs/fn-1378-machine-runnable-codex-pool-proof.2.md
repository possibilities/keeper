## Description

**Size:** M
**Files:** integrations/pi-codex-pool/src/index.ts, integrations/pi-codex-pool/src/proof.ts, integrations/pi-codex-pool/test/proof.test.ts, integrations/pi-codex-pool/test/orchestrator.test.ts

### Approach

One model-callable Pi tool (registerTool, following the in-repo
task-facade precedent: job-id-gated, fail-open) exposing a single atomic
run-the-whole-proof orchestrator — no primitive kit for models to
sequence. The orchestrator drives every clause: two forced refreshes
across two aliases, a retry route with a classified pre-output fault and
cooldown, a mid-stream cutoff after substantive output, native fallback,
a deliberate child abort (distinguished from an interrupting abort that
voids the run), root and child sessions on distinct aliases, concurrent
pressure, and session stickiness. Every clause outcome is recorded as an
evidence-transcript entry; the verdict re-derives from the transcript
plus the existing revision/config/alias bindings, so clause booleans stop
being self-reportable and a fabricated report fails verification
structurally. The report stays evidence-only at the env-derived path;
every artifact passes the sanitation scan. The human-typed commands
remain for manual diagnosis but stop being the documented proof path.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- integrations/pi-codex-pool/src/index.ts:283-343 — the 13-clause gate and each clause's exact predicate
- integrations/pi-codex-pool/src/index.ts:728-812 — the existing report assembly the tool reuses (collectLiveProof, writeLiveProofReport)
- integrations/pi-codex-pool/src/proof.ts — verdict machinery, freshness/binding rejection (:83-98,332), scanProofArtifacts
- plugins/keeper/pi-extension/task-facade.ts:37-56,822-836 — the registerTool shape and gating to copy
- docs/adr/0098-machine-runnable-codex-pool-proof.md — the attestation contract

**Optional** (reference as needed):
- src/agent/main.ts:909-932,3541-3556 — proof-window arming at launch; the managed-session guard
- src/codex-pool-activation.ts — the ladder that consumes the report (unchanged here)

### Risks

- The proof window budget must fit the whole orchestration; a mid-run expiry loses in-memory evidence — the run should fail fast toward the window deadline rather than straddle it
- The deliberate-vs-interrupting abort distinction is subtle: an orchestrator-issued child abort must satisfy abort-preserved without tripping the interrupted-run rejection

### Test notes

Orchestrator tests drive the seams from task 1 end-to-end in-process;
attestation tests assert a hand-written report (booleans without a
matching transcript) fails verification while a recorded run passes;
sanitation tests extend the existing artifact scan to transcript
artifacts.

## Acceptance

- [ ] A managed pi launch whose model calls the proof tool once produces a report reaching `proven` with all thirteen clauses genuinely driven
- [ ] A report whose clause outcomes lack a matching recorded transcript fails verification and never reads `proven`
- [ ] A run interrupted by the window deadline or an external abort classifies as interrupted, never `proven`
- [ ] All proof artifacts, including transcripts, pass the credential/PII sanitation scan
- [ ] The tool is absent outside a keeper job context and fail-open on registration errors
- [ ] Companion suites green

## Done summary

## Evidence
