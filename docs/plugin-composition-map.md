# plugin composition map — what each launch channel loads

This note is the observed reality of the Claude Code plugin layer under keeper:
which plugins a session inherits, per launch channel, with file:line grounding.
**By default** no worker isolation is applied — every claude launch inherits the
same base set. A config-flagged worker sub-gate exists (`worker_plugin_isolation`,
default OFF); it is documented in [The worker isolation gate](#the-worker-isolation-gate-config-flagged-default-off)
below. A standing test (`test/plugin-composition-map.test.ts`) pins the seams and
BOTH gate states so this map cannot silently drift.

## The base set (every claude launch)

`keeper agent claude …` discovers plugins in `src/agent/main.ts` behind a single
gate — `if (agent === "claude")` (`src/agent/main.ts:2194`). By default there is
**no worker sub-gate**: any launch whose agent token is `claude` runs the full
discovery (the `worker_plugin_isolation` knob below can add one, OFF by default).

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

## Per launch channel

| Channel | Route | Base set | Extra |
| --- | --- | --- | --- |
| Interactive (human) | your launcher points `plugin_scan_dirs` at `~/code/keeper/plugins` (README "Load the plugins") | full plugins.yaml | — |
| `keeper agent` manual dispatch / pair | `keeper agent claude …` → `src/agent/main.ts:2417` gate | full plugins.yaml | — |
| Autopilot / dispatch worker | `buildKeeperAgentLaunchArgv` emits `keeper agent claude …` (`src/exec-backend.ts:952`); same gate | **full plugins.yaml** | per-cell `--plugin-dir <cell>` (`exec-backend.ts:968-974`), **additive** |

Both work-launch producers — the autopilot reconciler (`src/autopilot-worker.ts`
`runReconcileCycle`) and the manual `keeper dispatch work::<id>` (`cli/dispatch.ts`)
— resolve the launch's per-cell `work` plugin through ONE shared seam,
`resolveWorkerCell` (`src/worker-cell.ts`): it applies the same
out-of-matrix → missing-manifest → shadowed-plugin precedence and returns a closed
machine-kind union. Each caller owns its own failure surface — autopilot mints a
sticky `DispatchFailed`, dispatch exits non-zero with an actionable error — but the
decision is identical, so a hand-fired plan worker loads the byte-same cell an
automated one does. The producer injects a per-cycle memoized shadow probe; dispatch
injects a fresh scan (it fires one worker).

The per-cell worker manifest (`plugins/plan/workers/<model>-<effort>/`, rendered from
`subagents.yaml`) is appended via `--plugin-dir` AFTER `--name`
(`exec-backend.ts:968-974`). It is **additive, not isolating**: the worker still
inherits everything above. Stripping that one `--plugin-dir <cell>` pair from a
worker argv recovers the byte-identical interactive argv — pinned by the additive
test.

A manual `keeper dispatch work::<id>` while the board runs **worktree mode** ON is
refused (exit 1) instead of launching worktree-less into the shared checkout —
autopilot provisions each task's lane, so a hand-fired shared-checkout worker is
wrong-topology. The refusal names both recoveries (let autopilot dispatch it, or
`--force` to launch in the shared checkout deliberately) and fails OPEN when the
daemon is unreachable; `close::` / resume / free-form launches are untouched.

A sibling plan-plugin config surface, `plugins/plan/model-selector.yaml` (the
post-scaffold model+effort selector's policy config), is read off disk by
`keeper plan selection-brief` during the select beat — never compiled in, never a
`--plugin-dir` — so it rides no launch channel and is noted
here only to keep the plan plugin's config-surface inventory complete alongside
`subagents.yaml`.

The daemon's own **merge-resolver dispatch** (`resolve::<epic>`, launched by the
resolver-dispatch sweep on a stuck worktree fan-in close) rides this SAME
`buildKeeperAgentLaunchArgv` path — it is another launch producer of the
autopilot/dispatch-worker channel, inheriting the identical additive base set, never a
separate isolation channel.

Two further daemon producers ride the same path: the **escalation dispatches** —
`unblock::<task>` (the block-escalation sweep) and `deconflict::<epic>` (the
merge-escalation sweep, sequenced behind the tier-1 `resolve::` resolver). Both inherit
the identical additive base set plus their target `/plan:unblock` or `/plan:deconflict`
skill. What sets them apart is the launch config, not the plugin channel: their
`{model, effort}` comes from a SEPARATE `escalation` preset
(`resolveEscalationLaunchConfig`, `src/escalation-config.ts`) — the `escalation` key in
`presets.yaml` layered per-field over the `ESCALATION_*` constants, DELIBERATELY
independent of the `worker` preset so an escalation session's tier moves without
perturbing plan workers. Claude-only; a missing or malformed catalog swallows to the
built-in escalation defaults, never a launch failure.

## The worker isolation gate (config-flagged, default OFF)

The `worker_plugin_isolation` key in `~/.config/keeper/plugins.yaml` (parsed by
`loadPluginSources`, `src/agent/config.ts`) is the sole worker sub-gate. It is a
string, not a boolean (the config corpus is boolean-free):

- **absent / `off`** (the default) — no isolation. Every launch inherits the full
  base set above. The launcher argv is byte-identical to a machine that never set
  the key.
- **`strip-scan-dirs`** — a keeper-automated **worker** launch drops the
  `plugin_scan_dirs` RESULTS from its argv, loading only the hard-listed
  `plugin_dirs` (keeper + plan) plus its additive per-cell `--plugin-dir`.

The seam (`src/agent/main.ts`, the `agent === "claude"` discovery gate) resolves
the knob against worker-ness and passes the decision to `discoverPlugins` as
`stripScanDirs`; discovery obeys the resolved decision.

**The boundary (load-bearing):** the gate strips only `plugin_scan_dirs` RESULTS —
best-effort third-party scans. It NEVER strips a `plugin_dirs` entry a machine
explicitly hard-lists (those are hard deps, keeper + plan among them), and NEVER
touches the cwd `--plugin-dir .` detection.

**What counts as a worker:** a launch carrying `--dangerously-skip-permissions` —
keeper's own human-less worker permission posture (`src/exec-backend.ts`
`buildKeeperAgentLaunchArgv`; the pair partner in `launch-config.ts`
`nativeClaudeArgs` carries it too). An interactive human session never carries the
flag, so it is never gated — "interactive unaffected" holds by construction.

`test/plugin-composition-map.test.ts` pins BOTH states: OFF is byte-identical to
today (scan set intact), ON strips only the scanned child while keeper + plan
survive, and the worker argv always carries the `--dangerously-skip-permissions`
marker the seam keys on.

**Opt-in + proof.** arthack is an optional plugin: a fresh machine's default
`plugins.yaml` is keeper-only, and you opt a third-party set in by appending its
parent to `plugin_scan_dirs`. Enable worker isolation from that set with
`worker_plugin_isolation: strip-scan-dirs`. `bun scripts/clean-machine-check.ts`
proves the whole fresh-machine path end to end — the installer default is
arthack-free, prompt renders resolve from the in-repo vendored corpus, the worker
argv carries the permission posture, and a gate-ON worker resolves no arthack
checkout while an interactive launch is unaffected.

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
