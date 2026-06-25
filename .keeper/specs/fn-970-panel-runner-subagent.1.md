## Description

**Size:** M
**Files:** plugins/plan/agents/panel-runner.md

### Approach

Create a new STATIC agent `plugins/plan/agents/panel-runner.md` (auto-discovered as
`plan:panel-runner`; no `.tmpl`, no `.managed-file-dont-edit` sidecar). Mirror the
`panel-judge.md` frontmatter shape but make it Task-capable: `name: panel-runner`,
`description` (one imperative sentence; spawned by `/plan:panel` and by programmatic
callers), `model: opus`, `disallowedTools: Edit, Write, Monitor` (keeps Bash, Read, Task —
it MUST spawn the judge), `effort: "xhigh"`, a distinct `color`. The body is the current
panel SKILL Steps 0-4 rewritten for blocking-Bash fan-out:

1. Resolve composition: `keeper agent presets resolve <panel-name>` → JSON `members`
   (`panels.<name>`); on non-zero exit fall back to the legacy two legs (`--cli claude` +
   `--cli codex`); empty `members` on a zero exit is a hard error.
2. Write ONE verbatim prompt file (independence rules unchanged — task verbatim + the short
   independent-expert instruction) into a session+invocation-scoped scratch dir under `/tmp`.
3. Fan out: launch each leg DETACHED — `setsid nohup keeper pair send <prompt> --preset
   <member> --read-only --session panels --output <dir>/<member>.yaml --timeout <T>
   </dev/null >log 2>&1 &` — in a launch Bash call SEPARATE from the poll call.
4. Wait token-free: re-issue one blocking poll per ≤9-min chunk
   (`timeout 540 bash -c 'until [ -f a.yaml ] && [ -f b.yaml ]; do sleep 5; done'`; exit 124
   → re-issue) until every leg's `--output` exists, bounded by a give-up backstop set just
   past the per-leg `--timeout`. Never model-poll.
5. N-of-N hard-fail: if any leg's `--output` never appears within the backstop (or a companion
   status signals failure), return a structured failure marker and do NOT spawn the judge.
6. On full success, collect the `--output` PATHS only (never read panelist content) and
   `Task(subagent_type="plan:panel-judge", …)` with the question verbatim + labeled
   answer-file paths (NO `model=` kwarg). Return the judge's fused answer verbatim as the
   runner's final message.

### Investigation targets

**Required** (read before coding):
- plugins/plan/agents/panel-judge.md — frontmatter shape to mirror; the judge input contract
  (question verbatim + labeled paths) the runner must produce.
- plugins/plan/skills/panel/SKILL.md — current Steps 0-4 prose to port into the runner body
  (preset resolve, verbatim prompt, fan-out, judge spawn). Line numbers shifted recently — re-read.
- plugins/plan/skills/panel/references/panel.md — independence rules the runner prompt must preserve.
- cli/pair.ts — authoritative `keeper pair send` contract: flags (`--preset`/`--cli`, `--output`,
  `--read-only`, `--session`, `--timeout` default 1800s), two-line stdout, exit taxonomy
  (0 completed / 1 failed / 2 arg-fault).
- ~/docs/subagent-cli-wrapping/README.md — the wait patterns + the "never leave a background task
  unawaited in a subagent" constraint.

**Optional** (reference as needed):
- src/pair-command.ts (~544-608) — atomic temp-then-rename of `--output` (why `[ -f ]` is safe).
- cli/agent.ts + test/agent-presets.test.ts — the `keeper agent presets resolve` panel-kind JSON
  members contract (from fn-937).
- src/codex-trust.ts — codex trust-seed (fail-open) for the read-only codex leg under detachment.

### Risks

- **Detached-leg survival:** `$!` after `setsid` is unreliable; track liveness via the `--output`
  file (and an optional companion status), not the launcher PID.
- **Timeout reconciliation:** the runner's give-up backstop must be ≥ the per-leg `keeper pair
  --timeout` it passes, or it orphans a still-running leg / hangs the caller. pair's `--timeout`
  is authoritative; the poll backstop is one grace chunk past it.
- **codex under `</dev/null`:** the codex leg is an interactive TUI with a fail-open trust-seed;
  verify detachment with stdin from `/dev/null` doesn't wedge it.
- **Legacy fallback drift:** the non-zero-resolve fallback must use the SAME detached +
  chunked-poll path, not a stray Monitor shape.

### Test notes

The agent is prose; correctness is proven by the real run (epic Quick commands) plus the static
assertions added in `.2`. Verify the deepest path — a subagent caller → runner → judge (two
levels) — actually fuses, since that nesting is the one mechanic the README claims but this epic
must confirm.

## Acceptance

- [ ] `plugins/plan/agents/panel-runner.md` exists as a static agent (no sidecar), auto-discovered
      as `plan:panel-runner`, frontmatter `disallowedTools: Edit, Write, Monitor` (Task retained),
      `model: opus`, `effort: "xhigh"`.
- [ ] Fans out each leg detached (`setsid nohup … </dev/null &`) and waits via chunked blocking
      Bash (≤9-min chunks), no Monitor, no model-level polling.
- [ ] Composition is preset-driven via `keeper agent presets resolve`, with the legacy
      `--cli claude` + `--cli codex` fallback on non-zero resolve and a hard error on empty members.
- [ ] N-of-N hard-fail: any leg failure/timeout/missing-output → structured failure marker, judge
      NOT spawned; zero legs is a hard failure.
- [ ] On full success, spawns `plan:panel-judge` (no `model=` kwarg) with the question verbatim +
      labeled answer-file PATHS only, and returns the fused answer verbatim.
- [ ] Verified by a real run from inside a subagent caller (caller → runner → judge).

## Done summary

## Evidence
