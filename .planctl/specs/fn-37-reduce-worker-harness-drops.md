## Overview

Workers spawned by `/plan:work` sometimes return without finishing their task (a
"harness drop"). Fleet forensics across 1,640 worker invocations measured a 25%
drop rate with three dominant mechanisms: the `maxTurns: 100` frontmatter cap
silently guillotines ~8% of all invocations at exactly 100 rounds (successful
runs need p50=32 / p90=74 / p99=95 rounds, so the cap sits inside the real
task-size distribution); transient transport failures (terminal 529s, mid-stream
socket closes during multi-minute Bash-heredoc generations) kill ~4%; and a
small model-initiated class ends turns text-only to "wait" for external events —
a yielded Task subagent is terminated by the loop. This epic raises the cap to
300 (a runaway backstop ~3x the p99 of real runs), hardens the worker template
prose against the yield-to-wait and giant-heredoc failure modes, and runs two
read-only investigations: the one observed spawn whose tool universe lacked
Edit/Write entirely, and the ~65 silent process deaths with no correlated
session end.

Out of scope: subscription session-limit handling, keeper-side usage-gating of
autopilot dispatch, and any agentuse changes. Investigations deliver findings
and follow-up candidates only — no code changes ride on them.

All worker-agent edits land in `template/agents/worker.md.tmpl` (the four
`agents/worker-*.md` files are generated, gitignored, and hook-blocked) and
regenerate via `promptctl render-plugin-templates`.

## Quick commands

- `grep -n "maxTurns" template/agents/worker.md.tmpl agents/worker-*.md` — every line shows `maxTurns: 300` (template + all four renders)
- `bun test --timeout 30000` — the whole gate; consistency tests pin template structure and rendered frontmatter

## Acceptance

- [ ] `maxTurns: 300` in the worker template frontmatter and all four rendered agent files
- [ ] Hardening prose (poll-don't-yield; Edit/Write over whole-file Bash heredocs) present in the rendered worker agents; consistency suite green; no new `BLOCKED:` category
- [ ] Edit-less spawn anomaly root-caused with evidence, or ruled un-reproducible with the checked surfaces enumerated
- [ ] Silent process deaths classified with per-cause counts and evidence; actionable causes written up as follow-up candidates

## Early proof point

Task that proves the approach: ordinal 1 (template edit + render + test gate —
exercises the entire edit-render-verify loop). If it fails: the consistency
tests name the violated pin; fix prose placement per the test output and
re-render.

## References

- `template/agents/worker.md.tmpl` — sole source for the four worker agents; `maxTurns` at line 7; `BLOCKED:` category enum at ~line 194; doc-discipline block sits immediately before `## Rules` (test-pinned)
- `template/skills/work.md.tmpl` — orchestrator source (renders to `skills/work/SKILL.md`); warm/cold resume machinery at ~lines 110-173
- `test/consistency-skills.test.ts` — structural pins: discipline-before-Rules ordering (~:419), 5-bullet discipline cap (~:436), no ticket ids in prose (~:444), per-tier rendered frontmatter assertions (~:350-363)
- `test/consistency-generated-guard.test.ts` — PreToolUse hook denies edits to rendered files
- anthropics/claude-code#60577 — upstream: a single 529 terminates a turn, no auto-retry (open as of June 2026)
- Fleet evidence base: keeper db `~/.local/state/keeper/keeper.db` (read-only) + subagent transcripts under `~/.claude/projects/<project>/<session>/subagents/`

## Best practices

- **One model response = one turn:** `maxTurns` counts API rounds; the cap stop is silent (no marker in transcript or Task result) — the rendered-frontmatter test is the only regression guard [Claude Code docs]
- **`stop_reason: null` is never a real end_turn:** it marks an interrupted stream; a complete turn always carries a terminal stop reason [Anthropic streaming docs]
- **Text-only responses terminate the agent loop:** every worker turn must either call a tool or deliver the final return; prose like "wait for" without a paired action teaches the model to yield [loop semantics + community playbooks]
- **Prefer structured Write/Edit over streamed heredocs for big content:** a killed stream mid-heredoc leaves a partial text block; a failed Write is detectable and retryable [Anthropic fine-grained streaming docs]
