## Overview

Make the keeper CLI surface consistent and introspectable across its two ecosystems (native `cli/` leaves and the plan/prompt plugin CLIs). Help becomes pure everywhere (never executes a verb, never writes), every leaf gains real `--help`, and one pure-data descriptor module per CLI (ADR 0008) feeds usage text, leaf help, `keeper --help --json`, and completions so they cannot drift. A hard-cutover convergence wave then unifies the flag grammar: `--format json|yaml|human`, unit-required `<duration>` flags, `--cwd`/`--run-dir`/`--session-title` disambiguation, a `keeper session <state|files|events|summary>` group, and `--agent-help` across agent-facing subcommands.

## Quick commands

- `keeper prompt build-snippets --help && git -C ~/code/keeper status --porcelain | grep -c _index.yaml | grep -q '^0$'` — help is pure (no write)
- `keeper plan show --help | head -3 | grep -qi 'usage: keeper plan show'` — leaf help renders
- `keeper --help --json | jq -e '.subcommands[] | select(.name=="plan") | .verbs | length >= 34'` — index reflects reality
- `keeper session summary --help` — grouped session read exists with pure leaf help
- `keeper board --timeout 2 2>&1 | grep -qi 'unit'` — bare-number durations rejected with a hint

## Acceptance

- [ ] Running any keeper/plan/prompt subcommand or verb with `--help` (or `-h`, or `--version` where supported) prints help/version, exits 0, and performs zero state mutation, daemon connection, or database open — enforced by a mechanical test that walks every descriptor leaf under throwing stub deps
- [ ] Every plan and prompt verb renders verb-specific leaf help with usage, arguments, and options
- [ ] `keeper --help --json` emits a recursive descriptor-sourced tree (including per-command flags, exit codes, format modes, mutates/daemon/tty requirements) whose verb sets match the dispatchable reality for keeper, plan, and prompt; completions are generated from the same descriptors
- [ ] All finite-output JSON-read subcommands accept `--format json|yaml|human` with `--json` as a documented alias; declared `format_modes` never advertise a mode a command cannot render; the plan `emit()` Python-byte-parity family and envelope exemptions are byte-unchanged
- [ ] Every duration-valued flag across keeper accepts the shared unit-required grammar (`500ms`, `30s`, `5m`) and rejects bare numbers with a hint naming the expected shape
- [ ] `keeper handoff --cwd`, `keeper agent panel --run-dir`, `keeper show-job --job-id`/`--session-title` are the only spellings of those concepts; the retired spellings hard-fail; all in-repo skills, templates, agents, and docs cite only the new spellings
- [ ] `keeper session <state|files|events|summary>` replaces the four flat session-scoped leaves; the retired leaf names hard-fail; allowed-tools globs in skills grant the grouped form; vendor-corpus `--check` and the BAKE guards are green
- [ ] `await`, `bus`, `plan`, `prompt`, `agent`, and `tabs` each serve a terse `--agent-help` operator runbook, purely
- [ ] Frozen seams unchanged: plan/prompt exit-2 Click byte-parity divergence, plan bare-verb names, baseline exit-1-pending (now declared in its descriptor), panel exit 124 (now indexed)
- [ ] `bun run test:full` green

## Early proof point

Task that proves the approach: ordinal 1 (descriptor core). If deriving native `parseArgs` configs from pure-data descriptors turns out not to round-trip a leaf's real flag surface, fall back to descriptor-declares/test-asserts conformance for that leaf and record the deviation in the task's Done summary.

## References

- `docs/adr/0008-pure-data-cli-descriptor-modules.md` — the architecture decision this epic implements
- `fn-1141` (overlap dep) — rewrites `landedState` / `computeLandedEpicIds`, whose sole CLI caller is `cli/await.ts`; this epic edits that caller's flag surface, so it lands after fn-1141's final signatures
- Frozen seams: `cli/keeper.ts:245-260` (plan/prompt exit-2 byte-compat), `plugins/plan/CLAUDE.md` (bare-verb names), plan `emit()` parity family, `cli/envelope.ts` EXEMPTIONS list
- Prior art: oclif manifest (rejected — see ADR), clap/cobra descriptor-drives-parser, Click `resilient_parsing` help-purity guard, Go `time.ParseDuration` grammar

## Docs gaps

- **plugins/keeper/skills/handoff/SKILL.md**: update `--dir` → `--cwd` in frontmatter argument-hint, flag table, prose, exit-code table
- **plugins/plan/agents/panel-runner.md**: `panel wait --dir` → `--run-dir`
- **docs/problem-codes.md**: bare-reader names to grouped verbs; `show-job` selector rows to `--job-id`/`--session-title`
- **plugins/plan/skills/{work,hack,deconflict,unblock}/SKILL.md + plugins/keeper/skills/{query,debug}/SKILL.md**: session verb citations + allowed-tools globs to grouped forms
- **plugins/plan/template/agents/worker.md.tmpl + template/skills/work.md.tmpl**: session verb citations
- **cli/envelope.ts header doc**: usage-fault exit stance updated to exit 2

## Best practices

- **Route argv to intent before constructing dependencies:** the structural help-purity fix — meta modes (help/version/completion) short-circuit before any deps build [clig.dev, Click resilient_parsing]
- **Descriptor drives the parser, never describes it:** deriving the parse config from the descriptor is a stronger anti-drift guarantee than any diff gate [clap/cobra]
- **Unit-required durations:** reject bare numbers rather than guessing seconds vs ms [Go ParseDuration]
- **Warnings to stderr only:** nothing may corrupt `--json`/`--format` stdout that scripts pipe to jq
- **Never repurpose a flag's meaning on the same name:** rename to an honest new name instead (panel `--dir` → `--run-dir`, not `--cwd`)

## Alternatives

- **Build-time generated descriptor manifest** (oclif pattern): rejected in ADR 0008 — in-repo static plugins need no discovery artifact, and a manifest adds generation machinery plus a drift gate.
- **Deprecation-alias rename rollout** (Helm/K8s pattern): rejected per the repo's build-forward rule — all callers are in-repo and enumerable, migrated atomically in this epic.
- **Folding search-history/find-file-history/show-job into `keeper session`**: rejected — they are history- and job-scoped, not one-session-scoped; grouping them would blur the noun the group exists to sharpen.

## Architecture

One descriptor module per CLI, each pure data and dependency-free:

```
cli/descriptor.ts            (types + native command tree)
plugins/plan/src/descriptor.ts
plugins/prompt/src/descriptor.ts
        │ consumed by its own CLI (parser derivation, leaf help)
        └ lazily imported by cli/keeper.ts for USAGE, --help --json,
          and buildCompletionCli — never by the dispatch tree
```

Plan/prompt verbs stay out of the root Clerc dispatch tree (residual pass-through preserved); only the throwaway completion tree and the JSON index read their descriptors. An import-graph test pins all three descriptor modules dependency-free.

## Rollout

Three dep-enforced waves inside one epic: (1) purity + descriptor core (ordinals 1–5), (2) grammar convergence (6–8, 11), (3) session-group cutover with its cross-repo corpus edit (9–10). Hard cutover: retired spellings fail immediately after their wave lands; no alias shims. All caller migration (skills, templates, agents, docs, corpus) lands in the same wave as its rename. Auto-deploy ships the binary on merge; completions regenerate via `keeper completions <shell>` at install time, so no operator action beyond normal merge.
