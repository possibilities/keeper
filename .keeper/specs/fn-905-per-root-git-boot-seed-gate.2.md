## Description

**Size:** M
**Files:** src/readiness.ts, src/autopilot-worker.ts, src/readiness-client.ts, src/server-worker.ts, src/protocol.ts, test/readiness.test.ts, test/autopilot-worker.test.ts, CLAUDE.md, README.md

### Approach

Replace the blanket `gitSeedRequired` overwrite with a per-root gate.

Today `computeReadiness` takes a trailing `gitSeedRequired: boolean`
(`readiness.ts:363`) and, when true, overwrites EVERY `perTask`/`perCloseRow`
verdict to `{kind:unknown}` (`:505-509`). Change the signal to a per-root
shape (e.g. `unseededRoots: Set<string>`, empty ⇔ today's `false` so the
simulator/re-fold default is byte-identical) and force `unknown` ONLY for a
row whose `effectiveRoot` is in the set. Key on the canonical
`effectiveRoot` (`readiness.ts:1315-1323`) — identical to the per-root mutex
— so the gate and the dispatch root-resolution never drift; `""` (rootless)
is treated as ungated.

Producers of the set:
- **autopilot-worker** (`loadReconcileSnapshot` ~`:1618`) computes it from its
  own DB connection: a root is unseeded iff `seed_required` is set AND it has
  no `git_status` row with `last_event_id > git_projection_state.floor`. Pass
  to `computeReadiness` (~`:925`). Mirror `effectiveRoot` (`:1010-1018`).
- **server-worker** `readBootStatus` (`:1824-1864`) computes the same set and
  ships it on `BootStatus` (additive field, `protocol.ts:100-105`), so the
  board (`readiness-client.ts` latch `:1379`/`:1644-1647`, call `:1606-1608`)
  renders the SAME per-root `unknown` — fixing the `[::ready]`-while-autopilot-
  dark divergence. Keep a coarse "any gated root unseeded" boolean on
  `BootStatus` for `catching_up` (`server-worker.ts:1861`); keep the
  `gitCleanState` consumer (`await-conditions.ts`) coarse for now (note
  per-root as a follow-up — it is out of this epic's named scope).

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:363 — the `gitSeedRequired` param; :505-509 — THE GATE (the blanket overwrite to make per-root); :1315-1323 — canonical `effectiveRoot`; :1083-1154 — per-root mutex keying to mirror
- src/autopilot-worker.ts:404 — snapshot type; :1010-1018 — inline `effectiveRoot` mirror; :1618 — seed read; :908-925 — `computeReadiness` call
- src/readiness-client.ts:1379 — latch init; :1644-1647 — `onBootStatus`; :1606-1608 — `computeReadiness` call
- src/server-worker.ts:1824-1864 — `readBootStatus` + `catching_up` coupling (:1861)
- src/protocol.ts:100-105 — `BootStatus` (additive field, forward-compat note :97-98)

**Optional** (reference as needed):
- test/readiness.test.ts:3797-3843 — the exact fn-897 `gitSeedRequired` test to extend per-root; :1025/:1032 — cross-root `/repo-a` vs `/repo-b` fixtures

### Risks

- `computeReadiness` is shared by autopilot, board, AND the simulator/re-fold caller — the new default (empty set) MUST reproduce byte-identical re-fold; enumerate every caller.
- The two `effectiveRoot` mirrors (readiness canonical + autopilot inline, "MUST mirror" charter) must change identically — if the gate keys differently than dispatch, the autopilot could gate root A but dispatch to root B.
- A close row for a done-but-unreaped epic must not stall against a dropped root — confirm the per-root gate plays correctly with terminal/close-row verdicts.

### Test notes

Extend test/readiness.test.ts: one unseeded root forces `unknown` ONLY on its own rows while a seeded sibling root stays `ready` (cross-root fixture); empty set ⇔ no gating (re-fold default). autopilot-worker test for the set computation. `bun run test:full`.

### Detailed phases

1. readiness.ts — signature `boolean → Set<string>`, per-root gate at the overwrite site, key via `effectiveRoot`, default empty.
2. autopilot-worker.ts — compute `unseededRoots` from DB in `loadReconcileSnapshot`, pass it; mirror `effectiveRoot`.
3. server-worker.ts + protocol.ts — compute + ship the seeded/unseeded set on `BootStatus`; keep coarse `catching_up` boolean.
4. readiness-client.ts — latch the new field, pass to `computeReadiness`.
5. tests (readiness + autopilot-worker); then CLAUDE.md + README prose to the per-root, self-clearing model.

## Acceptance

- [ ] The readiness gate forces `unknown` per-root (only rows whose `effectiveRoot` is unseeded), keyed via the canonical `effectiveRoot`; `""` rootless rows are ungated.
- [ ] An unseeded/stale root blocks only its own rows; a seeded sibling dispatches.
- [ ] The board renders the same per-root `unknown` as the autopilot (the `[::ready]`-while-dark divergence is gone).
- [ ] Coarse `catching_up` semantics preserved; `gitCleanState` left coarse (follow-up noted).
- [ ] Re-fold byte-identical (empty set default); no schema change.
- [ ] CLAUDE.md + README updated to the per-root, self-clearing gate.
- [ ] `bun run test:full` green.

## Done summary

## Evidence
