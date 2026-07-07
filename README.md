# keeper

Event-sourced control-data daemon for Claude Code agents — Bun + `bun:sqlite`, single host, single
SQLite DB. Imperative fold/migration/write-scoping guardrails live in [CLAUDE.md](./CLAUDE.md).

Domain vocabulary lives in the [CONTEXT.md](./CONTEXT.md) glossary; resolved architectural decisions
and their rationale live in [docs/adr/](./docs/adr/) alongside commit messages; `.keeper/` specs are
the plan/spec archive.

## What keeper is

A small TypeScript hook plugin appends one per-pid NDJSON line per Claude Code hook invocation
(lock-free — it never opens SQLite). keeper drives other harnesses too — codex, pi, and hermes — and
they feed the same events-log tree: a hermes shell shim and an ephemeral in-process pi extension
write per-pid NDJSON directly, while non-claude presence (a launcher-dropped birth record) and codex
live churn (a rollout-file tail) reach the log as main-minted synthetic events. A hand-started
session can be adopted as a tracked job rather than only a launcher-started one: the hermes shim
self-seeds its identity from the native session id when no keeper job id is set, and an opt-in knob
(off by default) adopts an unambiguous originator-less codex rollout timed from its own session-start;
pi adoption is deliberately not built — its extension is ephemeral per launch with no durable artifact
to adopt. A long-running Bun
daemon (`keeperd`, run by a macOS LaunchAgent) runs an events-log ingester that tails those per-pid
files and lands each line as one row in the append-only `events` table — the durable log and sole
fold source. The reducer folds new
events into projections one short `BEGIN IMMEDIATE` transaction per event, advancing its cursor in
the same transaction (exactly-once, and a boot drain re-converges idempotently after any crash).

Projections are served over an **NDJSON-over-UDS subscribe + RPC** socket, namespaced by collection:
a client names a collection in its `query` and gets an ordered page that doubles as a live
subscription, streaming `patch` (cell) and `meta` (membership) frames. Collections include `jobs`
(one row per session), `epics` (the read-only plans surface — tasks embedded per epic), `git`,
`usage`, `profiles`, `dead_letters`, and more. The query surface is read-only; mutation is a
separate scoped RPC path.

## What keeper is NOT

- **No general write path into the reducer.** `query` is read-only. `rpc` writes only a
  tightly-scoped set of external surfaces, each round-tripping through a synthetic event the reducer
  folds — never the projections directly. Consumers may read any of it straight from SQLite.
- **No UI** — `sqlite3` and the `keeper` CLI subcommands are the inspection surface.
- **No multi-machine** — single host, single DB file.
- **No kernel watchers on keeper's own DB** — `data_version` polling is the change-detection
  primitive (FSEvents/kqueue drop same-process and WAL writes on macOS). External trees (transcripts,
  `.keeper` plan files) use `@parcel/watcher`; the git surface is poll-only. The usage scraper's
  Temporal arithmetic pins `@js-temporal/polyfill` (exact version — its serialization format is
  spec-sensitive). Both are keeper's only third-party runtime deps.
- **No in-process self-heal** — an unrecoverable error exits non-zero and the LaunchAgent restarts
  the single recovery path.

## System map

```
claude hook | hermes shim | pi extension  --append NDJSON, no SQLite-->  ~/.local/state/keeper/events-log/<pid>.ndjson
keeper agent launcher  --birth record (non-claude presence)-->  births tree  --ingested by-->  main synthetic event
events-log ingester (worker)  --read from durable byte-offset-->  INSERT rows into `events`
reducer (main)  --fold, one BEGIN IMMEDIATE per event-->  projections (jobs, epics, git, usage, ...)
consumers poll `PRAGMA data_version` on their own read-only connections:
    UDS subscribe + RPC server | autopilot reconciler | plan / exit-watcher / git workers | tmux control/renamer/autoclose workers
producers feed the log via main only (never write the DB):
    transcript-title | plan | usage-scraper | builds | dead-letter | statusline watchers | birth-ingest | codex-state (rollout tail) | stuck-state sentinel
```

Main is the sole writer of the log's synthetic events and of every projection; the per-pid NDJSON
files are written by a hook-writer class (the claude hook, the hermes shim, the pi extension), and the
launcher is the sole writer of the births tree. Workers open their own read-only connections and post
messages to main, which mints the events and pumps the fold.

