## Description

**Size:** S
**Files:** cli/baseline.ts, cli/keeper.ts, test/baseline-cli.test.ts

### Approach

`keeper baseline [<sha>] [--repo <dir>] [--wait] [--timeout-ms <n>]` — the
worker-facing read surface. Default sha is HEAD of the cwd's repo; the
envelope prints as one clean JSON value mirroring the task-1 union
(green / suite-red / infra-error / timeout / miss / computing). A bare
read never mutates. With --wait the verb becomes trigger-and-await: it
writes a size-bounded request file into the spool (the CLI is the spool's
sole writer) and polls the leaf until a terminal envelope or its own
deadline, exiting non-zero on deadline with a distinct waiting-state
report — a worker can never mistake "gave up waiting" for a result.
Registration follows the house pattern: SUBCOMMANDS entry with a summary,
lazy-import commandMains entry, own HELP block. Exit codes: 0 on any
terminal envelope (including suite-red — red is an answer, not an error),
non-zero on miss-without-wait, deadline, or usage error.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/keeper.ts:24-55 — SUBCOMMANDS + summary registration; :560+ the lazy commandMains map
- src/baseline-store.ts (task 1) — the key, spool, leaf, and envelope contracts this verb speaks
- src/await-conditions.ts:58 — the met/waiting poll-until shape --wait mirrors (deadline owned by the caller)

**Optional** (reference as needed):
- cli/query.ts — envelope-printing conventions for read verbs
- test/keeper-cli.test.ts — CLI registration test idiom (help/json surfaces)

### Risks

- The verb reads state files directly (statusline-leaf pattern) rather than the socket — it must behave sanely with no daemon running: reads still serve hits; --wait on a miss warns that computation needs the daemon and still polls to its deadline.
- Sha resolution happens CLI-side (`git rev-parse` in the target repo); an unresolvable sha is a usage error, distinct from the daemon's checkout infra-error.

### Test notes

Pure tests over arg parsing, envelope rendering, exit-code mapping, and
spool-request composition; poll logic tested with injected clock/reader
(retryUntil idiom), never a real daemon or sleep.

## Acceptance

- [ ] `keeper baseline` resolves sha and repo, reports hit envelopes and miss/computing states as one clean JSON value, and a bare read never writes anything
- [ ] `--wait` writes exactly one well-formed spool request, polls to a caller-owned deadline, exits 0 on any terminal envelope including suite-red, and non-zero with a distinct report when the deadline passes without one
- [ ] The verb is registered with a summary and help so `keeper --help --json` lists it
- [ ] The suite is green via the sanctioned fast gate

## Done summary
Added the keeper baseline read verb (cli/baseline.ts) over the task-1 store contract: a bare read resolves sha+repo and prints the hit/miss/computing union as clean JSON without mutating; --wait writes exactly one spool request and polls the leaf to a caller-owned deadline, exiting 0 on any terminal envelope and non-zero with a distinct report on deadline. Registered in the dispatcher.
## Evidence
