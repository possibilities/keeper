## Overview

`keeper agent panel start` gains a REQUIRED `--slug`, and every detached
panel leg is launched as `keeper agent run --name panel::<slug>::<preset>`
(where `<preset>` is the member's preset name). This replaces the leg's
current auto-resolved `{cwd}-NNN` / prompt-derived name so each panelist is
identifiable in tmux and forensics by which panel run and which preset it is.
The mechanism mirrors `keeper handoff --slug` in most ways: a required,
slugified, shape-validated identifier authored by the invoking agent. It
differs in one deliberate way — panels are ephemeral, so there is NO
uniqueness enforcement, NO DB row, NO event, NO RPC, and NO new deriver; the
slug is a pure display/forensics string. The slug also becomes the stable,
rediscoverable key a follow-on stateful/resumable-panels epic will build on.

## Quick commands

- `keeper agent panel start /tmp/q.md --slug my-run --cli codex --read-only` — a leg named `panel::my-run::codex`
- `keeper agent panel start /tmp/q.md --cli codex` — now exits 2 (absent `--slug`)
- `bun run lint && bun run typecheck && bun test` — green

## Acceptance

- [ ] `keeper agent panel start` requires `--slug`; absent or slugifies-to-nothing → exit 2 with a distinct panel-scoped message (mirrors `cli/handoff.ts:286-294`)
- [ ] Slug primitives live in a new dep-free `src/slug.ts`; `src/pair/panel.ts` imports them from there (NEVER `src/handoff-slug.ts`), keeping the panel leaf `bun:sqlite`-free
- [ ] `src/handoff-slug.ts` re-exports the moved symbols; `src/daemon.ts`, `src/rpc-handlers.ts`, `cli/handoff.ts` still resolve and handoff behavior + error wording is unchanged
- [ ] Every leg (configured-panel AND ad-hoc forms) launches with `--name panel::<slug>::<member.name>`
- [ ] `--slug` is documented in all three synopsis surfaces and the two invoking skills auto-derive + pass it
- [ ] `panel::<slug>::<preset>` is registered in the README spawn-name-class section parallel to `handoff::<slug>`
- [ ] Full suite green; every existing `panel start` fixture updated to pass `--slug`

## Early proof point

Task that proves the approach: `.1` — the `buildPanelLegArgv` unit test
asserting a leg carries `--name panel::<slug>::<preset>` and the `runPanel`
missing-`--slug` → exit-2 test. If it fails: the `--name` passthrough
assumption (`src/agent/main.ts:1979-1997`) is wrong — fall back to a dedicated
`legName` opt threaded end-to-end before touching callers.

## References

- `src/handoff-slug.ts` — the slugify/validate template being extracted + mirrored
- `cli/handoff.ts:286-294` — the require→slugify→fail-loud CLI idiom
- `src/agent/main.ts:1979-1997` — explicit-`--name` suppresses auto session-name resolution (the load-bearing mechanism)
- `src/derivers.ts:34,48` — `panel::<slug>::<preset>` matches no spawn-name deriver (no projection pollution)
- Overlaps `fn-1039` on `README.md` (presets/panel block) — epic dep wired to serialize the edits

## Docs gaps

- **`src/pair/panel.ts` PANEL_HELP (~:828-862)**: add `--slug` to both usage lines, the options table, and the exit-2 cause list
- **`src/agent/dispatch.ts:84` (USAGE) + `:218` (KEEPER_AGENT_HELP)**: add `--slug` to the two extra `panel start` synopsis surfaces
- **`README.md` (~:1405)**: revise the "bare `keeper agent panel start`" line — `--slug` required, legs named `panel::<slug>::<preset>`
- **`README.md` (~:25-28)**: register `panel::<slug>::<preset>` as a spawn-name class beside `handoff::<slug>` — grammar mirrors `[a-z0-9-]+`, does NOT populate `plan_verb`/`plan_ref`, must not widen the `{plan,work,close}` whitelist
- **`plugins/plan/skills/panel/SKILL.md`**: shim auto-derives the slug and injects a `Slug:` line in the `Task()` prompt parallel to `Panel:`
- **`plugins/plan/agents/panel-runner.md` (~:41-48,82-83)**: document the required slug, forward `--slug "$SLUG"`, self-derive a fallback when the `Slug:` line is absent, add absent-slug to the exit-2 causes
- **`plugins/keeper/skills/pair/SKILL.md` (~:86)**: every `panel start` call gains an auto-derived `--slug`; add absent-slug to the exit-2 causes
