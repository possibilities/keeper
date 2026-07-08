## Description

**Size:** M
**Files:** src/readiness-client.ts, src/view-shell.ts, src/server-worker.ts, test/readiness-client.test.ts, test/view-shell.test.ts

### Approach

Reproduce first, at the pure seams (no real daemon in tests): drive the client through a simulated daemon bounce — socket teardown, reconnect, and the quiet-board variant where no new frames arrive post-reconnect — and identify which leg fails: (1) loss detection (the incident pattern suggests the viewer may never notice a dead subscription when the daemon's restart leaves the socket half-open), (2) resubscription, or (3) the post-reconnect re-baseline, including the ADR-0019 trap where a client whose last result landed pre-boot-complete holds catching_up forever because patch/meta frames carry no boot header. Fix the confirmed leg with the epoch-guard direction: the client tracks a daemon generation (from the boot-status header or a minimal new emission if none exists on the wire), treats any generation change as resume-invalid, and forces resubscribe → fresh snapshot → full repaint. The reconnecting pill must resolve — either to a repaint or to a visible failure state — never to a silent stale hold. Confirm the board's data path rides the read socket via readiness-client (the bus-worker channel evictions at boot are believed unrelated to this defect; verify rather than assume).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/readiness-client.ts:1-53, 299-341 — reconnect machinery (capped backoff, reconnect-forever, first-paint gate, teardown→reconnect deadlines)
- src/view-shell.ts:402 — "so the next post-reconnect snapshot always paints" (the intent this bug violates); :582 baseline-on-first-accepted-frame; :621-631 reconnecting pill semantics; :148 reparent-after-death baseline
- docs/adr/0019 — the catching_up trap mechanics

**Optional** (reference as needed):
- cli/watch.ts:822-852 — the CLI tail's reconnect-forever contrast reference
- src/frames-emitter.ts, cli/frames.ts — the frames surface for regression coverage
- src/bus-worker.ts:216-303 — channel takeover eviction (suspected red herring; rule in/out)

### Risks

- The fix may need a server-side generation signal; keep that emission minimal and backward-compatible (old clients ignore it) — the client contract is the deliverable.
- Reconnect-storm flicker during a crash loop: debounce the re-baseline repaint so a bouncing daemon doesn't thrash the terminal.

### Test notes

Pure-seam tests: injected transport driving loss → reconnect → quiet-board and loss → reconnect → new-generation sequences, asserting full-repaint (baseline) frames and cleared catching_up/reconnecting state; frames-surface regression demonstrating a repaint after a simulated bounce. No real daemon/UDS in the fast tier.

## Acceptance

- [ ] The failing leg is named and documented in the Done summary with the reproducing test
- [ ] Simulated bounce sequences (quiet-board and new-generation variants) converge to a full re-baseline repaint at the client seam, never a stale hold
- [ ] A generation change across reconnect invalidates any resume and forces the snapshot path
- [ ] The reconnecting indicator resolves on reconnect (repaint or explicit failure), covered by test
- [ ] keeper fast suite green

## Done summary

## Evidence
