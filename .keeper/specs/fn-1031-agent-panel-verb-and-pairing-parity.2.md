## Description

**Size:** M
**Files:** src/pair/panel.ts, src/agent/config.ts, src/pair-command.ts (role catalog re-export
only, no behavior change), test/agent-panel-cli.test.ts

### Approach

Make `agent panel start` accept an AD-HOC single member so pairing is a panel of one, and port
the `--role` catalog onto the leg via `agent run --system`.

- **Ad-hoc member**: in `runPanel`'s `start` path, when `--panel <name>` is ABSENT but an
  ad-hoc selector is present (`--preset <name>` OR `--cli claude|codex|pi`), resolve a
  SINGLE member and build the same 1-entry manifest shape a configured panel produces
  (`{name,harness,yaml,pidfile}`), then fan it out through the identical detached-leg path.
  `--panel` and the ad-hoc selectors are mutually exclusive (both → exit 2). Thread the
  member's `--model`/`--effort`/`--read-only` onto its `agent run` leg exactly as configured
  members do.
- **Role port**: add `--role default|planner|codereviewer|coplanner` for the ad-hoc member.
  Resolve the role to its prompt text (reuse the existing `src/pair/prompts/<role>.txt`
  loader / `loadRolePrompt`), and pass it to the leg as `agent run --system <text>` (fn-1026's
  seam). `default`/empty → no `--system`. Roles apply ONLY to the ad-hoc single member (a
  configured multi-member panel stays uniform, no per-member roles).
- Keep the configured `--panel` path unchanged; the ad-hoc path is a parallel front-end that
  converges on the same manifest + wait.

### Investigation targets

**Required** (read before coding):
- src/pair/panel.ts: the `start` member-resolution (from `panel.yaml`), the per-member manifest
  build, and the leg argv builder (`buildPanelLegArgv`) — where a `--system`/role and
  model/effort ride onto the `agent run` leg.
- src/agent/config.ts: `resolvePreset`/`resolvePanelMembers` (how a preset resolves to a harness
  + model/effort) — reuse for the ad-hoc `--preset` member.
- src/pair-command.ts: `loadRolePrompt` + `src/pair/prompts/<role>.txt` (the role catalog to
  resolve to text); `PAIR_CLIS`/`PairCli` for `--cli` validation.
- fn-1026's `agent run --system`/`--system-file` handling (the transport the role text rides).

**Optional** (reference as needed):
- plugins/plan/agents/panel-runner.md: confirms the configured-panel drive loop the ad-hoc form
  must stay compatible with (no wait/verdict change).

### Risks

- **Manifest shape invariant** — an ad-hoc member MUST produce the identical
  `{name,harness,yaml,pidfile}` entry so `wait`/verdict/`panel-runner` are unaffected.
- **Mutual exclusion** — `--panel` vs `--preset`/`--cli` both-set → exit 2 (one selector).
- **Roles are single-member only** — do not add per-member roles to a configured panel.
- **Pair byte-stable** — the role catalog is re-used read-only; `pair send`'s own role handling
  is untouched. Golden + pair-cli green.
- **`--read-only` rides as prompting-only** post-fn-1030 (no tool-strip); the ad-hoc leg simply
  forwards `--read-only` to `agent run`.

### Test notes

Extend `test/agent-panel-cli.test.ts`: an ad-hoc `--preset` member and an ad-hoc `--cli` member
each produce a 1-entry manifest and a leg argv carrying the resolved harness/model/effort;
`--role codereviewer` puts the role text on the leg as `--system`; `--panel` + `--preset`
together → exit 2. Pure tier; reuse the faked detachment harness. Keep pair tests green.

## Acceptance

- [ ] `agent panel start --preset <name>` / `--cli <x>` builds a 1-member manifest and fans out
  via the same detached-leg path; `--panel` + ad-hoc selector together → exit 2.
- [ ] `--role` resolves the catalog text and rides the leg as `agent run --system`; default/empty
  → no system block; roles apply only to the ad-hoc single member.
- [ ] `--model`/`--effort`/`--read-only` thread onto the ad-hoc leg like configured members.
- [ ] Configured `--panel` path, `wait`/verdict, and pair send UNCHANGED; golden + pair-cli +
  pair-panel green; `bun test` + `bun run typecheck` green.

## Done summary
Added the ad-hoc single-member (panel-of-one) form to agent panel start: --preset/--cli resolve one member on the same manifest + detached-leg path, mutually exclusive with --panel; --role rides the leg as agent run --system; --model/--effort/--read-only thread onto the ad-hoc leg (agent run gained --model/--effort passthrough). Configured panels + pair stay byte-stable.
## Evidence
