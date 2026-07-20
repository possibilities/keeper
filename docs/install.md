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
path differ. The daemon runtime is pinned: install the exact version named by `package.json`'s
`engines.bun` via the official installer (`curl -fsSL https://bun.sh/install | bash -s "bun-v<version>"`,
landing at `~/.bun/bin/bun` — the path the plist references); the plist must be
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

### Claude account routing and Fable focus

Claude launches require [claude-swap](https://github.com/realiti4/claude-swap). Every installer run executes
`uv tool install --upgrade claude-swap`; a missing `uv` or failed transaction is nonfatal to Keeper's
non-Claude surfaces, but Claude remains unavailable until `cswap` works and at least one account is
registered.

The daemon publishes one private, freshness-bounded Capacity observation from `cswap list --json`. A
route must have fresh `usageStatus: ok` data plus remaining session and weekly quota; Fable work also
requires remaining Fable quota. Unknown, stale, malformed, signed-out, exhausted, or otherwise unusable
routes are excluded rather than treated as spare capacity. A successful managed launch always runs through
`cswap run <slot> --share-history -- <claude arguments...>`; missing or stale inventory and zero eligible
routes fail before Claude starts.

#### Routing model

An **Account route** is the PII-free stable identity `claude-swap:<slot>`. Persist and operate on that
route, not on a display ordinal: `cN` is only the current zero-based inventory label shown by Claude and
can name a different Account route after inventory changes. An explicit per-launch `--x-account` request
uses that display label and takes precedence for that one process; it never changes Fable focus.

Every fresh, resumed, restored, or forked Claude process is selected independently from current eligible
routes. Without an effective Fable focus, normal balancing selects the route from current quota pressure,
Fable availability, recency, and short-lived Launch reservations. Launch attribution records the selected
Account route for that process only; it never creates account affinity for later work.

**Fable focus** is one optional durable preference for a stable Account route. For Fable work, an eligible
focus target wins after normal eligibility filtering. If that target cannot serve the launch, Keeper reports
`fallback` and uses normal eligible-route balancing; focus never makes an ineligible route viable. For
non-Fable Claude work, the target is soft-avoided whenever another route is eligible, but remains eligible
as the sole route. This preserves availability while reserving the target's Fable capacity when possible.

**Fable intent** is process-lineage routing metadata, not Launch attribution. An explicit effective model
sets or overrides it; a continuation, resume, restore, or fork inherits it when no explicit override is
present. An interactive model change cannot move an already-running process to another Account route.

A focus lifetime is one of:

- `permanent`, effective until replacement or clear;
- `absolute`, effective strictly before its timezone-bearing UTC deadline;
- `current-reset`, which snapshots the selected route's fresh `model:Fable` reset boundary as an absolute
  deadline; or
- `cycle-end`, which completes when that same reset boundary passes or a fresh target observation proves
  full Fable utilization.

#### Inspect routing state

Use the read-only account check for Capacity observation health, candidate Account routes, and the
ordinary route choice; it records no Launch reservation. Use the focus view for durable policy, effective
state, target, lifetime, fallback, and delivery diagnostic. Both are PII-free.

```sh
keeper agent accounts check --json
keeper agent accounts fable-focus show --json
keeper status --json
keeper board
```

`keeper status --json` includes `data.fable_focus`. `keeper board` presents the same effective Fable focus
state in its semantic header, including the target, lifetime, and focused or fallback outcome; its snapshot
and copied diagnostics retain that header.

#### Activate, verify, and clear Fable focus

Use a stable Account route from a fresh inspection. For a guarded current-reset activation, set the
expected value to the fresh target `model:Fable` reset boundary in timezone-bearing UTC; the placeholders
below are values to substitute, not account identities or a rollout schedule.

```sh
route='claude-swap:<stable-slot>'
expected_reset='<fresh-model-Fable-reset-in-UTC>'
keeper agent accounts fable-focus set "$route" current-reset \
  --expect-reset "$expected_reset" --json
keeper agent accounts fable-focus show --json
```

The command atomically snapshots the observed boundary before setting policy. An expected-boundary
mismatch, stale or missing reset evidence, or an already elapsed boundary is a refusal: it leaves the
existing policy unchanged and never advances the focus into a later reset cycle. Re-read `show` after any
refusal or uncertain acknowledgement before choosing another action.

Other durable lifetimes use the same stable route form:

```sh
keeper agent accounts fable-focus set 'claude-swap:<stable-slot>' permanent --json
keeper agent accounts fable-focus set 'claude-swap:<stable-slot>' absolute '<timezone-bearing-UTC-deadline>' --json
keeper agent accounts fable-focus set 'claude-swap:<stable-slot>' cycle-end --json
```

Clear is the rollback and is idempotent when the policy is already off. It also repairs an unavailable
delivery view by publishing the durable clear; if its acknowledgement is uncertain, inspect before
repeating it.

```sh
keeper agent accounts fable-focus clear --json
keeper agent accounts fable-focus show --json
```

Claude `settings.json` is seeded at install time from the Keeper stow source only when the live file is
absent. After that seed, the local file is canonical and claude-swap shares it into managed sessions.

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

### Pi Codex account pool

The installer verifies the repository-owned `integrations/pi-codex-pool` manifest and source contract but
never adds it to Pi's global package list. A configured `keeper agent pi` launch passes the tracked
node-only Keeper extension and the Codex companion as two separate `-e` sources. Pi metadata and package
commands take their native passthrough path, and Pi started outside Keeper receives neither source nor
pool environment. The loaded pi-subagents checkout stays on the fork's live integration lineage; upstream
proposal branches belong in separate checkouts and never replace that loaded tree.

The installer also links the package's `keeper-pi-codex-observe` executable onto PATH (`bun link` against
`integrations/pi-codex-pool`, the same mechanism it uses for the `keeper` CLI itself), so a Keeper-marked
environment can produce a fresh routing observation. A durable `KEEPER_PI_CODEX_OBSERVER_BIN` override
skips the link and is used verbatim instead.

