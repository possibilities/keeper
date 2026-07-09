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
owned by you and mode `644` or macOS silently ignores it. Optional roots and runtimes live in
`~/.config/keeper/config.yaml`, including the `usage_models` map that declares which claude profiles
and codex the usage scraper produces envelopes for and their display aliases (an absent or malformed
map idles the producer rather than erroring). The autoclose worker force-closes the tmux window of a
done-and-idle keeper-dispatched agent (an autopilot `work::`/`close::` worker or a finished claude
panel leg) after a grace: `autoclose_enabled` (default `true`; set `false`/`off`/`no`/`0` to disable —
re-read every pulse, so a flip needs no daemon restart) and `autoclose_grace_seconds` (default `30`)
govern it. A finished `unblock`/`deconflict`/`resolve` escalation window is reaped under the same
knobs once its block or conflict instance is resolved.

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

## Host provider matrix (optional)

By default the plan worker matrix is claude-only. A host `~/.config/keeper/matrix.yaml`
([ADR 0010](./adr/0010-host-provider-matrix-and-wrapped-worker-cells.md)) grows the model axis with
capability models served by codex or pi: an ordered provider roster (cost-ascending — the pecking
order), each provider carrying the models it serves (with optional native-id aliases), plus the
effort axis and the wrapper driver (the fixed claude model/effort that runs wrapped cells). A model
under the `claude` provider stays **native** (its worker runs that model in-session); any other
renders as a **wrapped cell** whose claude worker delegates implementation to the cost-preferred
serving provider at run time. `keeper agent providers check` validates the roster;
`keeper agent providers resolve <model> <effort>` prints the driver plus the cost-ordered candidate
harnesses. With no matrix present, rendering, selection, and dispatch stay byte-identical to the
claude-only default. Standing up the first wrapped task on a host:

1. Author `~/.config/keeper/matrix.yaml` — the provider roster (cost-ascending) and the models each
   serves. [`docs/examples/matrix.example.yaml`](./examples/matrix.example.yaml) is a committed,
   load-tested reference shape (claude native models, a codex-served capability model, the wrapper
   driver) to copy from; it is not itself a discovered config path.
2. For a new model, add its selector guidance with `/plan:model-guidance <model>` (the drift gate fails until every roster model has a block).
3. Re-render the worker cells: `keeper prompt render-plugin-templates --project-root plugins/plan` (confirm with `ls plugins/plan/workers/`).
4. Verify routing: `keeper agent providers resolve <model> <effort>`. `keeper agent providers check`
   fails loud when the roster names a harness whose binary is missing from the host — install the
   binary or drop the provider, rather than treating the failure as a bug.
5. Let the selector assign the cell, then watch the first dispatch land — the wrapper owns the close-out and its commit carries the `Job-Id`/`Task` trailers.

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
integrity probe and a daily verified `VACUUM INTO` snapshot (kept only if the full `integrity_check`
passes). The backup, restore, and offline size-reclaim runbooks are rendered from code — the single
source of truth — via `keeper reclaim --agent-help`, `bun scripts/backup-db.ts`, and
`reclaimInstructions()` / `restoreInstructions()` in `src/backup.ts`. Because projections fold
deterministically from the immutable `events` table, a restored snapshot re-derives byte-identical
projections. (`keeper tabs` crash-restore of agent windows is a separate surface — it restores tmux
windows, not the DB.)
