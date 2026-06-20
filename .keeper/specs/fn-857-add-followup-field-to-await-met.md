## Overview

When `keeper await complete <epic>` (or the `keeper:await` skill) fires its
terminal `met` — the epic popping off the board, the same moment its closer
finishes — the listener has no way to learn that the closer minted a
follow-up epic. This epic adds an OPTIONAL, additive `followup=<id>` field to
the single-planctl `complete` met line (comma-joined for several, a typed
JSON array under `--json`, omitted entirely when none), detected by scanning
the readiness snapshot for epics whose `created_by_closer_of` equals the
awaited epic. The `keeper:await` skill then teaches the listener to act on it:
inspect the follow-up via the CLI, or arm a fresh Monitor to daisy-chain. The
awaited epic completing IS the closer finishing, so this is the natural seam to
surface the hand-off.

## Quick commands

- `bun test test/await-conditions.test.ts test/await.test.ts` — the unit +
  integration coverage for the new helper and the met-line field.
- `bun run test:full` — mandatory before landing (touches `cli/await.ts`'s
  subscribe machinery, per keeper CLAUDE.md).
- `keeper await complete <epic-with-closer-child> --json` — eyeball the
  `"followup": [...]` array on a real completed epic that has a closer child.

## Acceptance

- [ ] A `complete <epic>` met carries `followup=<id>` (comma-joined, `sort_path`
  order) when the closer minted follow-up epic(s); the field is omitted
  ENTIRELY when there are none, keeping the no-child met line byte-identical.
- [ ] Works for both bare `fn-N` and full `fn-N-slug` await targets.
- [ ] `--json` met emits `followup` as a JSON array; the key is omitted when
  there are no children.
- [ ] ONLY the single `complete <epic>` met carries `followup` — never
  `unblocked`/`started`/task mets, never aggregate/`deleted`/`stuck`/`timeout`/
  `unreachable` terminals.
- [ ] The `keeper:await` skill, the `keeper await` `--help`, and the README
  await section document the field and the listener's CLI-vs-Monitor branch.

## Early proof point

Task that proves the approach: `.1` (the whole feature is one cohesive task).
The riskiest seam is the `eventLine` array-widening (a shared renderer used by
every armed/met/failed line). If it fails: fall back to a comma-joined string
in `--json` too (the rejected Option A) — that needs no renderer change, only
the kv path. The kv line the listener reads is identical either way, so the
feature still ships.

## References

- `src/types.ts:698-726` — `created_by_closer_of` (the full `plan_ref` of the
  closer's closed epic, immutable once set) + `sort_path` (zero-padded
  materialized-path sort key) semantics.
- `src/reducer.ts:5677-5702` — the `created_by_closer_of` derivation: creator
  job-links filtered to `plan_verb='close' AND plan_ref IS NOT NULL`, tie-broken
  lowest `job_id`.
- `plugins/plan/skills/close/SKILL.md:129,140` — `close-finalize` runs the
  follow-up scaffold BEFORE the irreversible `epic close`, and reports
  `closed_with_followup` → `data.new_epic_id`. This ordering is why the child's
  link is folded by the met tick on the common path.
- `cli/board.ts:474-477` — the `[slotted-after-closer]` pill the board already
  renders on closer-children: the concrete CLI inspect target the skill points at.
- `src/collections.ts:206-209` — `EPICS_DESCRIPTOR` `default_visible = 1`: the
  scan input is open+materialized epics only, so an already-completed child is
  (correctly) not surfaced.

## Docs gaps

- **`cli/await.ts` HELP block (~83-123)**: add a one-line note that a `complete`
  met may carry `followup=<id>` when a closer-minted child exists.
- **`README.md` await section (~1088-1136)**: one-sentence addition naming the
  `followup=` field and its source; keep it pruned, not a changelog.

## Best practices

- **Omit the field, never emit empty**: no `followup=` token in kv and no
  `"followup"` key in JSON when there are no children — both modes — so the
  no-child line stays byte-identical (the documented external contract).
- **Sort before joining**: snapshot iteration order is not guaranteed; sort the
  ids by `sort_path` asc (zero-padded → numerically correct) tie-broken on
  `epic_id`, or re-runs flip the order and break exact-string assertions and
  listener idempotency.
- **kv value is comma-joined, no spaces, no quoting**: `fn-N(-slug)` ids contain
  no commas or spaces by grammar, so the unquoted comma form needs no escaping.
- **Additive only, no version bump**: a trailing optional field; the consumer
  contract is "ignore unknown keys", not a version check.
