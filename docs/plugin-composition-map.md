# plugin composition map — what each launch channel loads

This note is the observed reality of the Claude Code plugin layer under keeper:
which plugins a session inherits, per launch channel, with file:line grounding.
It is **observe-only** — no gate or isolation is asserted here; the isolation
decision belongs to the worker-plugin dissolution study. A standing test
(`test/plugin-composition-map.test.ts`) pins the two seams below so this map
cannot silently drift.

## The base set (every claude launch)

`keeper agent claude …` discovers plugins in `src/agent/main.ts` behind a single
gate — `if (agent === "claude")` (`src/agent/main.ts:2194`). There is **no worker
sub-gate**: any launch whose agent token is `claude` runs the full discovery.

Discovery (`src/agent/plugins.ts` `discoverPlugins`) composes, from
`~/.config/keeper/plugins.yaml` (parsed by `loadPluginSources`,
`src/agent/config.ts:114`):

- **cwd `--plugin-dir .`** when the cwd is itself a plugin (`plugins.ts:70-75`).
- **`plugin_dirs`** — hard deps, fail-loud on a missing manifest
  (`plugins.ts:78-90`): `~/code/keeper/plugins/keeper`, `~/code/keeper/plugins/plan`.
- **`plugin_scan_dirs`** — best-effort parents whose manifest-bearing children are
  each added (`plugins.ts:93-110`): `~/code/arthack/apps`, `~/code/arthack/claude`.
  The manifest-bearing children today are `arthack`, `internal`, `lsp` (under
  `~/code/arthack/claude`).

So every claude session — interactive OR worker — inherits keeper + plan + the
arthack third-party set. The **arthack** plugin
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

## Per launch channel

| Channel | Route | Base set | Extra |
| --- | --- | --- | --- |
| Interactive (human) | your launcher points `plugin_scan_dirs` at `~/code/keeper/plugins` (README "Load the plugins") | full plugins.yaml | — |
| `keeper agent` manual dispatch / pair | `keeper agent claude …` → `agent/main.ts:2194` gate | full plugins.yaml | — |
| Autopilot / dispatch worker | `buildKeeperAgentLaunchArgv` emits `keeper agent claude …` (`src/exec-backend.ts:854`); same gate | **full plugins.yaml** | per-cell `--plugin-dir <cell>` (`exec-backend.ts:874-876`), **additive** |

The per-cell worker manifest (`plugins/plan/workers/opus-*/`, rendered from
`subagents.yaml`) is appended via `--plugin-dir` AFTER `--name`
(`exec-backend.ts:870-876`). It is **additive, not isolating**: the worker still
inherits everything above. Stripping that one `--plugin-dir <cell>` pair from a
worker argv recovers the byte-identical interactive argv — pinned by the additive
test.

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
