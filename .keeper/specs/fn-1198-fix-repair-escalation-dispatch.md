## Overview

The SHARED_BASE_BROKEN self-heal route never fires: three workers stamped baseline-confirmed SHARED_BASE_BROKEN blocks and the block-escalation rows sat pending for hours on a healthy, unpaused daemon — no repair::<repo> session was ever dispatched, and an operator repaired trunk by hand. This epic confirms which silent gate dropped all three candidates, fixes it, and makes any future non-dispatch observable instead of invisible.

## Quick commands

- `bun test test/daemon.test.ts` — escalation sweep suites (injected-deps pattern)
- `keeper query block_escalations --json` — post-deploy: no pending rows without a matching dispatch decision

## Acceptance

- [ ] A task blocked with a SHARED_BASE_BROKEN-prefixed reason on an unpaused board yields a repair dispatch decision within one sweep cycle (proven at the pure sweep seam)
- [ ] The regression proof writes the block reason through the real plan state writer and reads it through the sweep's real reader — no mocked reason-read
- [ ] Every silent candidate-drop gate emits an observable, class-stable diagnostic

## Early proof point

Task that proves the approach: `.1`. If the root cause turns out to be outside the candidate-selection gates (e.g. dispatch-cap starvation), the same round-trip test still pins the corrected end-to-end behavior — refit the fix location, not the proof.

## References

- docs/adr/0017-trunk-repair-escalation-and-role-keyed-guard.md — the design contract; reconcile the record with shipped behavior once the root cause is confirmed
- Incident evidence (keeper.db events, read live during the incident): block events id 4905460 (fn-1184.1), 4912298 (fn-1192.1), 4912637 (fn-1182.1) — full `keeper plan block` commands with SHARED_BASE_BROKEN reasons; block_escalations rows sat status=pending, outcome=null, human_notified_at=null for hours; autopilot unpaused (yolo) throughout the observed window; no repair::* job ever appeared in the jobs projection
- Ruled out: crash-loop starvation (all daemon bounces post-date the block window) and the paused-board gate

## Docs gaps

- **docs/adr/0017**: reconcile the decision record with actual shipped behavior once the confirmed root cause lands
- **plugins/keeper/skills/watch/SKILL.md**: the "daemon's own escalation sweeps handle most stuck closes" framing — verify it holds once repair dispatch actually fires

## Best practices

- **Silent drops are the enemy**: every `continue` in a candidate selector should leave a trace — the incident was invisible precisely because zero of ~6 gates record why they dropped [gap-analyst]
