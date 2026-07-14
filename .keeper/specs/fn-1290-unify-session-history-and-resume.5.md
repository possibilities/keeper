## Description

**Size:** M
**Files:** cli/session.ts, cli/session-state.ts, cli/show-session-files.ts, cli/show-session-events.ts, cli/session-summary.ts, cli/transcript.ts, cli/show-job.ts, plugins/keeper/pi-extension/keeper-events.ts, test/session-state.test.ts, test/session-summary.test.ts, test/transcript-cli.test.ts, test/show-job.test.ts, test/pi-extension.test.ts

### Approach

Route every existing session-targeting read through the canonical Session-reference resolver while retaining each command's capability boundary. Native transcript reads work for standalone sessions; job/event/file/state reads resolve the session first and return `not_tracked` or job-candidate ambiguity rather than pretending the session is absent.

Replace Pi's Claude-hardcoded transcript model tool with a cross-harness history tool that can list, show, search, and scope by Session reference. Keep specialist subagent and latest-turn operations available through the low-level transcript command.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/session-summary.ts:157 — current exact-job-id summary query
- cli/show-session-events.ts:101 — current exact session event spine
- cli/show-session-files.ts:23 — current attribution-bound file read
- cli/transcript.ts:679 — exact native-id reader dispatch
- cli/show-job.ts:114 — job-specific title/ambiguity semantics
- plugins/keeper/pi-extension/keeper-events.ts:626 — Claude-hardcoded transcript tool argv

**Optional** (reference as needed):
- test/show-job.test.ts:55 — historical-title and explicit ambiguity corpus
- test/pi-extension.test.ts:1 — extension fail-open and argv tests

### Risks

A single Harness session can map to zero or several jobs, and changing accepted selectors/output schemas can break agents. The Pi extension must remain dependency-light and fail open even when history indexing is unavailable.

### Test notes

Cover every command with qualified/native/job/current-title/historical-title selectors, duplicate candidates, standalone sessions, multiple associated jobs, and stale/missing artifacts. Pin Pi tool parameter caps, cancellation, buffer behavior, and cross-harness argv.

### Detailed phases

1. Add one reusable CLI selector parser/error renderer over the resolver.
2. Migrate session state/files/events/summary and job inspection without widening their data capabilities.
3. Migrate transcript show/turn resolution while preserving project and subagent disambiguation.
4. Replace the Pi model tool contract and prompt guidance with the bounded history surface.
5. Update focused tests and remove command-local title SQL only where the shared resolver supersedes it.

### Alternatives

Keeping job-only selectors on established commands is rejected because it preserves the exact API inconsistency requested for removal; widening their data output to standalone sessions is also rejected when no tracked facts exist.

### Non-functional targets

Resolver work is bounded and shared, help remains side-effect free, Pi extension startup gains no static heavy dependency, and failures never crash or mutate a Harness session.

### Rollout

Existing spellings continue during this task. The following cutover removes obsolete top-level history names and updates every authored recipe.

## Acceptance

- [ ] Session state, files, events, summary, transcript show/turn, and job inspection accept the shared exact Session-reference forms and return consistent structured ambiguity.
- [ ] Native-only sessions work for transcript/history capabilities, while tracked-only capabilities return `not_tracked` with recovery rather than `not_found`.
- [ ] Multiple jobs associated with one Harness session remain explicit on job-specific reads and never collapse without an exact job id.
- [ ] Low-level transcript project/subagent/Pi-turn behavior remains available after reference resolution.
- [ ] Pi exposes a bounded cross-harness history tool for list/show/search with truthful parameters and no Claude hardcoding; extension failures remain fail-open.
- [ ] Focused session, transcript, show-job, and Pi-extension tests pass.

## Done summary

## Evidence
