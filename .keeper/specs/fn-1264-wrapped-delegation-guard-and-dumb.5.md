## Description

**Size:** S
**Files:** CLAUDE.md, CONTEXT.md, docs/plugin-composition-map.md, docs/adr/0050-wrapped-delegation-guard.md

Land the durable docs for the guard once its behavior is final. Deferred to this task
(not written at plan time) because CLAUDE.md + CONTEXT.md collide with the in-flight
`fn-1263` epic's task .2 — the epic dep serializes this write behind it.

### Approach

- **CLAUDE.md** Hook rules: revise "Seven hooks" to eight and add a one-clause `wrapped-guard`
  entry in the existing terse cadence (its trigger key `KEEPER_WRAPPED_CELL`, that it denies
  source edits to a marked wrapped worker, its deny-via-envelope / exit-0 / fail-closed-when-marked
  posture in the sibling line). Tighten neighboring clauses to hold the line — `bun scripts/lint-claude-md.ts`
  gates size + bans re-narration.
- **CONTEXT.md**: add entries for the new load-bearing terms — the wrapped-cell marker and the
  provider-leg result envelope — in the `**Term**: definition. Avoid: …` shape, near the existing
  `Wrapped cell` / `Wrapper driver` entries. Do not reintroduce the Avoid-listed "delegated task".
- **docs/plugin-composition-map.md**: fold the marker, the standardized leg-envelope path, and the
  guard into the existing wrapped-cell section (~L85-115); consolidate, do not append. Do not touch
  the unrelated arthack "eight sub-hooks" line at ~L38.
- **docs/adr/**: a new MADR-style ADR recording the marker+guard contract, the single-state
  edit-denial (no envelope gate) rationale, the dumb-courier wrapper, and the fail-closed posture;
  model on `0025-wrong-tree-write-guard.md`, relate to `0010`/`0047`. The integer is assigned at
  merge time (ADR 0020) — do not hardcode a colliding number if the ladder tail moved.

### Investigation targets

*Verify before relying — planner-verified at authoring time; the repo moves.*

**Required:**
- CLAUDE.md — the "Seven hooks under `plugins/keeper/plugin/hooks/`" Hook-rules paragraph.
- CONTEXT.md:42-43 — the `Wrapped cell` / `Wrapper driver` entries to sit beside.
- docs/plugin-composition-map.md — the wrapped-cell delegation section (~L85-115).
- docs/adr/0025-wrong-tree-write-guard.md — the guard-ADR template to model on.

### Risks

- CLAUDE.md/CONTEXT.md overlap `fn-1263.2`; the epic dep on `fn-1263` serializes this — do not drop that dep.
- `lint-claude-md.ts` bans re-narration and size growth; the eighth-hook entry lands by tightening, not appending.

## Acceptance

- [ ] CLAUDE.md Hook rules reads eight hooks with a terse `wrapped-guard` clause, and `bun scripts/lint-claude-md.ts` is green.
- [ ] CONTEXT.md defines the wrapped-cell marker and the provider-leg result envelope in glossary shape.
- [ ] docs/plugin-composition-map.md's wrapped-cell section reflects the marker, envelope path, and guard (consolidated, not appended).
- [ ] A new ADR records the marker+guard contract, single-state edit-denial, dumb-courier wrapper, and fail-closed posture, modeled on 0025 and relating 0010/0047.

## Done summary

## Evidence
