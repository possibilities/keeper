# name retirements — closed note

Two names are retired across keeper: **planctl** and **agentwrap**. This note
records the **end reality** of each — what was renamed, and the narrow residue
that is permanently grandfathered. Both are guarded by
`scripts/lint-retired-name.sh` (reading `scripts/frozen-allowlist.txt`, covered by
`test/lint-retired-name.test.ts`); this doc is itself in the guard's exclusion set,
so it may name the retired tokens freely.

## planctl

The "planctl" name is retired across keeper. The live surfaces are `keeper plan`
(the command), `.keeper/` (the data directory), and `plan` (columns, the event
envelope, the source badge, code symbols, wire kinds).

### Permanently frozen — never rename these

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

### What was retired

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

### Lint guard (planctl)

`scripts/lint-retired-name.sh` reads `scripts/frozen-allowlist.txt` and fails if a
frozen "planctl" literal is clobbered (Check A: anchors) or a count-pinned file
drifts (Check B). Enforcement is PROGRESSIVE — only the ratified frozen surface is
pinned. The end state is a repo-wide grep for "planctl" returning only that surface.

## agentwrap

The "agentwrap" name (the former launcher) is retired to **zero**. The live
surfaces are `keeper agent` (the command), `KEEPER_AGENT_*` entries such as
`KEEPER_AGENT_PATH`, `~/.config/keeper/` (the launcher config dir), and
`~/.local/state/keeper-agent/` (the runtime state dir).

### What was retired

- **The launcher name + command.** `agentwrap` is gone; `keeper agent` is the
  in-process launcher.
- **The env-var family.** `AGENTWRAP_*` → `KEEPER_AGENT_*` across producer,
  consumer, and the pane-forward filter (`KEEPER_AGENT_PATH` is excluded from the
  forward filter).
- **The config dir.** `~/.config/agentwrap/` → `~/.config/keeper/`, split into the
  per-harness `{claude,codex,pi,plugins}.yaml` defaults + `{presets,panel}.yaml`
  launch-config. The transitional read-old fallback and its `legacyAgentwrap*`
  detectors are gone — no back-compat shim remains.
- **The runtime state dir.** `~/.local/state/agentwrap/` → `~/.local/state/keeper-agent/`
  via a one-time inode-preserving `rename(2)` that preserves the flock-guarded
  cwd-ordinals counter. This relocation is the ONLY live code that still names the
  old path (it must, to find and move it).
- **The retired config aliases**, the `~/.config/agentwrap/presets.yaml` migration
  hint, incidental symbols, comments, docs, and test descriptions.

### Lint guard (agentwrap — zero-tolerance)

`scripts/lint-retired-name.sh` Check C greps the whole tree and fails on ANY
"agentwrap" occurrence outside a defined exclusion set: the guard's own files, the
retirement docs (this file), `.keeper/` history, the guard's fixture test, and the
state-dir relocation source (`src/agent/cwd-ordinal.ts` + `test/agent-cwd-ordinal.test.ts`,
themselves count-pinned so a NEW token there still fails). The name can never return.
