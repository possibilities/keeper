## Description

**Size:** M
**Files:** cli/show-job.ts (new), cli/keeper.ts, scripts/show-job.ts (new), test/show-job.test.ts (new), test/keeper-cli.test.ts, README.md

### Approach

New read-only verb `keeper show-job` that fetches a single `jobs` row as a
pretty JSON envelope. Split impure I/O (`main`) from a PURE resolver
(`resolveJob`) so every path is unit-testable without tmux/env/fs:

- `main(argv)` — hand-rolled arg parse (model `cli/find-file-history.ts:43-89`:
  support `--flag value` AND `--flag=value`, `process.exit(2)` on a bad/unknown
  arg or contradictory selectors). It performs ALL impure resolution and hands
  `resolveJob` a fully-resolved selector set: opens the DB read-only
  (`openDb(resolveDbPath(), { readonly: true })`, close in `finally`;
  `busy_timeout` is already set by `applyPragmas`, do NOT use `immutable=1`),
  resolves the auto-signals, prints the envelope, sets the exit code.
- `resolveJob(db, selectors)` — PURE over `(db handle, resolved selectors)`.
  Builds the bound-param query, applies the ambiguity rule, returns a
  discriminated result (`{kind:"ok",row}` | `{kind:"not_found"}` |
  `{kind:"ambiguous",candidates}`). No env / tmux / cwd / `Date.now()` reads —
  those happen in `main` and arrive as plain data, so tests drive every path
  in-process via `freshMemDb()` with synthetic selectors (incl. a synthetic
  pane-id set for the window-scope predicate).

**Selectors** (explicit flags AND together — they narrow; bound params only,
never string-interpolated):

- `--session-id` / `--job-id <id>` → `job_id = ?` exact (`job_id === session
  id`). If other selectors are ALSO passed they are consistency checks — a row
  failing them yields `not_found`, never a blind-trust of the id.
- `--session <title>` → the Claude session TITLE: `title = ? COLLATE NOCASE`
  OR an exact (NOCASE) entry in the `name_history` JSON array (via
  `json_each(name_history)` — `name_history` is `TEXT` JSON default `'[]'`).
  `DISTINCT` so a row matching on both title and a history entry counts ONCE.
  Cross-row matches (current title on row A vs a renamed-away history entry on
  row B) are PEERS → the ambiguity rule decides.
