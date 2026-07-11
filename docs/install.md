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
4. Discover the enumerable cube and verify routing: `keeper agent presets list --json` lists every
   `<harness>::<model>::<effort>` launch triple the roster now serves (cell-bearing and launch-only
   alike) plus the resolved per-verb `dispatch:` table; `keeper agent providers resolve <model>
   <effort>` traces one model's cost-ordered candidates. `keeper agent providers check` fails loud
   when the roster names a harness whose binary is missing from the host, or when a host file
   (`presets.yaml` defaults/`dispatch:`, `panel.yaml` members) names a launch triple outside the
   enumerable cube — install the missing binary or correct the triple, rather than treating the
   failure as a bug.
5. Wire the four `<harness>_default` triples plus the per-verb `dispatch:` table
   (`work`/`close`/`resolve`/`unblock`/`deconflict`/`repair`/`handoff`) in
   `~/.config/keeper/presets.yaml`, and any panel members in `~/.config/keeper/panel.yaml`, from
   the triples `presets list` discovered. Migrating from a `worker:`/`escalation:` host: move the
   old `worker` triple to `dispatch.work` / `dispatch.close` / `dispatch.resolve`, and the old
   `escalation` triple to `dispatch.unblock` / `dispatch.deconflict` / `dispatch.repair` — a
   leftover `worker:`/`escalation:` key fails `presets.yaml` to load loud, naming the retired key
   and the `dispatch:` block to move it into; an unset verb floors to the compiled-in default
   (`work`/`close`/`resolve` float to the reconcile-core worker constants, `unblock`/`deconflict`/
   `repair` to the escalation constants, `handoff` to the harness's own default), so the board keeps
   moving on defaults while you migrate.
6. Let the selector assign the cell, then watch the first dispatch land — the wrapper owns the close-out and its commit carries the `Job-Id`/`Task` trailers.

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
