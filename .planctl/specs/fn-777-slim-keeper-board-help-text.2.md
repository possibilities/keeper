## Description

**Size:** S
**Files:** cli/jobs.ts, cli/await.ts

### Approach

Each subcommand owns its HELP block parsed by its own main (`keeper <sub> --help` forwards through; see cli/keeper.ts header). Slim cli/jobs.ts and cli/await.ts HELP text to the commit-work house style: usage line, one line per flag/condition, 2-3 examples, <= ~40 lines each. For await, the condition table (complete/unblocked/git-clean/agents-idle/server-up/monitor-running) stays — one line per condition; the reconnect-semantics and exit-code essays compress to a terse exit-code table; anything skills/await/SKILL.md already documents for agents in depth gets deleted from --help, not duplicated. Present-tense, no ticket ids.

### Investigation targets

**Required** (read before coding):
- cli/jobs.ts and cli/await.ts — current HELP blocks
- cli/commit-work.ts — the 16-line house-style reference
- test/ — grep for help-text assertions before editing (e.g. usage strings in await tests)

### Risks

await's exit-code semantics are consumed by the await skill — the slim help must keep exit codes accurate or state where they're documented.

### Test notes

`bun test` green; `bun run test:full` if any non-help code path touched; eyeball both outputs.

## Acceptance

- [ ] `keeper jobs --help` and `keeper await --help` each <= ~40 lines, accurate
- [ ] No content silently lost: deep semantics live in skill/README or are deleted as duplication
- [ ] Tests green; Done summary reports lines/chars deleted

## Done summary
Slimmed keeper jobs --help 87->31 lines (4496->1492 chars) and await --help 82->39 lines (4672->1874 chars) to the commit-work house style; deep render/pill/sidecar detail stays in the cli/jobs.ts module header and await's reason glossary + reconnect semantics in skills/await/SKILL.md. Tests green.
## Evidence