The companion affects only `openai-codex`. Non-Codex providers keep Pi's native path. Root and inherited
pi-subagents child requests share the Provider wrapper but select independently by session id. A session
keeps its healthy opaque alias. One logical Provider call may move to one different alias only after a
classified quota, rate, authentication, or transport failure **before** Substantive output. Text,
thinking, tool calls, and unknown stream events close that retry window.

Activation is intentionally pending until the separate live two-account proof is complete. Pending,
missing, incompatible, stale, interrupted, or unhealthy machinery uses Pi's native `openai-codex`
credential and emits the fixed warning
`[keeper-codex-pool] pool-unavailable; using native openai-codex`; it never claims a balanced route.
The launch environment carries only a bounded mode and proof-window state, opaque aliases, an optional
opaque initial route candidate for Codex work, revision and configuration bindings, and a bounded reason
code. OAuth credentials remain in Pi's private `auth.json`; account ids, provider
headers, raw errors, tokens, plan labels, and account PII do not enter Keeper diagnostics, proof reports,
launch environments, the daemon database, or a Projection.

Inspect Claude launch-routing and Codex session-routing together. This read does not create a Claude
Launch reservation or Codex pressure:

```sh
keeper agent accounts check --json
keeper agent accounts codex-pool status --json
```

Make the transition promptly and in this order: **enroll both aliases → expect the native Codex outage →
arm a proof window → prove → activate**.

Enroll each configured opaque alias in a real terminal. The command starts an inherited-stdio Pi with the
companion loaded and tells the operator which `/login <alias>` command to run; it rejects JSON/captured
enrollment. Alias names must match the configured `keeper-codex-*` set and contain no identity. The host
default is `keeper-codex-a` plus `keeper-codex-b`; an operator may set
`KEEPER_PI_CODEX_POOL_ALIASES` to a JSON array of one through eight opaque aliases before every workflow
and launch command.

```sh
keeper agent accounts codex-pool enroll keeper-codex-a
keeper agent accounts codex-pool enroll keeper-codex-b
```

Enrollment revokes that account's other live grants, including the legacy leg and bare Pi. Expect native
Codex on those surfaces to remain unavailable until activation.

Arm one proof window and run the managed Pi proof probe. The probe directs Pi to invoke the
`codex_pool_proof` tool exactly once; the tool runs the bounded proof and atomically writes its private
report to `~/.config/keeper/codex-pool/live-proof.json` before the window closes:

```sh
keeper agent run pi --x-codex-pool-proof-window=arm \
  'Call the codex_pool_proof tool exactly once and return its JSON result.'
```

Stage and classify that exact report, then activate promptly. Unknown fields, sanitation findings, stale
revision/configuration/alias bindings, interruption, incomplete root/child routes, or incomplete restoration
cannot pass:

```sh
keeper agent accounts codex-pool proof capture \
  ~/.config/keeper/codex-pool/live-proof.json --json
keeper agent accounts codex-pool proof verdict --json
keeper agent accounts codex-pool activate --json
keeper agent accounts codex-pool verify --json
```

Activation uses a host-local advisory lock and a private transaction marker. The marker makes native mode
authoritative throughout reload and verification; the active state publishes atomically only after the
fresh report still matches the current code revision, configuration, alias roles, companion contract, and
healthy Capacity observation. A concurrent activation is refused. Reload or immediate verification
failure returns `rollback-complete`; an interrupted or unwritable rollback leaves `recovery-required`,
which also forces native mode.

Rollback and recovery are idempotent and require no credential edits:

```sh
keeper agent accounts codex-pool rollback --json
keeper agent accounts codex-pool status --json
keeper agent accounts codex-pool recover --json   # only for recovery-required
keeper agent accounts codex-pool verify --json
```

