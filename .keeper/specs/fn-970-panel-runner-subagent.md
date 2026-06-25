## Overview

The `/plan:panel` flow today must run in the main session because it fans the panelists
out through the Monitor tool, which only delivers cross-turn events to main — so a
subagent or worker cannot convene a panel. This epic collapses the whole flow (fan-out →
judge) into one context-isolated subagent, `plan:panel-runner`, that fans the legs out as
detached background `keeper pair` processes, waits for them token-free with a chunked
blocking-Bash poll, and spawns `plan:panel-judge` as a sub-subagent. `/plan:panel` becomes
a thin `Task()` shim. End state: one panel implementation, invocable from main, another
skill, or a worker, with panelist content never entering the caller's context.

## Quick commands

- `bun test` (from `plugins/plan/`) — fast tier, includes the new consistency-skills coverage
- `bun run lint && bun run typecheck` (from `plugins/plan/`)
- Real-run proof: from a throwaway session, `/plan:panel "<small question>"` → confirm the
  shim spawns `plan:panel-runner`, both legs run in parallel, no tokens burn during the wait,
  and the judge returns a fused answer.

## Acceptance

- [ ] `plan:panel-runner` fans out the panelists as detached background `keeper pair` legs and
      waits via chunked blocking Bash (no Monitor, no model-level polling), then spawns
      `plan:panel-judge`, returning the fused answer — works invoked from main AND from inside
      another subagent.
- [ ] The wait is token-free: one blocking call per ≤9-min chunk; legs longer than a chunk are
      covered by re-issuing the chunk, bounded by a give-up backstop just past each leg's
      `keeper pair --timeout`.
- [ ] N-of-N hard-fail: if any leg fails, times out, or never produces its `--output`, the
      runner returns a structured failure marker and does NOT spawn the judge (zero legs is also
      a hard failure).
- [ ] `/plan:panel` is a single thin shim that `Task()`s the runner and renders the result;
      panelist content never enters the caller's context (paths only). On a runner failure marker
      the shim surfaces the panel failure rather than presenting it as an answer.
- [ ] Composition is preset-driven (`keeper agent presets resolve <panel>` → `panels.<name>`
      members), with the legacy two-CLI fallback (`--cli claude` + `--cli codex`) surviving a
      non-zero resolve; empty members is a hard error.
- [ ] The stale "never in a subagent (verified)" claim is gone from `panel/SKILL.md` and
      `references/panel.md`; `consistency-skills.test.ts` covers the runner + shim.

## Early proof point

Task that proves the approach: `.1` (the `plan:panel-runner` agent). If the detached-launch +
chunked-poll + N-of-N contract can't be driven reliably from a subagent, the whole epic is moot —
recovery is to revisit the wait mechanism (e.g. `keeper agentwrap wait-for-stop` chunking) before
building the shim.

## References

- `~/docs/subagent-cli-wrapping/README.md` — the experiment table (blocking call = free wait;
  parallel fan-out works; real pair leg from a subagent; background ≠ re-invoke, so never leave a
  background task unawaited in a subagent) and the ≤10-min / >10-min wait patterns.
- `~/docs/subagent-cli-wrapping/01-panel-subagent.md` — the feature brief this epic implements.
- `plugins/plan/agents/panel-judge.md` — the no-nesting leaf judge the runner spawns; the
  frontmatter shape the runner mirrors.
- Depends on / overlaps `fn-937-agent-launch-config-presets` — provides `panels.<name>` + `keeper
  agent presets resolve`; it also edits `panel/SKILL.md` + `panel-judge.md`, so the dep edge orders
  it first and this epic rewrites the post-fn-937 file state.

## Docs gaps

- **`plugins/plan/CLAUDE.md`**: add `panel-runner` to the "Skills and agents" agent enumeration
  (one line, minimal, forward-facing).
- **`plugins/plan/skills/panel/references/panel.md`**: revise the "main session" / "you dispatch"
  framing to name the runner as the dispatch surface; independence rules unchanged.
- **`plugins/plan/agents/panel-judge.md`**: frontmatter `description` should name `plan:panel-runner`
  as the spawner (body unchanged).

## Best practices

- **Detach every leg with `setsid nohup … </dev/null >log 2>&1 &`:** without a new session +
  SIGHUP-immunity + severed stdin, a leg can die when the launching Bash call returns.
- **Separate the launch call from the poll call:** a 10-min poll timeout must never kill the shell
  that launched the legs.
- **Atomic-rename outputs make `[ -f out ]` partial-read-safe:** `keeper pair` already temp-then-
  renames its `--output`; keep workdir + outputs on the same local filesystem (`/tmp`).
- **Never leave a background task unawaited in a subagent:** a subagent gets no re-invoke when a
  background task exits, so the only lever is the blocking poll call.
