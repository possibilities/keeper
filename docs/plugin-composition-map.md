# plugin composition map — what each launch channel loads

This note maps the Claude Code plugin layer under keeper by launch channel.
Work launches add one compiler-owned worker cell; their `plugin_scan_dirs`
composition follows the config-gated worker isolation setting. The Claude worker
cohort is separate from Pi's static prompt-artifact cohort.

## The base set

`keeper agent claude …` discovers configured plugins. Automated work launches
use the same discovery unless their worker-isolation setting removes scan results.

Discovery (`src/agent/plugins.ts` `discoverPlugins`) composes, from
`~/.config/keeper/plugins.yaml` (parsed by `loadPluginSources`,
`src/agent/config.ts:114`):

- **cwd `--plugin-dir .`** when the cwd is itself a plugin (`plugins.ts:70-75`).
- **`plugin_dirs`** — hard deps, fail-loud on a missing manifest
  (`plugins.ts:78-90`): `~/code/keeper/plugins/keeper`, `~/code/keeper/plugins/plan`.
- **`plugin_scan_dirs`** (optional, opt-in) — best-effort parents whose
  manifest-bearing children are each added (`plugins.ts:93-110`). The
  `install.sh`-written default carries NONE (keeper-only, no third-party sources); a
  machine opts a set in by appending its parent — e.g. arthack via
  `~/code/arthack/apps`, `~/code/arthack/claude`, whose manifest-bearing children are
  `arthack`, `internal`, `lsp`, `matt`.

So a fresh machine inherits keeper + plan only; a machine that has opted arthack in
inherits keeper + plan + the scanned arthack third-party set (see the gate below to
isolate workers from it). The **arthack** plugin
(`~/code/arthack/claude/arthack/hooks/hooks.json`) is the notable one: a
four-dispatcher hook set —

- **PreToolUse** (`*`): one bun dispatcher fanning eight sub-hooks — `auto_approve`
  (a blanket `permissionDecision: allow`, excluding only `AskUserQuestion` /
  `ExitPlanMode`), `command_redirect` (rewrites `python`/`python3`/`pytest`/`ruff`/`ty`
  → `uv run …`, `pip`→`uv add`, `npm`→`pnpm`; denies some), `tool_redirect`,
  `path_guard`, `rewrite_agent_browser`, `rewrite_llm`, `rewrite_tmux`,
  `tool_reminder`. Exactly one `updatedInput` survives; rewrites chain.
- **PostToolUse** (Write/Bash): stylua/zig-fmt + command advice.
- **UserPromptSubmit**: prompt reminders.
- **PermissionRequest** (ExitPlanMode): empty-plan guard.

The **keeper** plugin (`plugins/keeper/hooks/hooks.json`) also rides every launch;
its full hook inventory lives in `CLAUDE.md`'s Hook rules. On **SessionStart** it
fires two commands — the events-writer (folds the session-start row) and a
fail-open **context-hint** that emits one `additionalContext` line pointing a
vanilla session at the repo root's `CONTEXT.md` glossary when present + non-empty
(nothing when absent/empty/unreadable or the cwd is non-git; always exits 0).
`plugins/keeper/settings.json` is the sibling statusLine config surface; `keeper
agent` passes it as `--settings` on Claude launches that do not already supply
`--settings`, so the visible line and telemetry capture both flow through
`keeper statusline`.

## Per launch channel

| Channel | Route | Base set | Extra |
| --- | --- | --- | --- |
| Interactive (human) | configured Claude launcher | configured plugins | — |
| `keeper agent` manual dispatch / pair | `keeper agent claude …` | configured plugins | — |
| Autopilot / manual work dispatch | shared work-launch seam | configured plugins; scan results remain with an absent or `off` gate, or are stripped with `strip-scan-dirs` | exact verified cell via additive `--plugin-dir <cell>` |

Both work-launch producers — the autopilot reconciler and manual `keeper
dispatch work::<id>` — use one shared resolution seam. Its precedence is
**bad matrix → provider constraint reject → out-of-matrix → missing manifest →
stale or unverified cohort → exact-cell shadow → launch**. Each caller owns its
failure surface, but both make the same decision: autopilot mints a
`DispatchFailed` sticky and manual dispatch exits non-zero. An absent selected
manifest is `worker-cell-missing`; a present manifest with invalid compiler
fingerprint, inventory, hashes, or selected membership is `worker-cell-stale`.
Regenerate either with:
`keeper prompt compile --role work:worker --target claude`.

The compiler publishes the complete matrix-derived shared cohort under
`plugins/plan/workers/<model>-<effort>/`. It snapshots the literal include
graph; fingerprints the catalog, matrix, and all sources; owns nested files,
JSON sidecars, and manifest; safely adopts valid managed output; prunes owned
orphans; and atomically verifies artifacts before writing the manifest last.
`--check` verifies that state without writing. `render-plugin-templates` skips
worker writes and delegates once to this compiler; install and promote retain
that front door, and promotion verifies compiler state.