Removing the companion `-e` source or leaving activation native also restores ordinary Codex behavior.
Runtime pool failures after a successful activation remain visible native fallbacks; they do not alter the
fail-closed proof gate.

### Degraded single-alias activation (human-authorized)

When one enrolled account is quota-depleted, the full proof cannot pass: `transport_isolation` and
`native_fallback` structurally require the second alias to serve, and a quota-dead account refuses those
legs. That is precisely the state where pooling's value is routing to the healthy alias. A proof run whose
**only** unmet clauses are those two — with the interruption classified as a quota fault and a route
recording a genuine quota failure — classifies `proven-degraded-single-alias`, recording exactly which
clauses were waived and the cause. Any other unmet clause makes the run genuinely incomplete, never
degraded.

Enroll the **surviving** account as the primary alias (the first entry in `KEEPER_PI_CODEX_POOL_ALIASES`,
`keeper-codex-a` by default) and the quota-dead account as the alternate; degraded activation pins routing
to the primary and immediate verification refuses any other pin. Degraded activation is never implicit — it
requires the explicit flag naming the degraded verdict, and without it a degraded report is refused with
`proof-degraded-unauthorized`:

```sh
keeper agent accounts codex-pool proof verdict --json   # proven-degraded-single-alias
keeper agent accounts codex-pool activate \
  --authorize-degraded=proven-degraded-single-alias --json
keeper agent accounts codex-pool status --json          # state=active-degraded
keeper agent accounts check                             # activation=active-degraded, DEGRADED single-alias
```

The active pool routes only through the pinned healthy alias and surfaces `active-degraded` loudly in
`status` and `accounts check`; it never presents balanced operation. When the quota recovers, run a fresh
**full** proof and activate normally — a genuine `proven` report upgrades the pool to full `active` and
clears the degraded marker. A partial or still-degraded report never upgrades.

```sh
keeper agent accounts codex-pool activate --json        # full proven → active, degraded marker cleared
```

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

### Pi shorthand and skill discovery

Every keeper-launched Pi session gets `/hack` and `/plan` as native shorthand for
`/skill:hack` and `/skill:plan`: an `input` handler rewrites only a leading complete
`/hack` or `/plan` token, preserving the rest of the line, and hands the rewritten text
back to Pi's own skill expansion pipeline — never an extension command, which would
bypass it. A `resources_discover` handler contributes exactly Keeper's two canonical
skill directories, resolved from the extension module itself rather than the launch cwd,
so an edit to either skill body is visible without a reinstall or global link. The short
aliases also surface in slash-command autocomplete ahead of any same-prefix match,
without depending on a pre-discovery command snapshot.

Both registrations are launch-scoped (`KEEPER_JOB_ID`-gated) and independently fail-open:
a resource-discovery or autocomplete failure degrades only its own surface, never Task,
Monitor, Agent Bus, event logging, footer, rename, or commit-work behavior. Standalone Pi
sessions and same-name ambient skills are out of scope — Pi's own discovery and collision
behavior applies; see
[ADR 0091](./adr/0091-keeper-owned-pi-shorthands-and-skill-discovery.md). Verify the
in-process contract (no real Pi subprocess, no ambient `~/.pi` state) with:

```sh
bun test test/pi-skill-autocomplete.test.ts
bun test test/pi-extension.test.ts
```

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

Claude sessions use Claude Code's built-in `/rename`, including its native bare-title inference
and explicit-name syntax. Keeper does not shadow that command or launch a second Claude process for
naming.

Keeper-launched Pi sessions load Keeper's custom `/rename`. Bare `/rename` derives a short Session
title from bounded, compaction-aware conversation context, gives extra weight to human requests,
and safely expands eligible project-file references. A canonical lowercase slug sets the title
directly (`/rename project-search-ranking`); any other argument, including an `@path`, leaves the
existing title unchanged. Empty context, cancellation, stale Session state, unavailable auth or
model, timeout, or malformed output likewise fails open with content-free feedback. Pi performs its
fixed cheap inference through its OAuth-aware host API and commits with `setSessionName()`.

Claude's native `custom-title` records and Pi's `session_info_changed` title bridge feed Keeper's
`TranscriptTitle` events, title projection, and Tmux renamer asynchronously, never a direct database
or Tmux write.

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
   `~/.config/keeper/presets.yaml` from the triples `presets list` discovered. `dispatch.handoff`
   chooses the default Handoff harness, model, and effort independently of result capture; an explicit
   Launch triple replaces all three, while an explicit model/effort pair keeps that harness. The
   `config.yaml` key `handoff_prompt_prefix` may be omitted; `/hack` is its only accepted compatibility
   value and does not alter prompt composition. Remove any other value or set it to `/hack` when Keeper
   reports the configuration fault. The panel roster is installed only through `/plan:panel-guidance`;
   its `default` pointer and described panel objects travel together in the committed copy.
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
