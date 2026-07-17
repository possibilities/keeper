## Description

**Size:** M
**Files:** src/exec-backend.ts, src/provider-leg-death-notice.ts, src/agent/main.ts, docs/agent-surface-contracts.md, CONTEXT.md, test/provider-leg-death-notice.test.ts

### Approach

Make pre-boot provider-leg deaths permanently attributable, gated on
task 1's recorded pane-fate facts. If a dead leg pane does not persist,
first arm pane persistence for WRAPPED LEG panes only (remain-on-exit
scoped at leg-pane creation; the ownership cascade still tears the
window down, so persistence is bounded by the cascade's lifetime, not
forever). Capture at the PRODUCER moment — when the Killed mint fires
for a wrapped leg (birth_session_id gate), one bounded synchronous
capture-pane of the dead pane (full history, escapes preserved, the
locale-defaulted env the sweep already uses), byte-capped, redacted
through an interim inline conservative denylist (key-denylist +
recognizable token prefixes; structured for replacement by the shared
secrets pattern list when that ADR ratifies — fail toward MORE
redaction). The captured text rides the synthetic Killed payload
verbatim (the fold COPIES it; a fold never re-probes — determinism),
and buildProviderLegDeathNotice extends to carry it plus a structured
exit signal/code field — bump the notice schema version and respect its
byte caps (it throws past the max). Capture failure or an
already-vanished pane degrades to a typed capture-unavailable marker
and NEVER gates the Killed mint. Update the agent-surface-contracts
outcome prose in place (what a launch-time death carries; how it
differs from a live-leg partner_died). Give the artifact its own
glossary term in CONTEXT.md (the death-notice entry stays keyed on the
folded terminal event; the file is at its size cap — prune a line to
add one). Record the where-evidence-lives decision as a provisional
ADR building on the death-notice and window-lifecycle records.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- Task 1's Evidence — the pane-fate facts this design branches on
- src/exec-backend.ts:614-621, :733 — the pane_dead sweep + close-kind classification (the producer moment lives here); :426-434 the remain-on-exit posture; :635 localeDefaultedEnv
- src/provider-leg-death-notice.ts:184-297 — candidate fold + notice builder (byte caps, schema version) — EXTEND this shape, never fork a parallel payload
- src/exit-watcher.ts:393-395 — the watcher is message-to-main and never writes the DB; the capture is main's producer-side act
- docs/adr/0069, 0056 — the records the new ADR builds on
- docs/agent-surface-contracts.md:~40 — the outcome enum prose to revise in place

**Optional** (reference as needed):
- src/agent/main.ts:3058-3138 — the shim stages (whether a no-birth death path exists is settled by task 1; enrichment of the existing notice is the default scope)

### Risks

- Persisting un-redacted pane text or env turns forensics into a credential leak — the interim denylist fails toward more redaction and everything is size-bounded
- A capture that blocks or throws on the Killed path would break the terminal-event invariant — best-effort with the typed degrade marker
- Arming remain-on-exit too broadly leaks dead panes host-wide — scope strictly to wrapped leg panes and rely on the cascade for teardown

### Test notes

In-process tests over the pure seams: notice-shape extension (schema
version, byte caps, structured signal field), redaction both directions
(tokens redact; SHAs/UUIDs survive), degrade marker on capture
failure. Pane-capture mechanics are proven by recorded evidence from a
live leg death or the task-1 repro, not by a correctness-tier tmux
test.

## Acceptance

- [ ] A wrapped leg dying pre-transcript yields a death notice carrying redacted, size-bounded abort evidence (or a typed capture-unavailable marker) plus a structured exit signal/code field
- [ ] The capture is producer-side, best-effort, gated to wrapped legs, and can never block or drop the terminal event; re-fold determinism holds (the fold copies, never probes)
- [ ] The agent-surface contract prose distinguishes launch-time deaths from live-leg deaths in place; the glossary carries the new artifact term within the size cap; a provisional ADR records where the evidence lives
- [ ] The full fast correctness gates stay green

## Done summary

## Evidence
