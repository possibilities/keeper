## Description

**Size:** M
**Files:** package.json, bun.lock, cli/keeper.ts, test/keeper-cli.test.ts

### Approach

Add exact `@clerc/core` and `@clerc/plugin-completions` runtime dependencies and introduce a small Clerc adapter for keeper's top-level command tree. The adapter registers each public `SUBCOMMANDS` entry as a proxy command that stops parsing immediately after the command path and forwards the untouched residual argv to the existing lazy handler map. The current top-level special cases remain pinned: bare invocation, unknown subcommand, version, human help, and machine-readable `--help --json` keep their observable stdout/stderr and exit-code contracts.

`keeper plan` and `keeper prompt` remain in-process pass-through wrappers; the framework must not parse or normalize their leaf args. Two-level commands may be registered in the command tree for future completion metadata, but their handlers forward the verb token exactly as the current dispatcher does.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- package.json:6 — `bin` points `keeper` at `cli/keeper.ts`; dependency placement must keep the Bun entrypoint unchanged.
- cli/keeper.ts:22 — `SUBCOMMANDS` is the current public command source of truth.
- cli/keeper.ts:261 — `buildHelpIndex()` is the machine-readable help surface to preserve.
- cli/keeper.ts:328 — `dispatch()` owns the top-level stdout/stderr/exit contracts.
- cli/keeper.ts:376 — lazy handler imports keep cold-start costs localized.
- cli/plan.ts:22 — plan pass-through imports the plugin dispatcher directly.
- cli/prompt.ts:17 — prompt pass-through imports the plugin dispatcher directly.
- test/keeper-cli.test.ts:190 — registered subcommands must still route with residual argv intact.
- test/keeper-cli.test.ts:241 — `--help --json` shape is pinned by tests.

**Optional** (reference as needed):
- plugins/plan/src/cli.ts:666 — the plan plugin owns its own parser and unknown-verb behavior.
- plugins/prompt/src/cli.ts:96 — the prompt plugin owns its own parser.

### Risks

Clerc's parser must not consume unknown flags before leaf commands see them. Use the command `ignore` hook or equivalent proxy seam, and add a regression test where the residual argv begins with both flags and positionals.

### Test notes

Keep the existing `test/keeper-cli.test.ts` assertions green, and add targeted tests for the proxy residual forwarding edge cases introduced by Clerc.

## Acceptance

- [ ] `@clerc/core` and `@clerc/plugin-completions` are exact runtime dependencies and `bun.lock` is updated.
- [ ] Every public subcommand routes through a Clerc-backed proxy command while preserving the exact residual argv array passed to its existing handler.
- [ ] Bare invocation, unknown subcommand, `--help`, `-h`, `--version`, `-V`, and `--help --json` keep the current stdout/stderr and exit-code behavior.
- [ ] `keeper plan <args>` and `keeper prompt <args>` remain leaf-owned pass-throughs; Clerc never validates their verbs or flags.
- [ ] The keeper CLI test suite for top-level dispatch passes under Bun.

## Done summary

## Evidence
