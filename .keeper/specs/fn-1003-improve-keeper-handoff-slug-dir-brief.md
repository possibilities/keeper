## Overview

`keeper handoff` gains a human-meaningful identity and a launch target. Today a
handoff is keyed by an opaque `crypto.randomUUID()`, always launches in keeperd's
cwd, and boots the worker with a POINTER telling it to run `keeper handoff show <id>`
to load its brief. This epic makes every handoff carry a REQUIRED, globally-unique
slug (`handoff::<slug>`, daemon-enforced, reject-on-collision), adds `--dir` to launch
the handoff-ee into any directory (default = the caller's cwd), inlines the brief
directly as the worker's `/hack` prompt, and broadens the skill so "create a handoff"
actually fires it. The existing name-based bind machinery is reused unchanged — the
slug rides the same `handoff::<id>` spawn-name path the uuid did.

## Quick commands

- `keeper handoff --slug investigate-foo --prompt "<brief>"` — enqueue; worker launches as `handoff::investigate-foo`
- `keeper handoff --slug investigate-foo --prompt "<brief>"` (again) — REJECTS with exit 3 (slug taken)
- `keeper handoff --slug clean-x --dir ~/code/other --prompt "<brief>"` — launch the handoff-ee in ~/code/other
- `keeper handoff show clean-x` — print the stored brief (inspection only)
- `bun test` — full suite green

## Acceptance

- [ ] Every handoff requires a slug, slugified to `[a-z0-9-]+`, globally unique on this host (permanent — probed against the events log); duplicates rejected with a distinct exit 3.
- [ ] `--dir` launches the handoff-ee into a chosen (default: caller's) directory, validated CLI-side, carried through a new schema-v96 `handoffs.target_dir` column.
- [ ] The handoff-ee boots with the brief inline as its `/hack` prompt (investigate-then-confirm framing retained), not a `keeper handoff show` pointer.
- [ ] The handoff skill fires on "create a handoff" / "create handoffs", disambiguated from authoring a markdown handoff document.
- [ ] Re-fold determinism + the single-writer uniqueness invariant hold; `bun test` green.

## Early proof point

Task that proves the approach: `.1` (slug identity + daemon-enforced uniqueness) — it
establishes the slug-as-id contract and the producer-only events-log uniqueness probe
everything else builds on. If it fails (e.g. the probe can't be made race-free in the
synchronous handler): fall back to a UNIQUE-constraint-on-insert that dead-letters a
collision — still reject-on-collision, surfaced one layer later.

## References

- epic-scout: no open-epic dependencies or overlaps (zero open epics in the pool).
- Bind machinery reused unchanged: `src/derivers.ts:47` `HANDOFF_SPAWN_RE` already accepts `[a-z0-9-]+`; `src/reducer.ts:6246` `bindHandoffOnSessionStart` keys on `handoff_id`.
- Contract parity template: `cli/dispatch.ts` (`--cwd` / `target_repo` resolution; free-form prompt up to `PROMPT_MAX_BYTES`).

## Docs gaps

- **plugins/keeper/skills/handoff/SKILL.md**: broaden triggers (+"create a handoff"), rewrite the show-pointer narrative to the inline model, add `--slug`/`--dir`/exit-3.
- **cli/handoff.ts (HELP + file comment)**: add `--slug`/`--dir`; drop the `show` "first call" framing.
- **README.md**: spawn-name `handoff::<slug>`, `handoff_prompt_prefix` inline model, dispatcher UUID-ordering rationale, schema-history +v96.
- **keeper/api.py**: `SUPPORTED_SCHEMA_VERSIONS` +96 + a forward-facing comment paragraph.

## Best practices

- **Slugify order:** NFKD → strip combining marks (`\p{M}`) → lowercase → `[^a-z0-9]+`→`-` → trim → collapse; cap length AFTER transform; reject empty/all-dash/`.`/`..` (non-ASCII homoglyphs drop out of the ASCII class — reject if the result empties).
- **Uniqueness:** probe + append in ONE synchronous unit with no `await` between; freeze the resolved slug in the event (never re-slugify at replay — algorithm drift would retroactively break invariants); REJECT (not suffix) for user-authored names.
- **Child cwd:** expand `~` + resolve relative against the caller's cwd CLI-side; pass an absolute path; `stat()`+`isDirectory()` (symlinked dirs are valid); TOCTOU is unavoidable, so catch spawn-time errors too.
