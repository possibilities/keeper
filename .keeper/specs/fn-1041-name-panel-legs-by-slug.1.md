## Description

**Size:** M
**Files:** src/slug.ts (new), src/handoff-slug.ts, src/pair/panel.ts, src/agent/dispatch.ts, test/slug.test.ts (new), test/agent-panel-cli.test.ts, test/pair-panel.test.ts, plugins/plan/skills/panel/SKILL.md, plugins/plan/agents/panel-runner.md, plugins/keeper/skills/pair/SKILL.md, README.md

### Approach

Extract the pure slug primitives (`slugifyHandoffSlug`, `validateHandoffSlug`,
`HANDOFF_SLUG_MAX_LEN`, `ValidateSlugResult`) out of `src/handoff-slug.ts`
into a new dep-free `src/slug.ts` leaf with GENERIC wording ("slug…", not
"handoff slug…"); `src/handoff-slug.ts` re-exports them (and keeps
`handoffSlugExists` + its `bun:sqlite` import) so `src/daemon.ts:94`,
`src/rpc-handlers.ts:50`, and `cli/handoff.ts:45` resolve unchanged. If
handoff's existing tests assert the "handoff slug" wording, keep thin
handoff-scoped wrappers there so handoff behavior is byte-identical.

In `src/pair/panel.ts`: add `slug` to `PanelStartArgs`; in `runPanel`'s
`start` branch parse `--slug` and apply the require→slugify→fail-loud gate
(mirror `cli/handoff.ts:286-294`) emitting a panel-scoped exit-2 message
(never the leaf's raw string) for BOTH absent and slugifies-to-nothing;
thread the slug into `panelStart` → each `buildPanelLegArgv` call, appending
`--name panel::<slug>::<member.name>` to every leg (configured + ad-hoc).
Import the slug primitives from `src/slug.ts` ONLY — importing from
`handoff-slug.ts` would re-drag `bun:sqlite` into the panel leaf and defeat
the extraction. Add a top-level `slug` field to `PanelManifest` (written in
`panelStart`, parsed in `parseManifest`) for run correlation. Update
`PANEL_HELP` and both `src/agent/dispatch.ts` synopsis surfaces.

Update the callers so nothing exits 2 under the now-required flag:
`panel/SKILL.md` auto-derives a slug and injects a `Slug: <derived>` line in
the `Task()` prompt; `panel-runner.md` forwards `--slug "$SLUG"` and
self-derives a fallback if the line is absent; `pair/SKILL.md` auto-derives
inline (piggyback its existing "pick a sensible default, don't stall"
guidance). Update README (panel line + spawn-name class).

### Investigation targets

**Required** (read before coding):
- src/handoff-slug.ts:15,20,32,58 — the primitives to extract; line 15 `import type { Database }` + `handoffSlugExists` (line 98) MUST stay put
- cli/handoff.ts:45,286-294 — the importer + the require→slugify→fail-loud idiom to mirror
- src/pair/panel.ts:94,213-216,299,309,358,584,599,672-704,828-862,884-985 — PanelMember, member-resolution, buildPanelLegArgv, PanelStartArgs, panelStart member loop + manifest write, PANEL_HELP, runPanel start parse
- src/agent/main.ts:1979-1997 — explicit-`--name` suppresses auto session-name resolution (the load-bearing passthrough)
- src/agent/config.ts:302 — `PRESET_NAME_PATTERN` guarantees `<preset>` (member.name) is `[a-z0-9_-]+` (no path separators)
- src/agent/dispatch.ts:84,218 — the two extra `panel start` synopsis surfaces
- src/derivers.ts:34,48 — confirm `panel::<slug>::<preset>` matches neither regex (no new deriver)

**Optional** (reference as needed):
- src/daemon.ts:94, src/rpc-handlers.ts:50 — the other two importers the re-export must keep whole
- test/handoff-slug.test.ts — the table-driven edge-case template for test/slug.test.ts
- README.md:25-28 (spawn-name classes), README.md:~1405 (panel line)

### Risks

- Breaking contract: the required flag exits 2 on every un-updated caller — the two skills + README + all fixtures MUST land in THIS change (atomic).
- Re-export incompleteness silently breaks the build (`ValidateSlugResult` type included) — verify all three external importers + handoff tests after the move.
- Importing slug from `handoff-slug.ts` instead of `slug.ts` re-drags `bun:sqlite` into the dep-free panel leaf — the one hard don't.

### Test notes

- `test/slug.test.ts`: table-driven (NFKD/accents, run-collapse, length-cap + trailing-hyphen trim, empty-after-transform → null, reject caps/underscore/space/`.`/`..`/all-hyphen), mirroring test/handoff-slug.test.ts.
- `test/agent-panel-cli.test.ts`: (1) `buildPanelLegArgv` asserts `--name panel::<slug>::<preset>`; (2) `runPanel start` missing AND empty `--slug` → exit 2 with the distinct panel-scoped stderr; (3) `panelStart` fan-out asserts each leg's `--name` uses its per-member preset; (4) update the `USAGE`-substring assertion (~:283) to require `--slug`.
- Update every existing `panel start` fixture (`agent-panel-cli.test.ts:243/578/599`, `pair-panel.test.ts`) to pass `--slug`; keep exit-2 assertions disambiguated from config/mutual-exclusion faults.
- Injected `deps.spawn` captures argv — no daemon/tmux/subprocess boot.

## Acceptance

- [ ] `keeper agent panel start` without `--slug` (and with a slugifies-to-nothing `--slug`) exits 2 with a distinct panel-scoped message
- [ ] `src/slug.ts` is a dep-free leaf (no `bun:sqlite`); `src/pair/panel.ts` imports slug primitives from it; `bun run typecheck` confirms no `bun:sqlite` in the panel graph
- [ ] `src/handoff-slug.ts` re-exports moved symbols + type; `src/daemon.ts`, `src/rpc-handlers.ts`, `cli/handoff.ts` build; handoff error wording + tests unchanged
- [ ] Configured-panel and ad-hoc legs both launch with `--name panel::<slug>::<member.name>`
- [ ] `manifest.json` carries a top-level `slug` field; `parseManifest` accepts it
- [ ] `--slug` present in PANEL_HELP + `dispatch.ts` USAGE + KEEPER_AGENT_HELP, all with absent-slug in the exit-2 causes
- [ ] `panel/SKILL.md` injects a `Slug:` line; `panel-runner.md` forwards `--slug` and self-derives a fallback; `pair/SKILL.md` passes an auto-derived `--slug`
- [ ] README: panel line revised + `panel::<slug>::<preset>` registered as a spawn-name class beside `handoff::<slug>`
- [ ] `bun run lint && bun run typecheck && bun test` all green

## Done summary
Extracted pure slug primitives into a dep-free src/slug.ts leaf (handoff-slug.ts re-exports with preserved wording); made 'keeper agent panel start' require --slug and name every leg panel::<slug>::<preset>, threaded through manifest + PANEL_HELP + dispatch synopses + README spawn-name class, with the panel/pair skills and panel-runner auto-deriving and forwarding the slug.
## Evidence
