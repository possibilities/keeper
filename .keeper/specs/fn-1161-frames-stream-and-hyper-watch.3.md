## Description

**Size:** M
**Files:** cli/frames.ts, cli/descriptor.ts, cli/keeper.ts, cli/jobs.ts, cli/git.ts, cli/autopilot.ts, cli/builds.ts, README.md, test/frames-cli.test.ts

### Approach

Expose the stream as a new top-level subcommand `keeper frames` via the
repo's three-touch add: the name in SUBCOMMANDS, a lazy-import handler in the
handlers record, and a CommandDescriptor in NATIVE_COMMANDS (SUBCOMMAND_META
derives — never hand-edit). Flag grammar is its own (it must NOT reuse
resolveSnapshotMode): `--view <board|jobs|git|autopilot|builds|usage>`
defaulting to board, `--for <dur>` (parseDuration), `--max-frames <n>`,
`--follow` (mutually exclusive with the two bounds — exit 2 on conflict),
`--prev-frame <path>` (render the baseline as a net diff against a prior
chunk's last frame), `--sock`. One invocation streams ONE view; multi-view
supervision is one process per view. Dispatch calls the selected viewer's
frames entry: board's landed with the previous task — add the parallel
entries to jobs, git, autopilot, and builds here following board's pattern;
wire the usage dispatch arm now (its entry lands in the next task). Write the
`--agent-help` runbook: the envelope contract, the chunked-consumption loop,
the resume-cursor/coverage semantics, and the one-process-per-view rule. Exit
codes slot into the machine-readable taxonomy: 0 when a trailer was emitted
(idle zero-frame chunks included), 1 when the daemon was never reachable, 2 on
flag misuse. The trailer obeys the always-parseable-last-line discipline.
README: add `keeper frames` to the CLI roster line and a phrase at the "No
UI" line acknowledging the agent-consumable NDJSON inspection surface.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/keeper.ts:37 SUBCOMMANDS; :564 handlers record; :177 exit-code taxonomy; :190-265 the --help --json machine index the new command must appear in
- cli/descriptor.ts:73 CommandDescriptor; :416 NATIVE_COMMANDS; :192 VIEWER_FLAGS shape (frames declares its own flag set, do not extend VIEWER_FLAGS)
- cli/board.ts — the frames entry pattern the previous task established (mirror into the four other shell viewers)
- src/snapshot.ts:181 — snapshot's no-frame exit-1 precedent the daemon-unreachable mapping mirrors

**Optional** (reference as needed):
- cli/duration.ts parseDuration — the --for parser
- docs/adr/0008-pure-data-cli-descriptor-modules.md — why the descriptor drives the parser
- README.md:40,158 — the two roster/inspection lines to touch
- docs/adr/0012-agent-frame-stream-wire-contract.md — source for the --agent-help prose

### Risks

- A help-index or descriptor conformance test may assert the command tree shape — grep for it and update fixtures rather than discovering the failure at commit time.
- cli/autopilot.ts carries uncommitted working-tree changes from other in-flight work; keep this task's diff to the frames entry.

### Test notes

Pure tier: flag-grammar parsing (conflicts exit 2), descriptor presence in the
help index, dispatch table covering all six views, exit-code mapping via
injected IO. No daemon boot.

## Acceptance

- [ ] keeper frames appears in the subcommand set, the descriptor tree, and the --help --json index, with --help and --agent-help documenting the envelope, trailer, cursor, and one-process-per-view contract
- [ ] --follow conflicts with --for/--max-frames at parse time with exit 2; a bad duration or count exits 2
- [ ] Dispatch reaches the frames entry of board, jobs, git, autopilot, and builds; the usage arm is wired and its behavior is owned by the usage task
- [ ] Exit codes: trailer-emitted runs exit 0, never-reachable exits 1, flag misuse exits 2
- [ ] README names keeper frames in the CLI roster and acknowledges the NDJSON inspection surface

## Done summary
Added the keeper frames subcommand (own flag grammar, --agent-help runbook, view dispatch table, 0/1/2 exit taxonomy) plus parallel frames entries in jobs/git/autopilot/builds and the wired usage arm; README names it and acknowledges the NDJSON surface.
## Evidence
