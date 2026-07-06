## Overview

The `keeper agent panel` wait discipline can drop silently: a chunked blocking wait issued without the Bash tool's explicit `timeout` parameter auto-backgrounds at the ~120s default window, the notify-on-completion promise never fires for a subagent, and a status narration gets absorbed as a panel answer. This epic makes the drop structurally impossible at both layers: the panel-runner agent's wait becomes one explicitly-timed blocking call per chunk with an auto-background tripwire and a positively marked return; the /plan:panel caller validates the runner return against a two-shape contract with one idempotent re-drive; and the sibling pair skill's parallel wait prose is corrected to state the same true facts about the same engine.

## Quick commands

- `bun test plugins/plan/test/consistency-skills.test.ts` — asserts the hardened prose: timeout parameter, tripwire, PANEL_ANSWER/PANEL_RUN_FAILED contract
- `rg -n "timeout: 600000" plugins/plan/agents/panel-runner.md plugins/keeper/skills/pair/SKILL.md` — both surfaces carry the explicit tool timeout

## Acceptance

- [ ] A panel wait that exceeds the Bash default window can no longer end a runner turn silently: the documented discipline re-issues bounded blocking waits and terminates in PANEL_RUN_FAILED when the backstop is exhausted
- [ ] The /plan:panel caller cannot absorb a non-answer: only first-line PANEL_ANSWER or PANEL_RUN_FAILED returns are valid; a malformed return re-drives once by slug then surfaces as failure
- [ ] The pair skill states the same timeout facts as the panel runner — no sibling-doc divergence on the shared engine

## Early proof point

Task that proves the approach: `.1` (the runner hardening — it establishes the timeout/tripwire/marker vocabulary the other two consume). If it fails: fall back to correcting only the false timeout claims and wiring a SKILL-side narration heuristic without a marker (weaker, but still closes the absorb-narration path).

## References

- Incident session 413e4e08-6b25-434b-a7d0-88742cbafccd (job "subagent-cross-harness-invocation"); runner transcript: ~/.claude-profiles/multi-claude-2/projects/-Users-mike-code-keeper/413e4e08-6b25-434b-a7d0-88742cbafccd/subagents/agent-a6150de290cc1b3b8.jsonl — the wait call without a timeout parameter, the auto-background envelope, the "Ending this turn" final text recorded as an ok return
- Verified harness numbers: BASH_DEFAULT_TIMEOUT_MS=120000 (default foreground window), BASH_MAX_TIMEOUT_MS=600000 (per-call ceiling) — official Claude Code env-vars doc; per-call `timeout` tool parameter preferred over env vars (BASH_DEFAULT_TIMEOUT_MS reportedly ignored in some releases: claude-code #3964, #26660)
- Auto-background envelope does not reliably surface a timeout failure (claude-code #15153) — the envelope itself is the tripwire signal
- `fn-1142` (overlap, dep wired): its task .8 renames `--dir` to `--run-dir` in panel-runner.md's wait invocations — write wait examples in whichever spelling is live at land time; keep exit-124 semantics consistent with its acceptance
- House wording for the never-idle-wait rule: plugins/plan/template/agents/worker.md.tmpl:248

## Docs gaps

- **plugins/keeper/skills/pair/SKILL.md**: covered as an epic task (parity correction), not a trailing docs gap
- **plugins/plan/skills/panel/references/panel.md**: deliberately unchanged — independence/fan-out mechanics only, no wait or contract prose

## Best practices

- **Per-call timeout over env vars:** the Bash tool's `timeout` parameter is honored where BASH_DEFAULT_TIMEOUT_MS reportedly is not [claude-code #3964, #26660]
- **Treat the auto-background envelope as the signal, not its notification:** backgrounded-call failures are not reliably surfaced [claude-code #15153]
- **Tagged-union return contracts:** a cheap, unconditional failure sentinel plus one bounded idempotent retry is the consensus orchestrator pattern for worker returns
