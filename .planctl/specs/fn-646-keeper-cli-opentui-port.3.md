## Description

**Size:** S
**Files:** cli/usage.ts (moved from scripts/usage.ts), test/usage.test.ts, cli/keeper.ts

Cut `keeper usage` over to the new renderer. Usage is the dual-handle
case (two `subscribeCollection` calls composed into one frame) and the
`refreshLive` tick case (30s `setInterval` recomputing relative-time
cells, guarded by a `linesEqual` skip). Plain text — no ANSI shim.

### Approach

Move `scripts/usage.ts`→`cli/usage.ts`, `main`→`main(argv)`, neutralize
the `import.meta.main` guard, wire into `cli/keeper.ts`. Preserve the
three-handle SIGINT teardown (`liveShell.dispose()` then both
`usageHandle` + `jobsHandle`). Confirm the 30s `refreshLive` tick maps
onto the new overlay semantics: dormant when scrolled back, applied on
snap-to-live, identical-text no-op (no 30s flicker). Update
`test/usage.test.ts` import path; exported `renderRowLines`/
`renderSessionLines` stay.

Note the `fn-645` overlap: if that epic's usage status/error work lands
first, fold its ticking-relative-stamp render into the same
`refreshLive` path rather than re-introducing a `live-shell` pattern.

### Investigation targets

**Required** (read before coding):
- scripts/usage.ts:704-710 — 30s `refreshLive` tick + `linesEqual` skip guard
- scripts/usage.ts:768 — three-handle SIGINT teardown
- scripts/usage.ts — two `subscribeCollection` calls (usage + jobs) composed into one frame; exported render fns

**Optional:**
- src/live-shell.ts (post-`.2`) — the new `refreshLive` overlay semantics to verify against

### Risks

- The `refreshLive` overlay must be a true no-op on identical text or the 30s tick flickers.
- `fn-645` file overlap on `scripts/usage.ts` — coordinate ordering.

### Test notes

Update import paths; render-fn tests stay green. Manually verify the
relative-time tick advances live and does not bleed into a held frame.

## Acceptance

- [ ] `keeper usage` renders UI-identical to `bun scripts/usage.ts`, including the live 30s relative-time tick (no flicker, dormant when scrolled back).
- [ ] Dual subscribe + three-handle SIGINT teardown preserved.
- [ ] `cli/usage.ts` wired into the dispatcher; `test/usage.test.ts` green.

## Done summary
Ported scripts/usage.ts to cli/usage.ts and wired into keeper dispatcher; preserved dual subscribeCollection composition, 30s refreshLive tick with linesEqual no-op, and three-handle SIGINT teardown.
## Evidence