## Install

`scripts/install.sh` owns the install footprint (idempotent — safe to re-run):

```sh
git clone <repo-url> ~/code/keeper
cd ~/code/keeper
mkdir -p ~/.local/state/keeper   # launchd does not pre-create the state dir
bash scripts/install.sh          # bun install -> bun link -> keeperd LaunchAgent bootstrap
```

Edit `plist/arthack.keeperd.plist` before the first bootstrap if your username, checkout path, or bun
path differ (Apple Silicon `/opt/homebrew/bin/bun`, Intel `/usr/local/bin/bun`); the plist must be
owned by you and mode `644` or macOS silently ignores it. Optional roots and runtimes live in
`~/.config/keeper/config.yaml`, including the `usage_models` map that declares which claude profiles
and codex the usage scraper produces envelopes for and their display aliases (an absent or malformed
map idles the producer rather than erroring). The autoclose worker force-closes the tmux window of a done-and-idle
keeper-dispatched agent (an autopilot `work::`/`close::` worker or a finished claude panel leg) after a
grace: `autoclose_enabled` (default `true`; set `false`/`off`/`no`/`0` to disable — re-read every pulse,
so a flip needs no daemon restart) and `autoclose_grace_seconds` (default `30`) govern it.

`keeper agent` loads keeper's own two plugins (`plugins/keeper`, `plugins/plan`) from
`~/.config/keeper/plugins.yaml`, which `install.sh` writes on a fresh machine (keeper-only, no
third-party sources) and leaves untouched when a file or symlink is already there. Do NOT add a
`~/.claude/plugins/keeper` symlink — it double-registers the hook (two `events` rows per invocation).

**Host provider matrix (optional).** By default the plan worker matrix is claude-only. A host
`~/.config/keeper/matrix.yaml` ([ADR 0010](./docs/adr/0010-host-provider-matrix-and-wrapped-worker-cells.md))
grows the model axis with capability models served by codex or pi: an ordered provider roster
(cost-ascending — the pecking order), each provider carrying the models it serves (with optional
native-id aliases), plus the effort axis and the wrapper driver (the fixed claude model/effort that
runs wrapped cells). A model under the `claude` provider stays **native** (its worker runs that model
in-session); any other renders as a **wrapped cell** whose claude worker delegates implementation to
the cost-preferred serving provider at run time. `keeper agent providers check` validates the roster;
`keeper agent providers resolve <model> <effort>` prints the driver plus the cost-ordered candidate
harnesses. With no matrix present, rendering, selection, and dispatch stay byte-identical to the
claude-only default. Standing up the first wrapped task on a host:

1. Author `~/.config/keeper/matrix.yaml` — the provider roster (cost-ascending) and the models each serves.
2. For a new model, add its selector guidance with `/plan:model-guidance <model>` (the drift gate fails until every roster model has a block).
3. Re-render the worker cells: `keeper prompt render-plugin-templates --project-root plugins/plan` (confirm with `ls plugins/plan/workers/`).
4. Verify routing: `keeper agent providers resolve <model> <effort>`.
5. Let the selector assign the cell, then watch the first dispatch land — the wrapper owns the close-out and its commit carries the `Job-Id`/`Task` trailers.

**Shell completions.** The installer writes generated bash/zsh/fish completion files into shell-owned
user locations (idempotent — a rerun overwrites the same managed files, never appends): fish to
`~/.config/fish/completions/keeper.fish` (autoloaded), bash to
`~/.local/share/bash-completion/completions/keeper` (needs the bash-completion package), and zsh to a
writable Homebrew `share/zsh/site-functions/_keeper` when available, else
`~/.local/share/zsh/site-functions/_keeper`. It **never** edits `.zshrc`, `.bashrc`, `.bash_profile`,
or fish config — when a shell needs activation (e.g. adding the zsh dir to `fpath` before `compinit`)
the installer prints a one-time snippet to opt into. Set `KEEPER_SKIP_COMPLETIONS=1` to skip the step,
or regenerate a script by hand with `keeper completions <bash|zsh|fish>`.

