## Description

**Size:** M
**Files:** cli/keeper.ts, test/keeper-cli.test.ts, test/completions.test.ts

### Approach

Add a public `completions` subcommand backed by Clerc's completions plugin, and allow the plugin's hidden completion responder used by generated scripts without publishing it in keeper's command index. The command tree for completion should be built from `SUBCOMMANDS` and `SUBCOMMAND_META.verbs`, so top-level commands and known second-level verbs share the same metadata as `keeper --help --json`.

The visible surface is `keeper completions bash`, `keeper completions zsh`, and `keeper completions fish`. The generated scripts may call the hidden responder internally, but `keeper --help --json` lists only public commands.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/keeper.ts:70 — `SUBCOMMAND_META` carries summaries and known two-level verb names.
- cli/keeper.ts:246 — the help index is intentionally flat and envelope-exempt.
- cli/keeper.ts:261 — command-index construction should include `completions` but not the hidden responder.
- test/keeper-cli.test.ts:287 — tests already assert two-level verb metadata for plan, prompt, agent, bus, and autopilot.

**Optional** (reference as needed):
- package.json:19 — the default test script routes through `scripts/test-gate.ts`; new completion tests should stay in the fast suite.

### Risks

The completion responder is a real command path even when hidden from help. The dispatcher needs an explicit internal route for it so generated scripts work, while ordinary unknown command behavior stays unchanged for every other token.

### Test notes

Completion tests should call the generation/responder functions or the dispatch seam in-process. They must not require an interactive shell, a daemon socket, a LaunchAgent, or writes under the real home directory.

## Acceptance

- [ ] `keeper completions bash`, `keeper completions zsh`, and `keeper completions fish` emit non-empty Clerc-generated scripts and exit 0.
- [ ] The hidden completion responder suggests all public top-level commands and the known second-level verbs from `SUBCOMMAND_META.verbs`.
- [ ] `keeper --help --json` includes `completions` with a summary and excludes the hidden responder.
- [ ] Completion generation and responder tests run in the fast Bun test tier with no daemon, shell, or HOME side effects.

## Done summary

## Evidence
