## Overview

Wrapped gpt provider legs die 2-4s after launch, pre-transcript, on every
attempt, while unwrapped launches of the same models succeed —
worker_provider is pinned claude until this lands (human-ratified,
temporary). Task 1 diagnoses the launch path empirically (two prime
suspects: the fail-closed ADR-0071 ownership gate deployed this morning
and never exercised by a gpt leg until midday; the -e pi-extension load
under the current pi build) and fixes the root cause. Task 2 makes this
class permanently attributable: producer-side dead-pane capture wired
into the provider-leg death notice, redacted and bounded.

## Quick commands

- `keeper agent run pi 'Reply with exactly: OK' --model openai-codex/gpt-5.5 --stop-timeout 90s` — the unwrapped baseline (known good, 11-13s)
- The scoped wrapped-path repro recipe lives in task 1's spec — raw argv first, NEVER through the shim with a valid tuple

## Acceptance

- [ ] The wrapped-leg death's root cause is named with captured evidence, and the fix lands with a regression pin at the failing component
- [ ] A pre-boot leg death produces attributable evidence (captured abort output or a typed capture-unavailable marker) on the death-notice rail, redacted and size-bounded
- [ ] The full fast correctness gates stay green; no real-process test joins the correctness tier

## Early proof point

Task that proves the approach: ordinal 1 (the bisect isolates the failing
stage within its first session). If the hand-repro cannot reproduce the
death outside the dispatch machinery: fall back to instrumented evidence
capture on a real dispatch (coordinate with the operator for a one-shot
unpin window) before any fix is attempted.

## References

- Suspect timeline: the ADR-0071 ownership gate + cascade landed on this morning's boot; the codex cutover had pinned claude beforehand, so no wrapped gpt leg exercised the new gate until midday — every launch since dies identically
- docs/adr/0071 (ownership + cascade), 0069 (death notices), 0056 (wrapped window lifecycle) — the saturated decision context; task 2's ADR builds on these
- The wrapped launch chain: manifest partial → keeper-agent flags → shim gate (birth publish → 30s grant wait → execve into pi) → exit-watcher Killed → death notice
- Dispatched windows are remain-on-exit OFF and the leg pane has no login-shell backstop after execve — whether a dead leg pane persists AT ALL is empirical question one
- OPERATOR POST-DEPLOY (not task acceptance): after landing + daemon restart, the operator briefly unpins worker_provider, dispatches one wrapped gpt smoke, verifies a leg boots + writes a transcript + completes, then leaves the provider unpinned per the human's ratified policy

## Docs gaps

- **docs/agent-surface-contracts.md**: revise the run-capture outcome prose in place — what evidence a launch-time death now carries and how it differs from a live-leg partner_died — owned by ordinal 2
- **CONTEXT.md**: the capture artifact gets its own glossary term (the death-notice definition stays folded-event-keyed); the file sits at its size cap — prune-first — owned by ordinal 2
- **docs/problem-codes.md**: only if a new operator-visible code is minted (fold into the wrapped-delegation advisory section)

## Best practices

- **Trust signal over exit code; never equate 137 with OOM** — discriminate parent-initiated kills (cascade) from child self-exits via pane_dead_status + process forensics
- **Capture once at the producer moment, never on a poll**; scrollback is best-effort — a typed capture-unavailable marker beats silence
- **Redact death evidence before persisting** (key-denylist + value patterns, interim inline list) and size-bound everything an attacker-influenceable process can write
