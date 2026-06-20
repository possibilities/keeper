## Overview

keeper has a family of read-only JSON query verbs (`find-file-history`,
`session-state`, `show-session-events`) that exist so consumers stop
hand-writing sqlite against the schema keeper owns. `keeper show-job` joins
it: fetch ONE job's full metadata row from the `jobs` projection as a pretty
JSON envelope, resolved by the cheapest available signal — explicit
`--session-id` / `--session` (the Claude session title) / `--cwd` / `--pane`,
or zero-flag auto-detection that (a) shows your own job when run inside a
Claude session and (b) shows the single live agent in your current tmux
WINDOW when you split a shell pane beside it. A thin `scripts/show-job.ts`
shim provides the `./scripts` entry point the request named.

## Quick commands

- `keeper show-job --session-id <id> | jq .job.title`  — explicit id lookup
- `keeper show-job --session "<claude --name title>"`  — by session title
- `keeper show-job` (from a shell pane split beside one running agent) — zero-flag tmux current-window auto-detect
- `bun run test:full`  — the mandatory tier (keeper-cli + history-read-verbs are fast-tier-excluded)

## Acceptance

- [ ] `keeper show-job` resolves a single job by session-id / title / cwd / pane AND by zero-flag auto-detection (ambient `$CLAUDE_CODE_SESSION_ID`, tmux current-window single-live-agent, cwd), emitting a stable `{success,…}` JSON envelope with correct exit codes.
- [ ] Ambiguity is explicit (one-live-wins, else candidate list + exit 1, `--latest` opt-in); a read failure is distinct from `not_found`.
- [ ] Read-only over the `jobs` table; no schema / RPC / daemon change; registered in the CLI dispatcher with a `scripts/` shim and a README bullet; `bun run test:full` green.

## Early proof point

Task that proves the approach: `fn-N.1` is the whole verb, but its spine lands
first WITHIN the task — the `--session-id` exact path + the pretty-JSON
envelope prove the read-only-open + pure-`resolveJob` + dispatcher-registration
skeleton before the multi-signal resolution is layered on. If the tmux
window-scope proves fiddly, the verb still ships fully usable on the explicit
+ ambient-session-id + cwd signals, and the window-scope degrades to a skipped
signal (never a crash).

## References

- `cli/find-file-history.ts` — the read-verb template (hand-rolled parseArgs, `printPretty` envelope, readonly open in try/finally, error-envelope-on-throw)
- `cli/session-state.ts` — `process.cwd()` + degrade-don't-throw precedent
- `cli/await.ts:1679-1691` — the existing local `git -C <cwd> rev-parse --show-toplevel` shell-out to mirror
- `src/exec-backend.ts:145-166` — `execBackendEnvMeta()` for the pane env-var names; also scan this module for the existing `listPanes` tmux helper (the window-renamer worker consumes it) to reuse for the window enumeration
- `src/db.ts:602-634` — the `jobs` DDL (the full row the envelope emits)
- Decisions settled upstream by an Opus-4.8 + GPT-5.5 panel and human Q&A: subcommand-not-standalone-script; "session name" = the Claude session TITLE (not the tmux session name); EXACT (case-insensitive) title match; one-live-wins ambiguity with `--latest`; LOCAL-COPY of `defaultGitRoot` / `LIVE_STATES` (leave the re-fold-sacred reducer untouched); and the tmux auto-detect being WINDOW-scoped (split-a-pane-beside-an-agent), not `$TMUX_PANE`→pane-id equality.

## Docs gaps

- **README.md** (~lines 1167-1183, "Example clients"): add a `show-job` bullet in the read-only-verb tier, sibling to `session-state` / `show-session-files`. (`show-session-events` / `search-history` / `find-file-history` also lack bullets here — pre-existing gap, optional to close at the same time.)
- **`/Users/mike/code/arthack` …/`keeper-history-forensics.md.tmpl`** (CROSS-REPO — follow-up, OUT of this epic's scope): teaches raw `sqlite3 … FROM jobs`; once `show-job` exists it is the better ergonomic entry point. Cascades to `/plan:hack` SKILL.md on re-render.