Before launch, the shared seam read-only verifies the compiler fingerprint,
inventory, hashes, and selected membership. The exact physical selected cell is
the only legitimate preloaded `work` plugin. A `work` plugin discovered from
configuration or cwd is a shadow, not an equivalent substitute. The selected
cell is appended by `--plugin-dir`, so it remains additive to the configured
plugin set. Runtime shadow inventory mirrors the resolved isolation setting.

A task's `{model, tier}` and any producer-side provider constraint select the
runtime cell; no task-specific prompt artifact exists. A native cell launches
its exact Claude route. A **wrapped cell** retains its assigned and effective
capability but runs the fixed wrapper driver at `maxTurns: 160`; native cells
use `maxTurns: 300`. The compiler does not adapt provider equivalence. The wrapper is a
dumb courier: it delegates implementation, tests, and lint iteration to the
resolved provider leg through `keeper agent run`/`--resume`, never edits source,
and owns test adjudication and keeper close-out (`commit-work` plus `plan
done`). Provider legs use the shared `wrapped` tmux session; their task-ID title
is display metadata, while run handles and harness resume targets own waiting
and continuation. The launch boundary always emits
`KEEPER_WRAPPED_CELL`/`KEEPER_WRAPPED_ENVELOPE` (empty for native cells). A
non-empty marker plus subagent identity is the sole jurisdiction for the
`wrapped-guard` total source-edit denial. The guard descriptor-creates fresh
inert handoffs in private temp directories, constrains provider launches to the
launch-bound non-Claude leg, binds `plan done`/`commit-work` to the launch task,
and denies repository scripts/tests plus raw index/ref Git. Read-only Git runs
only in helper-disabled forms; close-out passes the Git-derived versioned path
manifest to invocation-local `commit-work --adopt-from`, retaining exact
byte/mode, hook, signing, and CAS protections
([ADR 0050](./adr/0050-wrapped-delegation-guard.md)).
The required host matrix ([ADR 0036](./adr/0036-required-host-matrix-v2-with-launch-id-entries.md))
remains the composition input for every worker cell.

Static plan agents are a separate prompt-artifact surface. Their canonical identities — each
`plan:<role>` and the named bundles that collect them — live in
`plugins/plan/prompt-artifacts.yaml`; `plan:static` is precisely the static-role bundle and
excludes the cell-bound `work:worker`. `keeper prompt compile --bundle plan:static --target pi`
adapts those canonical templates directly for Pi, preserving the prompt body and translating
only launch metadata. It resolves each role's exact `agent_pins` assignment. An assigned Opus
cell that Pi does not serve is translated only through an explicit provider-equivalence entry
to one exact Pi model ID and effort; there is no parent-model, fuzzy, or implicit-provider
fallback. The compiler publishes and fingerprints the static artifact set, whereas runtime
per-task worker-cell selection still derives from the matrix and produces the native or wrapped
cell manifest.

Before a Pi Task launch, the facade preflights the compiler and its absolute CLI paths, then
compiles the requested canonical role for that Task. It binds only the exact `(provider, model
ID)` object present both in Pi's registry lookup and available-model list; a missing route,
compiled role, or exact registry binding fails loudly. The static compiler therefore never
turns a runtime work-worker assignment into a generic Pi agent.

A manual `keeper dispatch work::<id>` while the board runs **worktree mode** ON is
refused (exit 1) instead of launching worktree-less into the shared checkout —
autopilot provisions each task's lane, so a hand-fired shared-checkout worker is
wrong-topology. The refusal names both recoveries (let autopilot dispatch it, or
`--force` to launch in the shared checkout deliberately) and fails OPEN when the
daemon is unreachable; `close::` / resume / free-form launches are untouched.

Sibling plan-plugin config surfaces ride no launch channel:
`plugins/plan/model-selector.yaml` is the post-scaffold model+effort selector policy read
by `keeper plan selection-brief`, while `plugins/plan/panel-selector.yaml` is the
committed described panel roster owned and structurally gated by `/plan:panel-guidance`
(`bun plugins/plan/scripts/panel-guidance-check.ts --check`). The skill installs that
roster byte-for-byte as `~/.config/keeper/panel.yaml`; `keeper agent presets list --json`
exposes each panel's members, authored strength, and description. Neither file is compiled
or a `--plugin-dir`; this inventory keeps both alongside the host `matrix.yaml`.

The daemon's own **merge-resolver dispatch** (`resolve::<epic>`, launched by the
resolver-dispatch sweep on a stuck worktree fan-in close) rides this SAME
`buildKeeperAgentLaunchArgv` path — it is another launch producer of the
autopilot/dispatch-worker channel, inheriting the identical additive base set, never a
separate isolation channel.

