# Install & operations

## Install

`scripts/install.sh` owns the install footprint (idempotent — safe to re-run):

```sh
git clone <repo-url> ~/code/keeper
cd ~/code/keeper
mkdir -p ~/.local/state/keeper   # launchd does not pre-create the state dir
bash scripts/install.sh          # deps -> bun link -> keeperd bootstrap
```

Edit `plist/arthack.keeperd.plist` before the first bootstrap if your username, checkout path, or bun
path differ (Apple Silicon `/opt/homebrew/bin/bun`, Intel `/usr/local/bin/bun`); the plist must be
owned by you and mode `644` or macOS silently ignores it. Keeper-launched Claude requires the
installer-managed claude-swap CLI and at least one registered account; Pi and non-Claude surfaces remain
available without it, and there is no account-routing config map to author.

The autoclose worker force-closes the tmux window of a done-and-quiescent
keeper-dispatched agent (an autopilot `work::`/`close::` worker, a finished
claude panel leg, or a legacy ownerless Provider leg in the shared `wrapped`
tmux session) after a grace. It cancels the grace on renewed Harness activity or
a parked prompt and acts only after an exact Dispatch claim release plus
canonical tmux-generation and recycle-safe process checks. `autoclose_enabled`
(default `true`; set `false`/`off`/`no`/`0` to disable — re-read every pulse, so
a flip needs no daemon restart) and `autoclose_grace_seconds` (default `30`)
govern it. A finished `unblock`/`deconflict`/`resolve` escalation window is
reaped under the same knobs once its block or conflict instance is resolved.

Owned Provider legs use the durable leg cascade instead. It proves the exact
wrapper Dispatch attempt, confirms leg exit, and tears down only the
birth-captured pane under canonical generation, wrapped-session, and one-pane
checks before releasing that attempt's exact claim. An owned idle-stopped window
uses the same actuator. Provider-leg titles are display-only: resume uses the
captured Harness resume target, and ownership can move only through a fenced
transfer transition. `keeper status` reports the remaining legacy ownerless
cohort as a display-only drain count; it never jams the board.
Logical worktree merge may land while that inspection window remains open; lane/worktree/cwd removal
waits until the exact Resource hold clears. A generation mismatch, recycled pid, reused lane path, or
failed probe defers cleanup rather than targeting a replacement owner. Generic Restore excludes
both autopilot `work` and `close` sessions; manual and Adopted sessions remain restore candidates.

For lifecycle diagnosis, run the bounded audit against an explicit copied snapshot or a database the
operator has made read-only; it opens SQLite read-only and does not contact the daemon or socket:

```sh
bun scripts/audit-session-activity.ts --db /path/to/keeper.snapshot.db --limit 200
```

