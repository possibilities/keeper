# Install & operations

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
owned by you and mode `644` or macOS silently ignores it. Optional account-routing integrations are
discovered through their CLIs; there is no keeper config map to author for them. The autoclose worker
force-closes the exact tmux window of a done-and-idle keeper-dispatched agent after a grace: autopilot
`work::`/`close::` workers, finished claude panel legs, escalation windows whose block or conflict
instance is resolved, and wrapped provider legs in the shared `wrapped` tmux session all use the same
run-handle/window identity cleanup. `autoclose_enabled` (default `true`; set `false`/`off`/`no`/`0` to
disable — re-read every pulse, so a flip needs no daemon restart) and `autoclose_grace_seconds`
(default `30`) govern it. Wrapped provider-leg titles are bare task IDs for display; resume and cleanup
continue by the captured harness resume target and exact tmux identity, not by title.

### Account routing (optional)

Claude account routing is optional and fails open to the native default account when either integration
is absent or unusable.

| Capability | Public command | Keeper role |
|---|---|---|
| Ambient gate | `codexbar --provider claude --format json` | Observes the ambient Claude account and gates automatic balancing; never supplies managed-account rows. |
| Managed telemetry | `cswap list --json` | Supplies managed-account inventory, launchability, quota windows, and freshness. |
| Managed execution | `cswap run <slot> --share-history -- <claude arguments...>` | Runs one managed Claude process without globally switching other terminals. |

`keeper agent accounts check --json` is the read-only, PII-free diagnostic: it reports integration
health, snapshot age, candidate route ids such as `default` and `claude-swap:<slot>`, and the route the
policy would choose without reserving it. Every Claude start, resume, and restore selects independently
from the latest observation; launch attribution explains one process but never creates account affinity
for a later process.

The selection policy is continuous: each routeable candidate is scored by its worst normalized quota
window after short-lived launch reservations, the greatest remaining headroom wins, and
least-recently-used order breaks ties. The account-routing rationale lives in
[ADR 0038](./adr/0038-external-capacity-and-per-launch-account-routing.md).

Claude `settings.json` is seeded at install time from the keeper stow source only when the live file is
absent. After that seed, the local file is the canonical value: keeper leaves local edits in place and
claude-swap shares the same live settings into managed sessions.

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
error handler. `cleanup_failed` withholds success and names exact `member#attempt` survivors; inspect
those identities and their exported `tmux-runs/<run-id>/control.json` commands instead of using
session-wide tmux cleanup or process-name matching. Detailed states are in
[problem-codes.md](./problem-codes.md#panel-run-lifecycle).

The post-install lifecycle gate uses a configured panel containing two or three inexpensive members and
never reuses the production design inquiry:

```sh
bun test test/panel-lifecycle-integration.test.ts
KEEPER_RUN_SLOW=1 bun test test/pair-panel.slow.test.ts
bun scripts/panel-smoke.ts --panel <small-panel> --outer-timeout 120
bun scripts/panel-smoke.ts --panel <small-panel> --outer-timeout 120 --abort-after 5
```

Both smoke reports must show `launch_count` equal to the configured member count exactly once,
settled cancellation, and `exact_survivor_count: 0`. Keep the original design inquiry gated until both
the terminal run and explicit-abort run satisfy those checks; do not retry that inquiry as validation.
A `cleanup_failed` report keeps the gate closed until its listed exact identities are reconciled.

Every keeper-launched Pi session (`keeper agent pi`) also gets `/rename`, which derives
a short Session title from the current branch's Latest turn and applies it through Pi's own
`setSessionName()`. It requires Pi's own OAuth login to serve the one fixed cheap
`openai-codex/gpt-5.3-codex-spark` model — no fallback model, no separate keeper credential. Absent
that OAuth, an unresolvable model, an empty turn, or a malformed model response, `/rename` no-ops
with an in-Pi notification and leaves the existing title unchanged; a successful rename reaches
Keeper's title projection and the tmux renamer asynchronously through the existing `TranscriptTitle`
event, never a direct DB/tmux write.

## Host worker matrix (required)

A host `~/.config/keeper/matrix.yaml`
([ADR 0036](./adr/0036-required-host-matrix-v2-with-launch-id-entries.md)) is the single,
REQUIRED worker-matrix config — there is no embedded fallback, so a fresh host cannot render,
select, or dispatch worker cells (claude-native included) until it exists. Top level: the default
`efforts` axis, `subagent_templates` (the cell-template inventory the renderer fans out),
`subagent_models` (the explicit capability tokens eligible to render and select as worker cells),
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
or valid-but-empty — surfaced on every reading surface (loaders, the template renderer, plan verbs,
`keeper agent` provider resolution); the daemon never exits on it, parking dispatch behind a visible
distress sticky until the file is fixed. Standing up a host:

1. Copy [`docs/examples/matrix.example.yaml`](./examples/matrix.example.yaml) — a committed,
   load-tested reference shape (claude native models, a codex-served capability model with a
   per-provider effort override, a launch-only pi entry absent from `subagent_models`, the wrapper
   driver, the 11 seeded `agent_pins`) — to `~/.config/keeper/matrix.yaml`, or author your own
   roster from scratch. It is not itself a discovered config path. Authoring from scratch still
   needs an `agent_pins:` entry per static plan agent — copy the example's block as a starting
   point, since it names all 11 by their current agent id.
2. For a new model, add its selector guidance with `/plan:model-guidance <model>` (the drift gate fails until every roster model has a block).
3. Re-render the worker cells AND the static agents: `keeper prompt render-plugin-templates --project-root plugins/plan` (confirm with `ls plugins/plan/workers/` and `ls plugins/plan/agents/`). A static agent template with no matching `agent_pins` entry fails the render loud, naming the agent.
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

## Sitter scanners (optional)

One manual step has no code home: the read-only sitter set lives in its own repo at `~/code/sitter`;
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

## Backup & restore

`keeper.db` is the source of truth, so the daemon guards it with a periodic `PRAGMA quick_check`
integrity probe and a rolling verified `VACUUM INTO` snapshot (kept only if the full `integrity_check`
passes; see `BACKUP_INTERVAL_MS` in `src/backup.ts` for the current cadence). The backup, restore,
and offline size-reclaim runbooks are rendered from code — the single
source of truth — via `keeper reclaim --agent-help`, `bun scripts/backup-db.ts`, and
`reclaimInstructions()` / `restoreInstructions()` in `src/backup.ts`. Because projections fold
deterministically from the immutable `events` table, a restored snapshot re-derives byte-identical
projections. (`keeper tabs` crash-restore of agent windows is a separate surface — it restores tmux
windows, not the DB.)

**Offline reclaim maintenance window** — `bun scripts/maintenance-window.ts` is the supported
one-command path for the whole window (pause autopilot, drain, snapshot, stop the daemon, reclaim,
restart, verify, then hold or restore autopilot). It wraps the same `reclaimInstructions()` steps
above under one safety-gated command instead of running them by hand; `--hold` leaves autopilot
paused after a successful run for triage.
