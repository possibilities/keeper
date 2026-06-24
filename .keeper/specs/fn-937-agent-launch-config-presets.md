## Overview

Standardize a named-preset format for `keeper agent` launch configuration: a
preset is a named `{harness, model, effort}` triple (plus optional `thinking`
for pi and an optional pair-only `role`) stored in a single registry file
`~/.config/agentwrap/presets.yaml`, resolved in ONE place (`keeper agent`), and
consumed uniformly by pairs (one preset each), panels (an ordered array of
presets), manual dispatch, and the server autopilot. Today five callsites pick
harness/model/effort five different ways — pair takes `--cli/--model/--effort`,
panel hardcodes `--cli` choices, dispatch takes flags, autopilot hardcodes
`sonnet`/`max`. This collapses them onto one resolver while keeping every legacy
flag working; presets are the recommended primary interface, never mandatory.

## Quick commands

- `keeper agent presets resolve default` — emits the resolved panel/preset JSON
- `keeper agent --agentwrap-preset claude-opus-xhigh '/some prompt'` — harnessless launch
- `keeper pair send q.md --preset codex-gpt55-high --output /tmp/r.yaml` — pair via preset
- `bun run test:full` — mandatory; touches launcher/daemon/worker + argv-pin tests

## Acceptance

- [ ] One registry file `~/.config/agentwrap/presets.yaml` read ONLY by the dep-free `src/agent/config.ts` family; the launcher import graph never reaches `src/db.ts` (guard test).
- [ ] Precedence holds per-field: explicit CLI arg > effort env > preset > per-harness yaml > native default; a partial preset layers over yaml rather than replacing it.
- [ ] All legacy flags (`--cli`/`--model`/`--effort`) keep working unchanged; with no preset passed there is ZERO behavior change.
- [ ] Pair binds one preset; panels iterate a `panels.<name>` array (two same-harness-different-model panelists expressible); autopilot's hardcoded model/effort becomes a `worker` preset that defaults to today's `sonnet`/`max`.
- [ ] Determinism untouched: presets are producer-side launch config, never a fold input; no RPC writes a preset; re-fold stays byte-identical.

## Early proof point

Task that proves the approach: task 1 (registry + launcher resolution). If the
cold-start import-graph guard or the per-field precedence can't be satisfied
inside the dep-free config island, the whole abstraction is wrong — recover by
keeping resolution in a standalone `src/agent/presets.ts` leaf that imports only
`node:*` and the existing `config.ts` helpers.

## References

- `cli/agent.ts:16-20` — the load-bearing cold-start invariant (launcher MUST NOT transitively pull `src/db.ts`).
- `src/agent/config.ts` — `parseYaml`/`expandUser`/`isFile`/`readMapping`/`ConfigError`; fail-open-on-missing-file / fail-loud-on-malformed posture to mirror.
- `src/agent/passthrough.ts` resolvers + the codex resolvers (which live in `main.ts`, NOT passthrough) — the preset feeds their default slot.
- Overlap: `fn-935` (agent opentui modal overlay) writes the same `src/agent/args.ts` / `main.ts` / `dispatch.ts` structures — wired as a hard dep to avoid concurrent edits.
- Prior art: AWS CLI profiles, dbt `profiles.yml`, codex `config.toml` named profiles (single-registry, fail-loud-on-missing-name, env-below-flag precedence).

## Docs gaps

- **README.md** (config section): document `~/.config/agentwrap/presets.yaml` + that the autopilot worker launch resolves a `worker` preset (task 1 / task 2).
- **plugins/plan/skills/panel/SKILL.md** + **references/panel.md** + **plugins/plan/agents/panel-judge.md**: replace the hardcoded `--cli claude`/`--cli codex` panelist form + "opus4.8-gpt5.5" labels with preset-driven wording + preset-name attribution (task 4).
- **plugins/keeper/skills/pair/SKILL.md** + **plugins/keeper/skills/dispatch/SKILL.md** + the `cli/pair.ts`/`cli/dispatch.ts`/`cli/agent.ts` usage strings: add `--preset` / `--agentwrap-preset` / `presets resolve` (tasks 1 + 3).

## Best practices

- **Fail loud + specific on preset-not-found:** name the file, the preset, and the available names — never silently fall back to a default when a NAMED preset is missing (makes typos invisible). [AWS CLI ProfileNotFound]
- **Env overrides only its own field, explicit flag wins, never error on coexistence:** warn-and-let-explicit-win when `--preset` meets `--model`/`--effort`. [yargs deprecateOption; AWS per-command override]
- **Reserve boolean-looking + subcommand names:** even though `Bun.YAML.parse` is YAML 1.2, reserve `yes/no/on/off/true/false/null/~` + `claude/codex/pi/wait-for-stop/show-last-message/default/help` since downstream re-parsers may use YAML 1.1. [philna.sh YAML-from-hell; yamllint #694]
- **Parse the registry once / per-dispatch, never watch it:** no kernel watcher on the config file; the daemon re-resolves per dispatch (cheap single-file parse) so edits land without a bounce.