The JSON reports aggregate Harness activity reasons, Dispatch attempt evidence, Dispatch claim states,
legacy classification deltas, and only the session/target identifiers needed for follow-up. It never
prints transcript bodies, prompts, shell output, credentials, titles, cwd values, or transcript paths.
`selected_truncated`, `child_rows_truncated_for`, `claim_rows_truncated_for`, and
`stale_attempts_truncated` identify an incomplete bounded reading; increase `--limit` up to the tool's
cap or take a narrower snapshot rather than querying the resident daemon. After deploying matching code,
use the normal status/query surfaces to verify the same identifiers against the resident daemon; do not
treat moving live counts as an acceptance threshold.
Recovery by reason is in [problem-codes.md](./problem-codes.md#lifecycle-evidence-diagnostics).

### Claude account routing

Claude launches require [claude-swap](https://github.com/realiti4/claude-swap). Every installer run executes
`uv tool install --upgrade claude-swap`; a missing `uv` or failed transaction is nonfatal to Keeper's
non-Claude surfaces, but Claude remains unavailable until `cswap` works and at least one account is
registered.

Installer upgrades remove the retired CodexBar stable symlink only when it targets Keeper's exact data
root, and remove the corresponding data only when it carries Keeper's signing identifier. A foreign
symlink, non-symlink executable, unproven data directory, app bundle, and Homebrew cask are always left
untouched.

The daemon invokes `cswap list --json` through an exact-argv, output-capped, deadline-bounded runner and
publishes one private, freshness-bounded Capacity observation. Only managed rows with `usageStatus: ok`,
a freshness signal, and at least one understood quota window are routeable. Unknown, stale, malformed,
signed-out, or otherwise unusable rows are excluded rather than treated as spare capacity.

Every fresh, resumed, or restored Claude process independently selects the route with the greatest
worst-window headroom after short-lived Launch reservations; least-recently-used order breaks ties. A
successful decision always executes through:

```sh
cswap run <slot> --share-history -- <claude arguments...>
```

This applies to the currently active claude-swap account as well as every other slot. There is no native
or ambient-account fallback: missing/stale inventory or zero routeable accounts fails before Claude
starts. Launch attribution records only the PII-free `claude-swap:<slot>` route and never creates account
affinity for a later process.

`keeper agent accounts check --json` reports observation health, snapshot age, PII-free candidates, and
the managed route the policy would choose without reserving it. Use `keeper agent claude --x-account cN`
to request one account, where `c0`, `c1`, … are zero-based positions in ordered inventory and match the
Claude statusline label. An explicit request fails rather than substituting another account.

Claude `settings.json` is seeded at install time from the Keeper stow source only when the live file is
absent. After that seed, the local file is canonical and claude-swap shares it into managed sessions.
The routing contract is specified by [ADR 0079](./adr/0079-mandatory-claude-swap-routing.md).

Private clean-break archive, outside keeper's runtime, with the archive root at mode `0700`:

```sh
archive="$HOME/archive/keeper-agent-usage"
if [ -e "$archive" ]; then
  echo "archive path already exists: $archive" >&2
  exit 1
fi
install -d -m 700 "$archive"

for path in \
  "$HOME/.local/state/agentusage" \
  "$HOME/.claude-profiles" \
  "$HOME/.pi-profiles"
do
  [ -e "$path" ] || continue
  dest="$archive/$(basename "$path")"
  if [ -e "$dest" ]; then
    echo "archive collision: $dest" >&2
    exit 1
  fi
  mv "$path" "$dest"
done

chmod 700 "$archive"
```

This archive is rollback evidence only. It moves retired private state byte-for-byte without reading,
inspecting, importing, or translating credentials, and keeper never reads the archive as launch state.

### Reload trigger

`install.sh` reloads keeperd only when the daemon's **load surface** changed — not on every commit.
That surface is the set of paths the resident daemon actually holds in memory, declared in
`scripts/daemon-load-roots.txt`: the source tree `src/daemon.ts` transitively imports, the
plan-engine modules and embedded matrix config it reaches, the dependency lockfile pair, and its
own plist. `scripts/daemon-fingerprint.ts` hashes those roots content-addressed at HEAD (the
manifest's own blob folds in) into one composite, and the installer bounces the LaunchAgent only
when the composite moves. So a docs-only or plan-board-checkpoint commit leaves the running daemon
untouched, while a `src/` edit reloads it. Failure directions are asymmetric: a declared root that
fails to resolve at HEAD fails the install loudly (a manifest bug to fix), while git being wholly
undeterminable degrades to the plist-content gate alone (a fresh-machine install). The fast-tier
`test/daemon-load-surface.test.ts` walks the daemon's real import closure — worker-spawn and
attribute-import edges included — and asserts it stays inside the manifest, so the fingerprint can
never quietly lie about the boundary. See
[ADR 0029](./adr/0029-daemon-load-surface-fingerprint.md).

## Plugins

`keeper agent` loads keeper's own two plugins (`plugins/keeper`, `plugins/plan`) from
`~/.config/keeper/plugins.yaml`, which `install.sh` writes on a fresh machine (keeper-only, no
third-party sources) and leaves untouched when a file or symlink is already there. The keeper plugin
ships the statusLine settings file (`keeper statusline`), which `keeper agent` passes when the caller
has not supplied `--settings`. Do NOT add a `~/.claude/plugins/keeper` symlink — it double-registers
the hook (two `events` rows per invocation).

Any third-party plugin set (arthack's, for one) is **optional** — a fresh machine loads keeper's two
and nothing else. Opt in by appending a parent to `plugin_scan_dirs` in your own `plugins.yaml` (e.g.
`- ~/code/arthack/claude`). Automated workers additionally carry a keeper-owned permission posture
(`--permission-mode acceptEdits --dangerously-skip-permissions`) and an optional `worker_plugin_isolation`
gate that drops those scanned third-party plugins from worker launches (interactive sessions unaffected).
[plugin-composition-map.md](./plugin-composition-map.md) is the full map;
`bun scripts/clean-machine-check.ts` proves the arthack-free launch path end to end.

### Pi Task and panel operations

Keeper's Pi compatibility layer requires `@tintinweb/pi-subagents` with its supported event-bus RPC.
The installer renders Keeper's named `plan:*` agents into Pi's canonical agent directory and loads the
tracked Task facade only for keeper-launched Pi sessions. A Task call fails loudly if the package is
absent, its RPC protocol is incompatible, or the requested named agent is unresolved; there is no
fallback to a generic agent. Cancellation is owner-scoped and does not settle until nested Task scopes
acknowledge termination or report their exact unresolved identity. Re-run `scripts/install.sh` after
agent-template or extension changes, then use the rendered-agent parity tests before a Pi panel.

Panel retries are identity-sensitive: repeat `wait` after exit 124 against the same run directory, use
`resume` only for its bounded positively-dead recovery, and never rerun `start` under a fresh slug as an
error handler. `cleanup_failed` withholds success and names exact `member#attempt` obligations while
daemon maintenance retries their canonical controls after client exit or restart. Persistent missing,
malformed, ownership-mismatched, inaccessible, or teardown-failing controls retain a bounded
per-attempt `cleanup_error` in the manifest for inspection; never replace
them with session-wide tmux cleanup, process-name matching, or a target derived from display metadata.
Detailed states are in
[problem-codes.md](./problem-codes.md#panel-run-lifecycle).

After installing agent-template or extension changes, run the repository correctness gate:

```sh
bun run test:full
```

For a manual, non-blocking panel diagnostic, use a configured panel containing two or three
inexpensive members and do not reuse the production design inquiry:

```sh
bun scripts/panel-smoke.ts --panel <small-panel> --outer-timeout 120
bun scripts/panel-smoke.ts --panel <small-panel> --outer-timeout 120 --abort-after 5
```

Inspect each smoke report for `launch_count` equal to the configured member count exactly once,
settled cancellation, `wrapper_survivor_count: 0`, `unresolved_control_count: 0`,
`exact_window_survivor_count: 0`, and aggregate `exact_survivor_count: 0`. A `cleanup_failed` report
names the exact identities maintenance continues to reconcile; operator action is reserved for a
persistent fail-closed control diagnosis. The canonical test commands and budget policy are in
[docs/testing.md](./testing.md).

Every keeper-launched Pi session (`keeper agent pi`) also gets `/rename`, which derives
a short Session title from the active branch's bounded, compaction-aware conversation context,
with extra weight on user requests, and applies it through Pi's own `setSessionName()`. Passing a
canonical lowercase slug sets it directly (`/rename project-search-ranking`); any non-slug argument
returns an error without changing the title. Bare `/rename` starts inference as soon as the active
context contains one user or assistant message, including while the assistant is still responding;
it remains pending only when no such message exists yet. Inference requires Pi's own OAuth login to
serve the one fixed cheap `openai-codex/gpt-5.3-codex-spark` model — no fallback model, no separate
keeper credential. Absent that OAuth, an unresolvable model, or a malformed model response,
`/rename` no-ops with an in-Pi notification and leaves the existing title unchanged; a successful
rename reaches
Keeper's title projection and the tmux renamer asynchronously through the existing `TranscriptTitle`
event, never a direct DB/tmux write.

## Host worker matrix (required)

A host `~/.config/keeper/matrix.yaml`
([ADR 0036](./adr/0036-required-host-matrix-v2-with-launch-id-entries.md)) is the single,
REQUIRED worker-matrix config — there is no embedded fallback, so a fresh host cannot compile,
select, or dispatch worker cells (claude-native included) until it exists. Top level: the default
`efforts` axis, `subagent_templates` (the cell-template inventory the compiler expands into one
shared cohort), `subagent_models` (the explicit capability tokens eligible to compile and select as worker cells),
`wrapper_driver` (the fixed claude model/effort every wrapped cell's wrapper runs at),
`agent_pins` (every static plan subagent's `{model, effort}` pin, baked into its rendered
frontmatter — a pair, never a triple, since frontmatter carries no harness axis), and
`providers` — an ordered roster (cost-ascending — the pecking order), each carrying the launch ids
it serves. A provider model entry is the launch id verbatim (the string the harness CLI receives)
as a bare scalar or `{id, efforts}` for a per-model effort-list override (most-specific wins — a
per-model override beats a per-provider override, which beats the top-level `efforts:` axis); its
capability token derives from the segment after the last `/` (the whole id when slash-free). A
capability the `claude` provider serves is **native** (its worker runs that model in-session); any
other renders as a **wrapped cell** whose claude worker delegates implementation to the
cost-preferred serving provider at run time. The same derived capability served by more than one
provider is one axis value — the first provider in the pecking order wins and owns its effort list,
and every other entry is recorded as a shadow in the parsed matrix (not yet surfaced by any reading
path). A roster capability absent from `subagent_models` is
**launch-only**: it stays enumerable as a launch triple (pairing, panels, `presets list`) but never
joins a worker cell. `keeper agent providers check` validates the roster and lints the operator's
configured host launch triples (the four `<harness>_default` triples, `worker`, `escalation`, panel
members) against the enumerable cube, flagging a well-formed triple outside it as drift; `keeper
agent providers resolve <model> <effort>` prints the driver plus the cost-ordered candidate
harnesses. Absence or malformedness is a typed loud failure discriminated into four states — absent,
unparseable, schema-invalid (a retired key like `route:`/`native:`/`name:`/`subagents:` is named),
or valid-but-empty — surfaced on every reading surface (loaders, the prompt compiler and its
compatibility renderer, plan verbs, `keeper agent` provider resolution); the daemon never exits on
it, parking dispatch behind a visible distress sticky until the file is fixed.

`keeper prompt compile --role work:worker --target claude` owns the complete shared cohort under
`plugins/plan/workers/`. It fingerprints the catalog, matrix, and captured template-include graph;
owns every worker agent, plugin manifest, JSON sidecar, and cohort manifest; prunes only owned
orphans; and publishes the manifest last after byte verification. `--check` is write-free. Manual
and autopilot dispatch verify that state before launch: an absent selected manifest is
`worker-cell-missing`, while a present but stale or corrupt cohort is `worker-cell-stale`. Both name
the compiler command as recovery. Task `{model, tier}` assignment and any producer-side provider
constraint still choose the runtime cell; compilation never creates task-specific prompts or
provider-equivalence substitutes.

Standing up a host:

1. Copy [`docs/examples/matrix.example.yaml`](./examples/matrix.example.yaml) — a committed,
   load-tested reference shape (Claude-native models, a Pi-hosted capability model with a
   per-provider effort override, a launch-only Pi entry absent from `subagent_models`, the wrapper
   driver, the 11 seeded `agent_pins`) — to `~/.config/keeper/matrix.yaml`, or author your own
   roster from scratch. It is not itself a discovered config path. Authoring from scratch still
   needs an `agent_pins:` entry per static plan agent — copy the example's block as a starting
   point, since it names all 11 by their current agent id.
2. For a new model, add its selector guidance with `/plan:model-guidance <model>` (the drift gate fails until every roster model has a block).
3. Render the plan plugin's generated surfaces with `keeper prompt render-plugin-templates --project-root plugins/plan`. This compatibility front door renders static agents and delegates worker publication once to the Claude compiler. Verify the worker cohort with `keeper prompt compile --role work:worker --target claude --check`, and confirm static agents with `ls plugins/plan/agents/`. A static agent template with no matching `agent_pins` entry fails loud, naming the agent. For a worker-only source or matrix change, the direct compiler command is sufficient.
4. Compose and install the described panel roster with `/plan:panel-guidance`. It authors the committed `plugins/plan/panel-selector.yaml` as ten named panel objects, each with `strength`, `members`, and `description`; its structural gate verifies the roster before the skill copies that exact file to `~/.config/keeper/panel.yaml`.
5. Discover the enumerable cube and verify routing: `keeper agent presets list --json` lists every
   `<harness>::<model>::<effort>` launch triple the roster now serves (cell-bearing and launch-only
   alike), the resolved per-verb `dispatch:` table, and each configured panel's ordered members,
   authored strength, and description; `keeper agent providers resolve <model> <effort>` traces one
   model's cost-ordered candidates. `keeper agent providers check` fails loud when the roster names
   a harness whose binary is missing from the host, or when a host file (`presets.yaml`
   defaults/`dispatch:`, `panel.yaml` `members`) names a launch triple outside the enumerable cube —
   install the missing binary or correct the triple, rather than treating the failure as a bug.
6. Wire the four `<harness>_default` triples plus the per-verb `dispatch:` table
   (`work`/`close`/`resolve`/`unblock`/`deconflict`/`repair`/`handoff`) in
   `~/.config/keeper/presets.yaml` from the triples `presets list` discovered. The panel roster is
   installed only through `/plan:panel-guidance`; its `default` pointer and described panel objects
   travel together in the committed copy.
7. Let the selector assign the cell, then watch the first dispatch land — the wrapper owns the close-out and its commit carries the `Job-Id`/`Task` trailers.

## Shell completions

The installer writes generated bash/zsh/fish completion files into shell-owned user locations
(idempotent — a rerun overwrites the same managed files, never appends): fish to
`~/.config/fish/completions/keeper.fish` (autoloaded), bash to
`~/.local/share/bash-completion/completions/keeper` (needs the bash-completion package), and zsh to a
writable Homebrew `share/zsh/site-functions/_keeper` when available, else
`~/.local/share/zsh/site-functions/_keeper`. It **never** edits `.zshrc`, `.bashrc`, `.bash_profile`,
or fish config — when a shell needs activation (e.g. adding the zsh dir to `fpath` before `compinit`)
the installer prints a one-time snippet to opt into. Set `KEEPER_SKIP_COMPLETIONS=1` to skip the step,
or regenerate a script by hand with `keeper completions <bash|zsh|fish>`.

## Tmux drop-ins (optional)

`keeper setup-tmux` symlinks Keeper's three tmux drop-ins into `~/.config/tmux/conf.d/`: the load-last
managed-session guard, `tmux/keeper-notes.conf`, and `tmux/keeper-shell.conf`. The shell drop-in marks new
tmux panes with `KEEPER_ZSH_DROPINS=1`; a zsh startup file may use that marker to source the fixed
`~/code/keeper/shell/zsh/*.zsh` path. Keeper's matrix defines `c0`–`c3` account selectors and their
model/effort combinations only in marked tmux shells. The marker never carries a caller-controlled source
path.

The Note drop-in binds prefix `N` to `keeper note new --fresh` (blank editor first, then the action menu)
and prefix `B` to `keeper note browse`, using 90% popups rooted at the caller pane's working directory.
Successful commands close; a failure remains visible until Enter. The installer is idempotent, repairs
stale symlinks, and never replaces a real file at any destination. Your tmux config must source
`conf.d/*.conf`; reload it after setup to activate the drop-ins in a running server.

Fresh capture uses Keeper's OpenTUI composer: Enter continues to the action picker,
Shift-Enter or Ctrl-J inserts a newline, Ctrl-G saves the draft and temporarily cedes the terminal to
`$VISUAL`/`$EDITOR`, and Esc quietly closes while preserving the draft. Install `fzf` and keep `$VISUAL`
or `$EDITOR` set to a blocking command. Notes live in the mode-0600
`~/.local/state/keeper/notes.db`; composer changes and unfinished editor drafts live beside it and remain
recoverable after a popup or editor exits unexpectedly. Successful clipboard copies and fresh-agent launches move a Note from
active to archived history. Sending hands the body to the selected harness through the existing launcher,
so process visibility and that harness's transcript policy apply beyond the mode-0600 local store.
`keeper note --help` carries the interaction and failure semantics.

## Sitter scanners (optional)

One manual step has no code home: the read-only sitter set lives in its own repo at `~/code/sitter`;
install and uninstall it per that repo's `README.md`.

## Uninstall

```sh
launchctl bootout gui/$(id -u)/arthack.keeperd
rm ~/Library/LaunchAgents/arthack.keeperd.plist
launchctl bootout gui/$(id -u)/arthack.keeperd.logrotate
rm ~/Library/LaunchAgents/arthack.keeperd.logrotate.plist
rm ~/.config/tmux/conf.d/keeper-notes.conf
rm ~/.config/tmux/conf.d/keeper-shell.conf
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

## Backup & restore

`keeper.db` is the source of truth, so the daemon guards it with a periodic `PRAGMA quick_check`
integrity probe and a rolling verified `VACUUM INTO` snapshot (kept only if the full `integrity_check`
passes; see `BACKUP_INTERVAL_MS` in `src/backup.ts` for the current cadence). The backup, restore,
and offline size-reclaim runbooks are rendered from code — the single
source of truth — via `keeper reclaim --agent-help`, `bun scripts/backup-db.ts`, and
`reclaimInstructions()` / `restoreInstructions()` in `src/backup.ts`. Because projections fold
deterministically from the immutable `events` table, a restored snapshot re-derives byte-identical
projections.

The independent `notes.db` takes the same verified `VACUUM INTO` snapshots after a mutating
`keeper note` command when its rolling interval is due. Its snapshots live under
`~/.local/state/keeper/notes-backups/`. Restore a chosen snapshot only while no `keeper note`
command is running, replacing the database atomically and removing the old journal sidecars:

```sh
db="${KEEPER_NOTES_DB:-$HOME/.local/state/keeper/notes.db}"
leaf="$(basename "$db")"; [ "$leaf" = notes.db ] && ns=notes || ns="$leaf"
snapshot="$(dirname "$db")/${ns}-backups/keeper-YYYYMMDDTHHMMSS.db"
cp "$snapshot" "$db.restore"
cmp -s "$snapshot" "$db.restore" || exit 1
chmod 600 "$db.restore"
rm -f "${db}-wal" "${db}-shm" "${db}-journal"
mv "$db.restore" "$db"
```

Notes never ride a `keeper.db` reclaim or restore. (`keeper tabs` crash-restore of agent windows is
a separate surface — it restores tmux windows, not either DB.)

**Offline reclaim maintenance window** — `bun scripts/maintenance-window.ts` is the supported
one-command path for the whole window (pause autopilot, drain, snapshot, stop the daemon, reclaim,
restart, verify, then hold or restore autopilot). It wraps the same `reclaimInstructions()` steps
above under one safety-gated command instead of running them by hand; `--hold` leaves autopilot
paused after a successful run for triage.
