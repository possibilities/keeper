# plan name retirement — closed note

The "planctl" name is retired across keeper. The live surfaces are `keeper plan`
(the command), `.keeper/` (the data directory), and `plan` (columns, the event
envelope, the source badge, code symbols, wire kinds). This note records the
**end reality**: what was renamed, and the two narrow classes that are
permanently grandfathered.

## Permanently frozen — never rename these

Exactly two classes of literal survive forever. They are pinned by
`scripts/frozen-allowlist.txt` and enforced by `scripts/lint-retired-name.sh`.

1. **Commit-trailer key strings** — `Planctl-Op` / `Planctl-Target` /
   `Planctl-Prev-Op`. They are written into commit messages that already live in
   immutable git history. The emit side (`plugins/plan/src/commit.ts`), the live
   `git log` trailer scrape (`src/git-worker.ts`), and the forbidden-trailer
   passthrough regex (`cli/commit-work.ts`) all read these literals; renaming any
   of them would orphan every historical commit's plan attribution. Docs that
   document the trailer wire format keep the `Planctl-*` spelling verbatim.

2. **Schema-history literals in `src/db.ts`** — the `CREATE TABLE` /
   `addColumnIfMissing` / backfill / index-drop steps a fresh-DB migration walk
   replays in version order. The `planctl_*` column names, `idx_events_planctl_*`
   indexes, and the v78 rename block depend on the older spellings existing
   exactly as written (version-guarded so a post-rename boot never resurrects a
   zombie column). The whole file is count-pinned by the allowlist.

## What was retired

Everything else became `plan`:

- **The command.** `planctl` is gone; `keeper plan <verb>` is the live in-process
  entrypoint (`cli/plan.ts` → `plugins/plan/src/cli.ts`).
- **The data directory.** `.planctl/` → `.keeper/`. Plan state, specs, and
  runtime state all live under `.keeper/`.
- **The event envelope.** `keeper plan` emits a `plan_invocation` NDJSON envelope;
  the reader is single-path on `plan_invocation`.
- **The Commit-event data keys.** The synthetic Commit-event `events.data` keys
  `planctl_op` / `planctl_target` were rewritten to `plan_op` / `plan_target` by
  the v82 migration (forward-only, version-guarded, idempotent, value-preserving);
  producer and reader are single-path on the new keys, and re-fold stays
  byte-identical under them (`test/refold-equivalence.test.ts`).
- **The source badge.** The `file_attributions.source` value is `'plan'`; the
  CHECK no longer admits `'planctl'`.
- **The commit-changed wire kind.** `plan-commit-changed` is the sole accepted
  kind; the legacy `planctl-commit-changed` dual-accept is gone.
- **The `PLANCTL_*` env fallbacks**, the vestigial `planctl-bun` build artifact,
  incidental code symbols, comments, docs, and test descriptions.

## Lint guard

`scripts/lint-retired-name.sh` (covered by `test/lint-retired-name.test.ts`) reads
`scripts/frozen-allowlist.txt` and fails if a frozen literal is clobbered or a
count-pinned file drifts. The epic's final state is a repo-wide grep for "planctl"
returning only the ratified frozen allowlist.
