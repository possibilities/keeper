## Overview

TUI viewers (keeper board and siblings) can render stale state after a daemon bounce until manually restarted — human-confirmed recurring, and the buildbot bounces keeperd on every deploy, so it fires constantly. The reconnect machinery largely exists (capped-backoff reconnect-forever, a reconnecting pill, post-reconnect snapshot repaint intent), so the defect is in one of three legs: loss detection (a silently-dead socket that never tears down), resubscription, or the post-reconnect re-baseline (including the ADR-0019 catching_up trap where patch/meta frames carry no boot header). This epic reproduces the failure under a controlled bounce, identifies the failing leg, and fixes it so a viewer always converges to fresh state without restart.

## Quick commands

- `bun test test/view-shell.test.ts test/readiness-client.test.ts` — client resync suites
- Post-deploy: bounce keeperd under an open `keeper board` and confirm the view repaints without restart

## Acceptance

- [ ] A simulated connection loss and reconnect at the client seam produces a full re-baseline repaint (never a stale hold or a patch-resume from a dead sequence)
- [ ] A daemon-generation change across reconnect is detected and forces the re-baseline path
- [ ] The stuck-catching_up-on-a-quiet-board trap is covered by a regression

## Early proof point

Task that proves the approach: `.1`. If the failing leg turns out to be server-side (no detectable generation signal exists on the wire), scope a minimal server emission and keep the client fix; the client-side repaint contract stands either way.

## References

- docs/adr/0019-tui-readiness-gate-over-boot-status.md — the readiness-gate contract; patch/meta frames carry no boot header (the catching_up trap)
- Commit 51a05bc2 — gated live TUI rendering on daemon readiness (adjacent recent work)
- Incident evidence: board TUI held a closed epic on screen across multiple daemon bounces (restart ledger 3 boots in 26 min) until the viewer was restarted; bus-worker logged channel takeover evictions at each boot (bus path is the suspected red herring — the board rides the read socket via readiness-client)

## Docs gaps

- **docs/adr/0019**: amend with the resubscribe/re-baseline protocol decision once landed
- **CONTEXT.md** (Catching up entry): reconcile "carried on every boot-status header" wording with which frames actually carry boot status after the fix

## Best practices

- **Epoch/generation guard**: never resume a stored sequence across a daemon generation change — re-baseline instead [practice-scout]
- **Snapshot-first resync**: reconnect → resubscribe → fresh snapshot repaint → then live frames beyond the snapshot's high-water mark; idempotent replace-by-key apply [practice-scout]
- **App-level loss detection**: a silently-evicted subscription can look open at the transport layer; detection must not rely on EOF alone [practice-scout]
- **Jittered capped backoff** so a fleet of stale viewers doesn't stampede the accept path at boot [practice-scout]
