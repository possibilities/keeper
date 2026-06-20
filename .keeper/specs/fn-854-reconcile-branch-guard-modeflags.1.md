## Description

Originating findings: F1 (kept) and F3 (merged-into-F1), both rooted at the
short-form-only `modeFlags` set in `plugins/keeper/plugin/hooks/branch-guard.ts:121`.
They share the same file-touch and the same root cause — `modeFlags` lists only
`-d`/`-D`/`-m`/`-M`/`-c`/`-C`, so its classification disagrees with the long forms.

F1 (branch-guard.ts:121-122): `-c`/`-C` copy-create is in `modeFlags` and returns
`false` (allow), but copy genuinely creates a new branch ref — a subagent bypass —
and long `--copy` is denied (asymmetry). Decide and encode the copy-create policy:
copy creates a ref, so it should be BLOCKED for subagents — drop `-c`/`-C` from the
allow-as-mode set so they fall through to the create check, matching `--copy`.

F3 (branch-guard.ts:114-135, the positional scan at :133): long-form `--delete`/
`--move` after a positional false-deny because only short forms are in `modeFlags`;
add the long forms (`--delete`/`--move`) so legitimate non-create branch commands
stop hitting a false deny. Net: short and long forms classify identically.

## Acceptance

- [ ] `git branch -c new` and `git branch -C base new` are DENIED (copy creates a ref)
- [ ] `git branch --delete old` and `git branch --move old new` are ALLOWED (no false-deny)
- [ ] Short/long forms of each mode flag classify identically
- [ ] Truth-table regression rows added for copy-create deny and long-form mode allow

## Done summary
Reconciled branch-guard short/long mode-flag parity: dropped -c/-C from modeFlags so copy-create is blocked (creates a ref — a subagent bypass), added --delete/--move long forms so legitimate non-create commands no longer false-deny. Added truth-table regression rows.
## Evidence