- `--cwd <dir>` (default `process.cwd()`) → resolve to git toplevel (a LOCAL
  `git -C <dir> rev-parse --show-toplevel` spawn — mirror `cli/await.ts:1679-1691`;
  do NOT export the non-exported `defaultGitRoot`), `realpathSync` the root,
  then match `cwd = root OR cwd LIKE root || '/%'`. Path-boundary guard so
  `/repo/foo` does NOT match `/repo/foobar` (build the LIKE prefix with a
  trailing slash; escape `%`/`_`/`\` LIKE wildcards). `--cwd-exact` for strict
  equality — document the known caveat: stored `jobs.cwd` is raw
  `process.cwd()`, not realpath'd, so a historical `/var` vs `/private/var` row
  can miss under exact match. A non-repo cwd / missing git → degrade (skip the
  signal), never throw (session-state precedent).
- `--pane <%N>` → `backend_exec_pane_id = ?` exact (a bare `--pane 3`
  normalizes to `%3`). Power-user escape; the headline pane behavior is the
  auto window-scope below.

**Auto-detection** (only when no explicit primary selector pins the job;
precedence LADDER — each rung's matches run through the ambiguity rule; a rung
that matches ≥1 but is ambiguous REPORTS ambiguity, a rung that matches 0
falls through to the next):

1. Ambient `$CLAUDE_CODE_SESSION_ID` (== own `job_id`) — run INSIDE a Claude
   session, bare `show-job` shows your own job. Read it in `main` via
   `src/commit-work/session-id.ts` `resolveSessionId(null, env)` (keep the env
   read in `main`, not in pure `resolveJob`).
2. **tmux current-WINDOW scope** — THE headline feature: split the current tmux
   window and run `keeper show-job` from the new shell pane (its own
   `$TMUX_PANE`, different from the agent's). In `main`: read `$TMUX_PANE`
   (fallback `$KEEPER_TMUX_PANE`; names via `execBackendEnvMeta()`), then ask
   tmux for the set of pane ids in the CURRENT WINDOW (the window containing
   `$TMUX_PANE`) and pass that set to `resolveJob` as `paneIds: string[]`
   (same `backend_exec_pane_id IN (...)` predicate as `--pane`); `resolveJob`
   filters to LIVE jobs in that set → exactly one live agent → return it, no
   flags. REUSE the existing tmux pane-listing helper if one exists (scan
   `src/exec-backend.ts` for the `listPanes` op the window-renamer worker
   consumes; verify it returns/maps pane ids by window). Else a read-only
   `tmux list-panes -a -F '#{window_id} #{pane_id}'` (find our window, collect
   its panes) or `tmux list-panes -F '#{pane_id}'` (current window). DEGRADE
   gracefully: not in tmux / tmux not running / command non-zero → skip this
   rung, fall to cwd. The shell-out stays in `main`, out of pure `resolveJob`.
3. cwd → the git-toplevel containment described above.

**Ambiguity rule** (`LIVE_STATES` = a LOCAL const mirroring `src/reducer.ts:1929`
`{working, stopped}`, with a "mirror of reducer.ts" comment; terminal =
`ended` / `killed`):

- 0 matches → `not_found`
- exactly 1 → return it (a lone TERMINAL job IS returned — you can inspect a dead session)
- >1 with exactly one live → return the live one
- >1 with 0 or ≥2 live → `ambiguous` (emit a compact candidate list)
- `--latest` → collapse ambiguity to the top of the deterministic sort (strictly a >1 tiebreaker; NEVER turns `not_found` into a result).

Deterministic `ORDER BY` (total order → byte-stable candidate lists):
`CASE WHEN state IN ('working','stopped') THEN 0 ELSE 1 END,
COALESCE(active_since, updated_at, created_at) DESC, updated_at DESC, job_id ASC`.

**Output envelope** (`printPretty` = `JSON.stringify(v, null, 2) + '\n'`, model
`cli/find-file-history.ts:91-94`):

- success → `{ success:true, job:{…full jobs row…}, resolution:{ method, matched_field? } }`. Emit ALL `jobs` columns; decode JSON-TEXT columns (`name_history`, `epic_links`, `monitors`) with a `[]`-fallback parse (a malformed blob folds to `[]` / passthrough, never throws); `--raw` leaves them as TEXT.
- not_found → `{ success:false, error:"not_found", candidates:[] }`, exit 1.
- ambiguous → `{ success:false, error:"ambiguous", candidates:[ {job_id,title,state,cwd,backend_exec_pane_id,updated_at}, … ] }`, exit 1.
- read failure (DB open/query throws) → `{ success:false, error:String(e) }`, exit 1 (NEVER an empty not_found — a broken DB ≠ no job).
- bad/unknown arg, contradictory selectors, or no-effective-filter (no flags, not in a session/tmux, cwd not a repo) → stderr message + exit 2.
- NO `SCHEMA_VERSION` bump, no `keeper/api.py` edit (read over existing columns; in-binary readers skip the version guard).

**Register** in `cli/keeper.ts` THREE spots: `SUBCOMMANDS` array (:22-39), the
`USAGE` block (:42-79, ~20-char-padded name + tab-aligned one-liner naming the
selectors + JSON output), the lazy handler map (:145-167:
`"show-job": async (argv) => (await import("./show-job")).main(argv)`).

**scripts/show-job.ts**: thin shim (no precedent in `scripts/`, so define it) —
`#!/usr/bin/env bun` + `import { main } from "../cli/show-job"; main(Bun.argv.slice(2));`.
(The cli main reads `Bun.argv.slice(3)` under its own `import.meta.main`; the
shim passes `slice(2)` so the verb's argv lines up.)

**README.md**: add a `show-job` bullet in the "Example clients" read-only-verb
tier (~lines 1167-1183), sibling to `session-state` / `show-session-files` —
one paragraph on the jobs lookup, the selectors, the auto window-scope +
ambient-session-id behavior, and an example.

### Investigation targets

**Required** (read before coding):
- `cli/find-file-history.ts:43-158` — the canonical read-verb template (hand-rolled `parseArgs`, `printPretty` envelope, `openDb` readonly in try/finally, error-envelope-on-throw).
- `cli/session-state.ts:125-155` — `process.cwd()` + degrade-don't-throw precedent for git/env resolution.
- `cli/keeper.ts:22-39, 42-79, 145-167` — the three registration spots.
- `src/db.ts:602-634` — the `jobs` DDL (the full column set the envelope emits; note nullables vs the NOT NULL `created_at`/`updated_at` the ORDER BY relies on).
- `src/exec-backend.ts:145-166` — `execBackendEnvMeta()` for the pane env-var names; AND scan this module for the existing tmux pane-listing helper (`listPanes`, consumed by the window-renamer worker) to reuse for the window enumeration.
- `src/commit-work/session-id.ts` — `resolveSessionId(arg, env)` to read `$CLAUDE_CODE_SESSION_ID` in `main`.
- `src/commit-work/attribution.ts:66-82` — `defaultGitRoot` (NON-exported; local-copy the git-toplevel spawn rather than export it) and `cli/await.ts:1679-1691` — the existing local git-toplevel shell-out to mirror.
- `test/helpers/template-db.ts` — `freshMemDb()` (in-process unit) / `freshDbFile()` (readonly-reader spawn) APIs.
- `test/keeper-cli.test.ts:42-65,156,174-193` — handler-map + `isSubcommand` assertions to extend; `test/history-read-verbs.test.ts:1-63` — the spawn-test model.

**Optional** (reference as needed):
- `src/reducer.ts:1929` — the canonical `LIVE_STATES` const to mirror; `:6188-6232` — `spawn_name` → title/name_history seeding (why `--session` matches title/name_history).
- `src/collections.ts:66` — `JOBS_DESCRIPTOR` (why we read the table, not the socket — it omits `config_dir`/`name_history`).

### Risks

- The window-scope tmux shell-out is the one net-new boundary: it can block/fail if tmux isn't running — MUST degrade to skip-the-signal, never throw the verb. Keep it in `main()`, out of pure `resolveJob`.
- Path-boundary containment is bug-prone (the `/repo/foo` vs `/repo/foobar` false match) — use a trailing-slash LIKE prefix + LIKE-wildcard escaping; unit-test the boundary explicitly.
- `name_history` `json_each` over a malformed/empty blob must not throw the query (default `'[]'` is fine; guard the decode).
- `$TMUX_PANE` pane ids are reused after a pane dies and repeat across tmux servers — that is why the window-scope filters to LIVE jobs and defers to the ambiguity rule rather than trusting a pane match as definitive.

### Test notes

Drive `resolveJob` in-process via `freshMemDb()`: seed `jobs` rows with INSERT,
assert each path — session-id exact (+ consistency-check mismatch → not_found),
title match, name_history match, same-row dedup, cross-row peers, cwd
containment (incl. the `/repo/foo` vs `/repo/foobar` boundary and `--cwd-exact`),
`paneIds` IN-set (the window-scope predicate, fed synthetic pane arrays — no
tmux needed), 0 / 1 / >1-one-live / >1-multi-live ambiguity, `--latest`
tiebreak, terminal-only single match returned, JSON-TEXT decode + `--raw`,
full-row envelope shape. Extend `test/keeper-cli.test.ts` (handler map +
`isSubcommand`). Optional slow-tier spawn test via `freshDbFile()` + `sandboxEnv`.
`bun run test:full` is MANDATORY before landing (keeper-cli / history-read-verbs
are fast-tier-excluded; this touches CLI/db paths).

## Acceptance

- [ ] `keeper show-job --session-id <id>` returns that job's full metadata as `{success:true, job:{…}, resolution:{…}}` pretty JSON; an unknown id → `{success:false,error:"not_found"}` exit 1.
- [ ] `keeper show-job --session <title>` matches the Claude session title exactly (case-insensitive) AND any `name_history` entry, deduping same-row matches; cross-row ties resolve via one-live-wins/else-list.
- [ ] `keeper show-job --cwd <dir>` (and bare, from cwd) resolves via git-toplevel containment with the path-boundary guard; `--cwd-exact` does strict equality; a non-repo cwd degrades (skips the signal) without throwing.
- [ ] Bare `keeper show-job` run in a shell pane split beside a single running agent in the same tmux WINDOW returns that agent's job with no flags; ≥2 live agents in the window → ambiguous candidate list (exit 1); not in tmux → that signal is skipped, no crash.
- [ ] Bare `keeper show-job` inside a Claude session resolves the current session's own job via `$CLAUDE_CODE_SESSION_ID`.
- [ ] `--latest` collapses an ambiguous live set to the most-recent by the deterministic sort; never fabricates a result from `not_found`.
- [ ] The full-row envelope emits all `jobs` columns with JSON-TEXT columns decoded (`[]`-fallback); `--raw` passes them through as TEXT.
- [ ] Read failure (missing/locked DB) → `{success:false,error}` exit 1, distinct from `not_found`; bad/unknown arg → exit 2.
- [ ] Registered in `cli/keeper.ts` (SUBCOMMANDS + USAGE + handler map); `scripts/show-job.ts` shim works; README "Example clients" has a `show-job` bullet.
- [ ] `resolveJob` is pure (db + resolved selectors only); all resolution paths unit-tested via `freshMemDb()`; `test/keeper-cli.test.ts` extended; `bun run test:full` green.

## Done summary
Added keeper show-job read-only verb: fetches one jobs row as a pretty JSON envelope, resolved by session-id/title/cwd/pane or zero-flag auto-detection (ambient session, tmux current-window single-live-agent, cwd). Pure resolveJob + impure main, registered in dispatcher with scripts/ shim and README bullet.
## Evidence
