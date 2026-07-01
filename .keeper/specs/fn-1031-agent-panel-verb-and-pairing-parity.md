## Overview

Bring `keeper agent` to full functional parity with `keeper pair` — ADDITIVELY, with `keeper
pair` left byte-stable — so pair can be retired in a follow-up. Two additions:

1. **`keeper agent panel start|wait`** — expose the existing panel machinery (already emits
   `keeper agent run` legs) under the `agent` namespace. The subcommand owns all detachment +
   token-free chunked polling; no Monitor, no model-level polling.
2. **Ad-hoc single member (pairing = a panel of one).** `panel start` gains an ad-hoc member
   form (`--preset <name>` or `--cli <x>` [+ `--role`/`--model`/`--effort`/`--read-only`]) beside
   the configured `--panel <name>` form. A single second-opinion is a 1-member panel — same
   detached-start + chunked-wait mechanism `plan:panel-runner` already uses. This is the
   Monitor-free replacement for `pair send`'s drive loop.

Also port the `--role` catalog (default/planner/codereviewer/coplanner) onto the agent path:
a role resolves to its prompt text and rides the leg as `agent run --system` (fn-1026's seam) —
so "review this" / "co-plan" partners keep their framing.

NOTHING is removed here. `keeper pair send`/`pair panel`, `cli/pair.ts`, and `src/pair-command.ts`
stay exactly as they are; the golden + pair-cli tests stay green. The retirement is P2.

## Quick commands

- `bun run test` — full suite green
- `bun run typecheck` — `tsc --noEmit` clean
- (out-of-band) `keeper agent panel start /tmp/ask.md --preset codex-review --read-only` then
  `keeper agent panel wait --dir <d> --chunk 540` — a 1-member ad-hoc panel (pairing)
- (out-of-band) `keeper agent panel start /tmp/q.md --panel default` — the configured N-member panel

## Acceptance

- [ ] `keeper agent panel start|wait` behaves identically to `keeper pair panel start|wait`
  (shared machinery; same manifest/verdict JSON, same exit semantics 0/124/2).
- [ ] `panel start` accepts an ad-hoc single member (`--preset`/`--cli` [+ `--role`/`--model`/
  `--effort`/`--read-only`]) → a 1-member manifest; `--role` resolves to `--system` text on the leg.
- [ ] `keeper pair` (send + panel), `cli/pair.ts`, `src/pair-command.ts` UNCHANGED; golden +
  pair-cli byte-stable. `bun test` green.

## Early proof point

Land `keeper agent panel start|wait` (namespace + routing) FIRST and prove it matches
`keeper pair panel` on a configured panel. Then add the ad-hoc single-member form. If the role
port is contentious, ship panel parity + ad-hoc member without `--role` and add roles in a
follow-up — the panel-of-one still works, just without preset-less role framing.

## References

- The panel machinery (`src/pair/panel.ts`) already launches `keeper agent run --read-only`
  legs writing per-leg JSON envelopes via `--output`, and `wait` polls terminality on a
  `Date.now()` deadline (chunked, token-free). Only the CLI NAMESPACE is pair-bound; the engine
  is agent-native. Do NOT rebuild it — route to it.
- `plan:panel-runner` is the reference driver: detached `start` (returns at once) + a re-issued
  blocking `wait --chunk` loop, backstop-bounded. The `keeper:pair` skill will adopt the same
  shape in P2; this epic just makes `agent panel` the command it drives.
- Pairing = a panel of one. Rather than a separate `send` verb with a bespoke event contract,
  a single partner is an ad-hoc 1-member panel — one mechanism serves both.
- `--role` today: `loadRolePrompt` reads `src/pair/prompts/<role>.txt`; fn-1026 gave `agent run`
  `--system`/`--system-file`. A role resolves to that text on the leg — no new prompt transport.
- This is additive parity; the pair CLI retirement (skill/consumer repoint, shared-cluster move,
  `cli/pair.ts` deletion, retired-name guard) is the P2 follow-up that depends on this.

## Docs gaps

- **`src/agent/dispatch.ts` (`USAGE` + `KEEPER_AGENT_HELP`)**: add the `keeper agent panel
  start|wait` synopsis (members from `--panel <name>` OR an ad-hoc `--preset`/`--cli`; the
  start/wait exit semantics 0/124/2). Part of the deliverable.
- **`cli/agent.ts` header**: note the new `panel` sub-verb.
- Do NOT rewrite the pair SKILL.md / panel-runner.md here — those repoint in P2 (keep this epic
  additive and pair byte-stable).

## Best practices

- **Route, don't duplicate** — `agent panel` dispatches into the SAME `runPanel` the pair verb
  calls; a single implementation, two namespaces during the transition.
- **Ad-hoc member is a thin front-end** — resolve `--preset`/`--cli` (+role/model/effort) into the
  SAME per-member manifest shape a configured panel produces, so `wait`/verdict are unchanged.
- **Keep pair byte-stable** — add code paths; touch no existing pair path. The golden + pair-cli
  tests are the guard.
