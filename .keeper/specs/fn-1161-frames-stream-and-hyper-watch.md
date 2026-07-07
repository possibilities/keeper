## Overview

Give supervising agents a purpose-built frame stream — `keeper frames`, one
NDJSON envelope per rendered TUI frame with bounded-chunk consumption and an
honest coverage contract — and grow the keeper:watch skill into a three-mode
supervisor (supervision sweep / hyper / pilot) whose hyper mode audits every
frame from a human's point of view. Companion prose: cross-cutting bus-health
checks, mid-watch ad-hoc imperatives, and the autopilot armed-mode recipe.

## Quick commands

- `keeper frames --view board --max-frames 3 --for 10s | head -5` — smoke: parseable NDJSON envelopes then a trailer line
- `keeper frames --agent-help` — the agent-facing runbook renders
- `bun test test/frames-emitter.test.ts` — the wire contract's pure tier

## Acceptance

- [ ] An agent can consume bounded frame chunks of all six viewers (board, jobs, git, autopilot, builds, usage) with a resume cursor and an honest continuous/gap_possible coverage verdict
- [ ] The watch skill advertises and teaches three modes; hyper mode reads bounded frame chunks and splits findings into real-problem vs UI-defect routes
- [ ] The autopilot skill teaches narrow-to-armed-then-restore-yolo by citation of its existing take-over window
- [ ] Bus-health checking runs in every watch mode using existing read surfaces only

## Early proof point

Task that proves the approach: ordinal 1 (the frames-emitter wire contract in
pure tests). If it fails: revisit the envelope/trailer shape against the
pure-test constraint before any shell integration lands.

## References

- docs/adr/0012-agent-frame-stream-wire-contract.md — the settled wire contract and its rationale
- cli/watch.ts createDeltaEmitter — seq/keepalive/envelope machinery to mirror (NOT its coalesce/flap-settle)
- src/snapshot.ts:33 — the dual-consumer "contract can never drift" invariant the shared emitter extends
- src/protocol.ts BootStatus.rev — the resume-cursor source; cli/status.ts:397,573 is the consumer template
- No open epics on the board — zero inter-epic deps or overlaps (epic-scout, all 50 done)

## Docs gaps

- **README.md**: add `keeper frames` to the CLI roster line (~L158) and a phrase at the "No UI" line (~L40) acknowledging the agent-consumable NDJSON inspection surface (delivered by the subcommand task)
- **CLAUDE.md**: consider ONE line pinning the "frames emitter is consumed by both createViewShell and usage's open-coded path — never re-open-code it" invariant
- **CONTEXT.md**: optional glossary parity for frame / resume cursor / coverage verdict / hyper mode — offer to the human at close, do not auto-write

## Best practices

- **Monotonic-id cursors, never wall-clock:** timestamp resume is fuzzy under clock skew and identical-ts boundaries (the docker --since failure mode); bind to the fold cursor [K8s resourceVersion / journalctl / Kafka offsets]
- **Always emit the trailer:** on --max-frames, --for timeout, and SIGINT alike — without it the consumer cannot safely resume [Kafka commit discipline]
- **Mechanical pre-filter before LLM judgment:** empty-diff/no-op verdicts are pure checks costing zero tokens; reserve the model for truthfulness/legibility calls [LLM-observability 2026]
- **Ratchet + dedup findings:** first occurrence files, repeats increment, re-notify only on change — the antidote to re-discovering known issues [alert-fatigue literature]
- **Own your /tmp GC:** never rely on OS cleanup; in-process ring over own files only, so no live sibling's artifacts are ever clobbered
