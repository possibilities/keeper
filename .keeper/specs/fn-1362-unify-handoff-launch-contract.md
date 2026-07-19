## Overview

Make Handoff launch posture independent from result capture and reduce every fresh Handoff prompt to one exact `/hack <Brief>` composition. The caller owns the Brief mandate, while a non-empty `KEEPER_HANDOFF_ENVELOPE` lets `/hack` preserve captured autonomy and the canonical terminal deliverable without launcher-authored framing.

## Quick commands

- `bun test test/handoff.test.ts test/handoff-worker.test.ts test/exec-backend.test.ts test/config.test.ts`
- `bun scripts/vendor-corpus.ts --check`

## Acceptance

- [ ] Ordinary and captured handoffs accept either a Launch triple or a complete model/effort pair, reject mixed or partial selectors, and preserve the selected harness through launch.
- [ ] Every fresh Handoff reaches its harness with exactly `/hack ` followed by the raw stored Brief; capture and launcher configuration add no prompt prose.
- [ ] A non-empty `KEEPER_HANDOFF_ENVELOPE` gives `/hack captured autonomy and canonical envelope publication, while an empty carrier retains ordinary confirmation behavior.
- [ ] Caller-facing handoff guidance makes the caller responsible for a self-contained mandate and describes launch selection independently from capture.

## Early proof point

Task that proves the approach: task 1. If raw Launch triple propagation cannot compose with the shared launcher, retain the existing parsed harness/model/effort seam while preserving the same observable selector behavior.

## References

- `docs/adr/0094-handoff-prompt-and-launch-selection-contract.md`
- `docs/adr/0033-launch-triples-over-named-preset-catalog.md`
- `docs/adr/0040-per-verb-dispatch-table-and-host-agent-pins.md`
- `docs/agent-surface-contracts.md`

## Docs gaps

- **docs/agent-surface-contracts.md**: consolidate the ordinary/captured Handoff prompt and envelope-carrier contract.
- **plugins/keeper/skills/handoff/SKILL.md**: teach caller-owned mandates and launch selection independent of capture.
- **docs/install.md**: clarify that `dispatch.handoff` selects launch posture independently of capture.

## Best practices

- **Selector sum type:** validate exactly one Launch triple or complete model/effort pair identically at CLI and RPC boundaries.
- **Prompt/data separation:** keep capture metadata in the environment carrier and the caller's mandate in the Brief.
- **Argument fidelity:** pass prompts and selectors as argv entries without shell concatenation, and byte-pin Unicode, whitespace, and shell metacharacters.