Any third-party plugin set (arthack's, for one) is **optional** — a fresh machine loads keeper's two and
nothing else. Opt in by appending a parent to `plugin_scan_dirs` in your own `plugins.yaml` (e.g.
`- ~/code/arthack/claude`). Automated workers additionally carry a keeper-owned permission posture
(`--permission-mode acceptEdits --dangerously-skip-permissions`) and an optional `worker_plugin_isolation`
gate that drops those scanned third-party plugins from worker launches (interactive sessions unaffected).
[docs/plugin-composition-map.md](./docs/plugin-composition-map.md) is the full map;
`bun scripts/clean-machine-check.ts` proves the arthack-free launch path end to end.

One manual step has no code home:

- **Sitter scanners (optional).** The read-only sitter set lives in its own repo at `~/code/sitter`;
  install and uninstall it per that repo's `README.md`.

## Uninstall

```sh
launchctl bootout gui/$(id -u)/arthack.keeperd
rm ~/Library/LaunchAgents/arthack.keeperd.plist
launchctl bootout gui/$(id -u)/arthack.keeperd.logrotate
rm ~/Library/LaunchAgents/arthack.keeperd.logrotate.plist
rm ~/.config/tmux/conf.d/zz-keeper-guard.conf
rm ~/.config/keeper/plugins.yaml   # the shipped keeper-agent plugin sources
# Shell completions (whichever the installer wrote — safe if absent):
rm -f ~/.config/fish/completions/keeper.fish
rm -f ~/.local/share/bash-completion/completions/keeper
rm -f ~/.local/share/zsh/site-functions/_keeper
rm -f "$(brew --prefix 2>/dev/null)/share/zsh/site-functions/_keeper"
# Uninstall the sitter scanners per ~/code/sitter's README.
rm -rf ~/.local/state/keeper   # optional — drops all captured state
```

## Architecture

The imperative fold / migration / write-scoping / worker guardrails live in [CLAUDE.md](./CLAUDE.md),
and per-subsystem detail lives in the named `src/` modules. A few cross-cutting invariants that fit
neither:

- **Two cursors.** The ingest byte-offset (`event_ingest_offsets`, NDJSON -> `events`) and the
  reducer's `reducer_state.last_event_id` (`events` -> projections) are distinct. The NDJSON append
  does not bump `data_version`; main's `events` INSERT does, waking the downstream pollers for free.
- **Two boot gates.** The read-only subscribe socket comes up right after `migrate()`, before the boot
  drain, so reads are served while the reducer catches up — every reply carries a boot-status header.
  State-changing surfaces (the autopilot actuator, mutating RPC) stay gated behind drain-reaches-head
  + git-seed; a mutating RPC during the drain is rejected `server_booting`.
- **Three projection classes.** Deterministic-replayed projections (`jobs` / `epics` / ... — the sacred
  default) re-fold byte-identically from the log. Live-only projections (the git surface, the live
  tmux-location columns — `LIVE_ONLY_PROJECTIONS`) are producer-fed and never replayed; a rewinding
  migration resets their floor and re-seeds rather than wiping. Ephemeral projections
  (`EPHEMERAL_PROJECTIONS`, e.g. `pending_dispatches`) fold during the drain but are truncated before
  serving so in-flight state rebuilds from current reality.
- **Worktree mode** (opt-in, off by default) runs the autopilot's per-epic tasks in isolated git
  worktrees on `keeper/epic/<id>` lanes so sibling tasks build in parallel without colliding, then
  merges each finished lane back to the default branch. The lane/merge-gate invariants live in
  [CLAUDE.md](./CLAUDE.md).
- **Example clients** ship as one binary — `keeper board`, `keeper jobs`, `keeper autopilot`,
  `keeper git`, `keeper usage`, `keeper await`, `keeper status`, `keeper query`, `keeper baseline`, `keeper tabs`
  (crash-restore of keeper-managed agent windows — distinct from the DB "Backup & restore" below).

## Backup & restore

`keeper.db` is the source of truth, so the daemon guards it with a periodic `PRAGMA quick_check`
integrity probe and a daily verified `VACUUM INTO` snapshot (kept only if the full `integrity_check`
passes). The backup, restore, and offline size-reclaim runbooks are rendered from code — the single
source of truth — via `keeper reclaim --agent-help`, `bun scripts/backup-db.ts`, and
`reclaimInstructions()` / `restoreInstructions()` in `src/backup.ts`. Because projections fold
deterministically from the immutable `events` table, a restored snapshot re-derives byte-identical
projections.
