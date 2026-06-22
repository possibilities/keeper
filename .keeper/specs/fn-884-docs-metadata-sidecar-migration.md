## Overview

Move all `~/docs` metadata out of the markdown body and into the per-doc `.yaml` sidecar, relocate the supporting hook from arthack into the keeper plugin, migrate the 853 existing docs, update the advice, and reconcile the ~1000 remote gists to the new shape. End state: `~/docs/*.md` carry no machine-stamped metadata; every doc has a `.yaml` sidecar; the keeper plugin owns a fail-open `PostToolUse` sidecar-writer; arthack no longer stamps docs; the `docs-dir-and-gist-open` advice (snippet + `/hack`) publishes as `gh gist create <doc>.md <doc>.yaml --web`.

Spans THREE repos via per-task `target_repo`: keeper (primary, `/Users/mike/code/keeper`), arthack (`/Users/mike/code/arthack`), and the `~/docs` git repo (`/Users/mike/docs`).

## Quick commands

- `bun test test/sidecar-writer.test.ts` — keeper hook unit + subprocess tests
- `bash /Users/mike/code/arthack/scripts/install.sh` — render + distribute skills/hooks to all harnesses
- `keeper prompt render source-dirs/docs-dir-and-gist-open` — verify the updated snippet body

## Acceptance

- [ ] `~/docs/*.md` carry no auto-stamped `## Metadata` blocks; every doc has a `.yaml` sidecar (existing merged, missing backfilled sparse)
- [ ] keeper plugin writes the sidecar (never the `.md`) on Write to `~/docs`, and writes the gist URL into the sidecar on `gh gist create`; exit 0 always
- [ ] arthack `post_tool_use.ts` no longer carries docs/gist machinery; formatters + command-advice intact
- [ ] advice (snippet + `/hack`) shows `gh gist create <doc>.md <doc>.yaml --web` and states metadata lives only in the sidecar
- [ ] matchable remote gists reconciled best-effort to `.md` (stripped) + `.yaml` sidecar; gist-url backfilled into local sidecars; non-matches skipped + logged

## Early proof point

Task that proves the approach: `.1` (keeper sidecar-writer hook + shared module). If it fails (e.g. can't stay dep-free / fail-open), the whole relocation premise is wrong — fall back to keeping the machinery in arthack and only changing behavior to sidecar-only.

## References

- keeper hook templates: `plugins/keeper/plugin/hooks/events-writer.ts` (readStdin, exit-0 guard ~:864, `resolveEventsLogDir` env-override), `branch-guard.ts` (pure-predicate + fast-tier test)
- reusable derivers: `src/derivers.ts` `extractMutationPath`, `extractBashMutation`, `tokenizeShell`; gist URL from `data.tool_response` (events-writer.ts:99-111)
- arthack removal source: `claude/arthack/hooks/post_tool_use.ts` (verified line map in `.2`)
- GOTCHA: `gh gist edit` is editor-bound (no piped stdin / `--file -`) — use `gh api PATCH /gists/<id> --field "files[<name>][content]=..."`; `--add` is an idempotent upsert; gist display name = alphabetically-first file (`.md` < `.yaml`, so `.md` stays primary)
- GitHub secondary rate limit ~80 content-mutations/min, ~500/hr — pace the ~2000-call reconcile

## Rollout

`~/docs` is a git repo — tag `pre-migration-<date>` before any write; migrate in ~50-file tranches with a commit per tranche; verify each stripped file is strictly shorter. The remote reconcile is best-effort and idempotent (ndjson state file of processed gist ids; re-runnable). Rollback: `git checkout pre-migration-<date> -- .` in `~/docs`; revert the keeper/arthack commits; the remote gists are non-critical (secret, recoverable by re-publish).
