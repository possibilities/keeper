## Description

**Size:** M
**Files:** src/agent/** (new — vendored 17 modules), cli/agent.ts (new), cli/keeper.ts, package.json, test/agent-*.test.ts (new), test/agent-*.slow.test.ts (new), scripts/test-real-git-allowlist.txt

### Approach

Vendor agentwrap's `src/*.ts` (17 modules) into `src/agent/` verbatim; add
`agentusage` to `package.json` as `file:../agentusage` (keeper's FIRST `file:`
dep — `~/code/agentusage` is a confirmed standalone sibling repo). Add
`cli/agent.ts` mirroring `cli/autopilot.ts`'s multi-subverb shape (parseArgs →
positional `if` ladder over `claude|codex|pi|wait-for-stop|show-last-message` →
`die()` fallthrough). Register `agent` in `cli/keeper.ts`: append to
SUBCOMMANDS (~:22-45), USAGE (~:54-75), and the lazy handler map (~:157-185) as
`agent: async (argv)=>(await import("./agent")).main(argv)` — the lazy import
keeps cold-start cheap and MUST NOT transitively import `src/db.ts`. Carry the
WHOLE launcher (claude + codex + pi incl. `codex-session-index`, profile routing
/ `state-sharing`, interactive picker, cwd-confirm, `--agentwrap-no-confirm`,
`plugin_scan_dirs`). Keep the `--agentwrap-*` flag names + `AGENTWRAP_*` env +
the agentwrap state-dir path VERBATIM (rename deferred to a later mechanical
pass — avoids breaking in-flight handles). Port agentwrap's tests into `test/`;
pin the byte contract (native argv + launch-JSON) so a later repoint can prove
byte-identity.

### Investigation targets

**Required** (read before coding):
- cli/keeper.ts:22-45 (SUBCOMMANDS), :54-75 (USAGE), :157-185 (lazy handler map) — the three registration sites
- cli/autopilot.ts:724-854 — canonical multi-subverb `main()` to mirror
- ~/code/agentwrap/bin/agentwrap.ts → src/main.ts (entry), src/dispatch.ts (`splitSubcommand`), and all 17 src/*.ts — vendor source
- ~/code/agentwrap/package.json — confirm the only runtime dep is `file:../agentusage` (+ biome/bun-types dev deps)
- test/helpers/sandbox-env.ts (sandboxEnv eight-state), test/helpers/retry-until.ts, scripts/lint-no-real-git.ts + scripts/test-real-git-allowlist.txt

**Optional** (reference as needed):
- src/pair-command.ts:632 resolvePairAgentwrapPath — the db.ts-free cold-start precedent

### Risks

- Cold-start contamination: the lazy `import("./agent")` must NOT drag `src/db.ts` (the 6.5k-line bun:sqlite module). Verify `keeper plan` / `keeper status` cold-start is unaffected.
- Test assimilation: vendored tests that spawn real tmux / agents / FFI must use the injectable `spawn` seams or be named `*.slow.test.ts` + added to the allowlist AND the fast-tier ignore list; `bun run test:hygiene` must stay green.
- `agentusage` `file:` dep is novel (keeper's first) — confirm `bun install` resolves it from the sibling repo and the lockfile is sane.

### Test notes

`keeper agent claude --help` answers from the folded code; a byte-pin test
asserts `keeper agent claude …` builds the same native argv agentwrap did.
Real-tmux launch tests → `*.slow.test.ts`. Run `bun run test:hygiene` +
`bun run test:full`.

## Acceptance

- [ ] `keeper agent claude|codex|pi` runs the folded launcher standalone (foreground), forwarding non-`--agentwrap-*` args verbatim
- [ ] `agentusage` added as `file:../agentusage`; `bun install` clean
- [ ] `cli/keeper.ts` registers `agent` via lazy import; `keeper plan` / `keeper status` cold-start shows no new `src/db.ts` import on the common path
- [ ] vendored tests pass under `bun run test:full`; `bun run test:hygiene` green; real-process tests are `*.slow.test.ts` + allowlisted
- [ ] byte-pin test asserts `keeper agent` native argv == retired agentwrap argv

## Done summary

## Evidence
