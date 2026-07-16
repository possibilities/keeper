# 0067 — Agent-surface convergence non-goals

## Status

Accepted. Provisional number — fan-in renumbering per ADR 0020/0022.

## Context

`keeper:pair`, `keeper:handoff`, `plan:panel`, and the panel-runner agent share
operational mechanics: chunked waits, the `PANEL_RUN_CONTROL_V1` header, the
nine-key answer envelope, final-message delivery, and idempotent panel start.
Their task framing and lifecycle needs differ, however. The shared mechanics
need one keeper-local reference without collapsing the surfaces that give each
intent its appropriate durability, launch, and synthesis behavior.

## Decision

1. **The panel judge remains a Task subagent, never a keeper agent run.** It is
   an in-context reducer over member answer files and counterbalances
   same-family self-preference. Making it a keeper agent run would add a
   launch, window, and transcript while losing in-context synthesis. The panel
   roster remains governed by [ADR 0046](0046-described-panel-roster-ladder.md).
2. **Durability remains tiered.** Handoff briefs are event-sourced and
   size-bounded because parked delegates survive restarts; pair and panel runs
   remain state-directory ephemeral. Recording ephemeral asks in the event log
   would turn their volume into a re-fold-cost time bomb.
3. **Named skills remain intent presets rather than a god-signature.**
   `keeper:handoff` deliberately forbids waiting by default, and panel
   deliberately forces context isolation. Elicit-an-answer and delegate-work
   remain separate skill families rather than modes on one merged signature.
4. **Shared contracts live in the keeper-local reference document.**
   `docs/agent-surface-contracts.md` is the source for the five shared
   mechanics, rather than vendored corpus snippets. Keeper operational specs
   do not belong in the general-engineering corpus that arthack vendors
   read-only through `vendor.lock` for its engineering/source-dirs domains;
   re-vendoring for each keeper-local edit is the wrong editing loop.
5. **Launch-handle convergence is semantics-only.** Partner names for pair,
   handoff slugs for handoff, and panel run identity for panel remain distinct
   storage keys because they anchor different durability tiers. This preserves
   the launch surface in [ADR 0033](0033-launch-triples-over-named-preset-catalog.md),
   the session-reference and resume distinction in
   [ADR 0062](0062-unified-session-history-and-resume.md), and handoff
   pinnability in [ADR 0040](0040-per-verb-dispatch-table-and-host-agent-pins.md),
   without inventing one key scheme for unlike lifecycles.

## Consequences

- Judging gains no launch, window, or transcript overhead.
- Ephemeral asks add no re-fold cost, and separate skills avoid merged-signature
  semantic drift.
- Keeper-local contract wording stays outside the vendored-corpus drift gate.
- The three launch-handle keys can evolve independently.
