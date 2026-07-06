## Description

**Size:** M
**Files:** cli/descriptor.ts (new), cli/keeper.ts, cli/board.ts, cli/jobs.ts, cli/git.ts, cli/usage.ts, cli/autopilot.ts, cli/builds.ts, cli/dash.ts, cli/status.ts, cli/query.ts, cli/watch.ts, cli/await.ts, cli/commit-work.ts, cli/setup-tmux.ts, cli/tabs.ts, cli/session-state.ts, cli/show-session-files.ts, cli/search-history.ts, cli/find-file-history.ts, cli/show-session-events.ts, cli/show-job.ts, cli/session-summary.ts, cli/dispatch.ts, cli/handoff.ts, cli/reclaim.ts, cli/baseline.ts, cli/escalation-brief.ts, cli/statusline-sink.ts, test/keeper-cli.test.ts, test/completions.test.ts

### Approach

Implements ADR 0008 for the native surface. Define the recursive descriptor type ({name, summary, visibility, mutates, requires_daemon, requires_tty, format_modes, flags, exit_codes, verbs}) in a dependency-free `cli/descriptor.ts` and author one descriptor entry per native leaf, extracted from each leaf's current parseArgs config and HELP string. Each native leaf derives its `node:util` parseArgs options object from its descriptor entry so flags cannot drift from metadata. `buildHelpIndex` (the `--help --json` tree), USAGE, and `buildCompletionCli` render from the descriptor tree; the hand-maintained SUBCOMMAND_META verb lists retire. Plan/prompt subtree wiring is NOT this task (ordinal 5) — until then the index may render those two entries from their existing static summaries. Behavior of every leaf is byte-identical for non-help invocations; this task adds no renames. Also: panel exit 124 joins the EXIT_CODES index, statusline-sink is marked visibility:internal (omitted from human USAGE, present in `--help --json` with its visibility field), and the `--help --json` schema documents itself as the recursive tree.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/keeper.ts:76-249 — SUBCOMMAND_META being replaced; :287 buildHelpIndex; :307 USAGE; :334-345 DispatchDeps injection seam; :355-360 the pass-through constraint (plan/prompt verbs stay OUT of the dispatch tree); :411 buildCompletionCli
- cli/keeper.ts:245-270 — EXIT_CODES + the frozen plan/prompt exit-2 comment (do not touch the seam; only add 124)
- cli/baseline.ts:39,78,173 — representative leaf: parseArgs config + HELP const + help gate shape to derive from a descriptor
- test/keeper-cli.test.ts:1-60 — stub-handler + captured-sink + ExitError test pattern to extend

**Optional** (reference as needed):
- src/pair/panel.ts:1425 — exit 124 semantics (chunk-elapsed re-issue signal, not a failure)
- cli/envelope.ts:25-35 — EXEMPTIONS list (format_modes for exempt surfaces must stay truthful)

### Risks

- A leaf whose parseArgs config cannot round-trip through the descriptor (dynamic or conditional flags) — fall back to descriptor-declares/test-asserts conformance for that leaf and record it in Done summary (epic Early proof point carries the recovery).
- Import cycles: descriptor.ts must import nothing from cli/ or src/ — keep it types + data only.

### Test notes

Extend test/keeper-cli.test.ts and test/completions.test.ts: index tree matches descriptor tree; every descriptor leaf name dispatches; completions enumerate descriptor verbs; USAGE omits visibility:internal entries while `--help --json` includes them.

## Acceptance

- [ ] A dependency-free descriptor module exports the full native command tree and every native leaf's parseArgs options derive from it
- [ ] `keeper --help --json` renders the recursive descriptor tree including flags, exit_codes, format_modes, mutates, requires_daemon, requires_tty per command, with exit 124 indexed and statusline-sink carried as visibility:internal (omitted from human USAGE)
- [ ] Shell completions are generated from the descriptor tree and enumerate exactly the dispatchable native surface
- [ ] Non-help behavior of every native leaf is unchanged (existing suites green without behavioral edits)

## Done summary

## Evidence
