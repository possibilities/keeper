## Description

**Size:** M
**Files:** src/agent/dispatch.ts, src/agent/main.ts, test/agent-dispatch.test.ts

### Approach

The harness-agnostic Layer-1 verb: `keeper agent resume <name-or-id>
[prompt]`. A new Dispatch union member + splitSubcommand branch + main.ts
route (union and switch stay in sync). The route: resolve via the
resume-policy module → refuse-live / ambiguous / unknown exit 2 with the
module's actionable message (ambiguity echoes candidates; a collapsed
newest pick is echoed with id + harness before launch) → launch the
partner as a detached interactive TUI in the matched job's RECORDED cwd
(actionable error if the directory vanished), with a FRESH minted job id
(a new jobs row — never fold onto the old row) carrying the matched row's
current title as the launch name, so the newest row for a name holds the
latest lineage's resume target and repeated resume-by-name chains through
children. Argv comes from the resume builders (previous task); for claude
the route mints the child uuid and pins it. Help text (USAGE /
KEEPER_AGENT_HELP / KEEPER_AGENT_RUNBOOK) documents the verb and states
that the native per-harness passthrough flags stay verbatim; the
harness-native resume detection (hasContinueOrResume) must not
mis-classify the new verb.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/dispatch.ts:24-51 — the Dispatch union; :331 splitSubcommand (strips exactly ONE leading token)
- src/agent/main.ts:1847 — the dispatch.kind route switch; :2805-2835 armBirthRecord fold-vs-fresh behavior (the resumed launch must mint fresh, so do NOT carry the old KEEPER_JOB_ID); :2847 resumeTargetFromArgv (birth-record consistency for the resumed session)
- src/agent/args.ts:138-152 — hasContinueOrResume detection the new verb must not trip
- cli/agent.ts:87 — help classification happens BEFORE deps are built

**Optional** (reference as needed):
- src/agent/tmux-launch.ts — the detached TUI launch surface the route drives
- src/agent/cwd-confirm.ts / cwd-ordinal.ts — existing cwd handling conventions

### Risks

- Birth-record consistency: the resumed session's own hooks will birth a row — verify the launch env (fresh job id + name) produces one new row with the correct resume lineage, not a fold onto the resolved row
- The verb name `resume` must not shadow a harness name or an existing subcommand

### Test notes

splitSubcommand + Dispatch union cases in the dispatch fast suite; route
error paths (refuse-live / ambiguous / unknown / vanished cwd) unit-tested
via the pure seams; one manual end-to-end resume per reachable harness
recorded in Evidence.

## Acceptance

- [ ] `keeper agent resume <x> [prompt]` re-attaches a dead partner by current name, former name, or session id, launching in the job's recorded cwd with the prompt delivered
- [ ] A live target exits non-zero pointing at the bus; ambiguity exits non-zero listing candidates; an unknown target exits non-zero without launching anything
- [ ] The resumed launch mints a fresh tracked job carrying the matched row's name, and a second resume by the same name resolves the newer lineage
- [ ] `keeper agent --help` output documents the verb and the existing native passthrough flags behave byte-identically
- [ ] The dispatch fast suite covers the new union member and verb split

## Done summary
Wired keeper agent resume <name-or-id> [prompt]: resolves via resume-policy (refuse-live/ambiguous/unknown/no-target all exit 2 with no launch), then relaunches the matched partner as a detached interactive TUI in its recorded cwd with a fresh tracked job carrying the matched row's name. resolveResumeDecision's db dependency is isolated behind a new subprocess (resume-resolve-cli.ts) to keep cli/agent.ts's cold-start bundle bun:sqlite-free. --help/--x-help/--agent-help document the verb; fresh-launch argv is byte-unchanged.
## Evidence
