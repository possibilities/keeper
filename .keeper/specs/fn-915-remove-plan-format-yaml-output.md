## Overview

The `keeper plan --format yaml` output format is a dead planctl-parity port:
no skill, agent, template, or orchestration script consumes it (machine
callers use the default JSON; interactive humans get the TTY `human` format).
Remove that output surface and, as a consequence, stop the `keeper plan`
binary from bundling `js-yaml` — its only use in plan/src is the yaml
emitter. The agent-authored scaffold/refine YAML INPUT (eemeli `yaml` in
`yaml_input.ts`) is a different package and is deliberately KEPT — this work
does not touch it.

The one wrinkle: `yamlDump` is also the bundle writer for the prompt plugin,
so it relocates into the prompt plugin (its real owner) rather than being
deleted, and the prompt plugin gains the `js-yaml` dependency it currently
free-rides on.

End state: `--format yaml` is gone from both the plan and prompt CLIs (json +
human remain), `js-yaml` is declared by the plugin that imports it (prompt),
and the `keeper plan` binary no longer carries the yaml parser.

## Quick commands

- `cd plugins/plan && bun run lint && bun run typecheck && bun test` — plan plugin green
- `cd plugins/prompt && bun run typecheck && bun test` — prompt plugin green (bundle write path intact)
- `keeper plan epics --format yaml; echo "exit=$?"` — now exits 2 (invalid format), json/human still work
- `keeper prompt render <some-bundle>` then re-save a bundle — confirms the relocated bundle YAML writer still emits byte-identical output

## Acceptance

- [ ] `--format yaml` is removed from the `OutputFormat` type and both plugins' `readFormat` validators + `--help` strings; `--format json` and `--format human` are unaffected
- [ ] `yamlDump` lives in the prompt plugin (co-located with its sole caller `bundle_io.ts`) with its byte-parity options (`noArrayIndent`, `lineWidth:-1`, `sortKeys:false`) intact; bundle write/read round-trips unchanged
- [ ] `plugins/plan/src/` no longer imports `js-yaml`; `js-yaml` + `@types/js-yaml` are dropped from `plugins/plan/package.json` and declared in `plugins/prompt/package.json`; root keeps `js-yaml` (pair-command uses it)
- [ ] both plugin suites pass and a clean install (`rm -rf node_modules && bun install --frozen-lockfile`) resolves with no phantom js-yaml in the plan binary
- [ ] `plugins/plan/README.md` flag docs no longer mention `--format yaml`

## Early proof point

Task that proves the approach: `.1` (the relocation + surface removal). If
`yamlDump`'s relocated output drifts from the byte-parity options, the bundle
round-trip diverges — catch it with a prompt-side unit test before `.2` touches
any package.json. Recovery: inline `yamlDump` directly into `bundle_io.ts`
rather than a sibling module.

## References

- `plugins/plan/CLAUDE.md` "Doc & comment style" — forward-facing comments only; rewrite the `format.ts` header + `yamlDump` docstring present-tense at their new home, no "removed the yaml branch" narration.
- `format.ts` is "the byte-parity port of planctl/_util.py" — `yamlDump`'s PyYAML-matching options are load-bearing and must survive relocation byte-identically.
- Overlap with `fn-914` (green/de-quarantine the plan test suite): both edit the same five `plugins/plan/test/` files (`src-format`, `verbs-readonly`, `src-cli`, `src-cli-groups`, `verbs-query`) — merge-conflict risk, serialized via an epic dep so they don't run concurrently.

## Docs gaps

- **plugins/plan/README.md**: lines ~8 and ~142 describe `--format yaml` — drop the yaml option from both flag descriptions, keep the `--format human` clause (handled in task .1).