Three further daemon producers ride the same path: the **escalation dispatches** —
`unblock::<task>` (the block-escalation sweep), `deconflict::<epic>` (the
merge-escalation sweep, sequenced behind the tier-1 `resolve::` resolver), and
`repair::<repo_token>` (the SAME block-escalation sweep, routing a `SHARED_BASE_BROKEN`
category to one write-capable session per (repo, fingerprint) instead of the task's own
unblock). All three inherit the identical additive base set plus their target
`/plan:unblock`, `/plan:deconflict`, or `/plan:repair` skill. What sets them apart is the
launch config, not the plugin channel: every dispatched verb — `work`, `close`, `resolve`,
`unblock`, `deconflict`, `repair`, `handoff` — resolves its `{model, effort}` through the
ONE `resolveDispatchLaunchConfig` leaf (`src/dispatch-launch-config.ts`) reading the
per-verb `dispatch:` table in `presets.yaml` (a `<harness>::<model>::<effort>` triple per
row), floored to the compiled-in reconcile-core constants when a row is absent or the
catalog fails to parse: `work`/`close`/`resolve` float to the worker constants,
`unblock`/`deconflict`/`repair` to the escalation constants, `handoff` to the harness's own
default. The escalation rows stay independently tunable from the work/close/resolve rows —
retuning one verb's tier is one `dispatch:` line, never a perturbation of the others.
Claude-only; a non-claude triple resolves its model/effort but warns once per (verb,
harness) rather than launching a foreign harness. Every escalation session is additionally
constrained by the keeper plugin's sixth hook, escalation-guard (`PreToolUse(Bash)`), which
is role-keyed on the launch-injected `KEEPER_ESCALATION_ROLE` marker to a per-role Bash
command-family allowlist — unblock and resolve stay diagnosis-only, deconflict and repair
get write-capable families — failing CLOSED for a marked session regardless of
`--dangerously-skip-permissions`.

## Worker isolation gate

`worker_plugin_isolation` controls automated work-launch scan results:

- **absent / `off`** (the default) retains `plugin_scan_dirs` results.
- **`strip-scan-dirs`** removes only `plugin_scan_dirs` results. Hard
  `plugin_dirs` and cwd detection remain.

The runtime shadow inventory follows the same resolved gate. Cwd and configured
plugin siblings are still examined for `work` identity, so a shadow is refused
rather than silently loaded. Interactive, pair, close, and other non-work
launches retain ordinary configured discovery.

## Logged-vs-executed skew (read this before mining events)

The events-writer hook logs the **original** tool payload it receives on stdin
(`plugins/keeper/plugin/hooks/events-writer.ts:829-830` reads raw stdin;
`:802` binds `data: raw`). arthack's PreToolUse dispatcher runs independently and
returns an `updatedInput` that changes **what actually executes** — e.g. a typed
`python3 …` executes as `uv run python3 …`, `npm …` as `pnpm …`. Claude Code
hands each hook the ORIGINAL input, so the row keeper stores is the typed command,
not the rewritten one that ran.

**Consequence for forensics:** a Bash `events.data` row is the command as typed,
NOT as executed. Do not read a stored `python3`/`npm`/`pip` command as the process
that ran — cross-reference the arthack rewrite table above. The `updatedInput` and
the blanket `auto_approve` allow are surfaced live in the session as
`PreToolUse:Bash` additional-context lines (`arthack:auto_approve`,
`Rewrote 'python3' → 'uv run python3'`), which is the attributable signal that the
arthack hook layer is active on a given launch — including autopilot workers.

## lint_failed spike forensics (2026-07-02)

The reviewed "spike" — ~125–146 `lint_failed` mentions on 2026-07-02 vs a 5–18/day
baseline — is a **measurement artifact, not a lint regression**. Evidence, mined
read-only from `~/.local/state/keeper/keeper.db` (`events`, 787k rows):

- **The events stream captures ZERO genuine commit-work `lint_failed` envelopes.**
  No row carries `"error":"lint_failed"` or the envelope's `"linter"` field (0 of
  787k). `keeper commit-work`'s failure envelope goes to the agent terminal, never
  into a captured `tool_response` row. So ANY `lint_failed` count over `events.data`
  is a substring proxy, matching the token wherever it appears — prompts, task
  specs, briefs, plan snapshots, claims, commit messages, session titles.
- **The 2026-07-02 count is self-referential contamination.** 146 mentions that
  day, of which 89 (61%) co-occur with `fn-1062` or `fn-1075` — two board epics
  literally scoped around commit-work lint failures (`fn-1062-close-commit-work-lint-failed-bypass`,
  `fn-1075-autopilot-telemetry-and-machine`, whose own spec runs this forensics).
  The epic SLUGS alone inject `commit-work` + `lint-failed` into every claim,
  snapshot, and commit that names them.
- **Every baseline day has ZERO meta-epic co-occurrence** (2026-06-05: 18 mentions,
  0 meta; 2026-07-01: 13/0; 2026-06-09: 13/0). Baselines approximate ambient
  mentions; the spike day is dominated by two epics about the token itself.
- This very investigation compounds it: its own SQL and this doc contain
  `lint_failed`, and the queries are logged as `PostToolUse:Bash` rows — the
  observer contaminates the measurement.

**Root cause:** the forensic signal is unreliable by construction (commit-work's
`lint_failed` outcome is not event-sourced), and a naive `LIKE '%lint_failed%'`
census counts self-referential board work. **No lint config/rule fix applies** —
there is no genuine lint regression to repair. Per the task's "fix if trivial,
else file" contract, this is filed, not fixed. If a real lint-failure rate is ever
needed, it must come from a captured commit-work outcome signal (the envelope is
not currently persisted), not from string-matching `events.data`.
