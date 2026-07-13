## Description

**Size:** M
**Files:** plugins/keeper/plugin/hooks/escalation-guard.ts, test/escalation-guard.test.ts

### Approach

Extend `classifyExecutable`'s per-tool flag inspection so a marked diagnosis-only escalation role can no longer reach exec or file-write through an allowlisted read tool — mirroring the existing `find -exec` / `git grep -O` / `xargs -I` blocks (a per-tool blocklist arm placed BEFORE the `READ_UTILITIES` catch-all). Four changes:

- **`rg` arm** (before the `READ_UTILITIES` catch-all): deny `--pre`, `--pre-glob`, and `--hostname-bin` (ripgrep's per-file / hostname command-exec flags). Match each flag name EXACTLY after splitting a token on `=` (so `--pre=cmd` is caught as well as `--pre cmd`). ripgrep is clap-based and does NOT prefix-abbreviate, so do NOT copy `isOpenFilesInPagerAbbrev`'s abbreviation logic here. `--search-zip`/`-z` (fixed decompressor, not a caller-named command) is out of scope — note the deferral. Leave a comment that this is a per-tool blocklist inheriting the same future-exec-flag residual the `git grep` arm already accepts.
- **`find -fls`**: add `-fls` to `FIND_EXEC_PRIMARIES` (the one genuine GNU write-primitive gap — `-fprint`/`-fprint0`/`-fprintf` are already present). One-token add; the existing scan catches it anywhere. GNU-only, harmless on BSD find, protective on Linux workers.
- **`keeper dispatch` free-form gate**: inside the `exe === "keeper"` branch, when the subcommand is `dispatch`, deny if any token `startsWith("--prompt")` (catches `--prompt`, `--prompt=…`, `--prompt-file`, `--prompt-file=…`) — for ALL escalation roles (even a write-capable role has no reason to launch a free-form worker). PRESERVE the plan-form allow: `keeper dispatch work::…` / `close::…` (a positional plan key is not a free-form launch). Do not add short-flag handling — `DISPATCH_FLAGS` has no short alias and parseArgs rejects an unknown short before free-form is reached.
- **`botctl` audit**: `botctl` currently hits a zero-flag-inspection allow (the same shape `rg` had). Give it the same treatment — block any exec/write flag it exposes, or leave a comment documenting it has none.

Do NOT touch the `bun` classifier — fn-1281 owns its reconciliation and this epic depends on it. The guard stays dep-free node-only, always exit-0, fails CLOSED for a marked session, and denies via the `permissionDecision` envelope.

### Investigation targets

*Verify before relying — planner-verified at authoring time; the repo moves, and fn-1281 will have reshaped this file's `bun` handling by the time this runs.*

**Required:**
- plugins/keeper/plugin/hooks/escalation-guard.ts:574 — `classifyExecutable` dispatch (where the `rg` arm and the `dispatch` check land).
- plugins/keeper/plugin/hooks/escalation-guard.ts:194 + ~644 — `FIND_EXEC_PRIMARIES` and the `find` arm (the `-fls` add + the blocklist-arm template).
- plugins/keeper/plugin/hooks/escalation-guard.ts:498-540 — `gitReadSubcommandExecFlag` / `isOpenFilesInPagerAbbrev` (the read-tool flag-inspection pattern to mirror for `rg`, MINUS the abbreviation logic).
- plugins/keeper/plugin/hooks/escalation-guard.ts:~55 + ~581 + ~623 — `KEEPER_READ_SUBCOMMANDS`, the `exe === "keeper"` branch, and the `botctl` allow.
- cli/dispatch.ts:585-624 — confirms a positional is parsed as a plan key and free-form is reachable ONLY via `--prompt`/`--prompt-file` (no positional-prompt form).
- cli/descriptor.ts:~331 — `DISPATCH_FLAGS` (`--prompt`/`--prompt-file`, no short alias).
- test/escalation-guard.test.ts — table-driven allow/deny arrays, the F-marker finding convention, the reason-naming assertions (~290), and the existing allow-cases to NOT regress: `keeper dispatch work::…` (~41) and `git diff/log -O<orderfile>` (~88).

### Risks

- The `rg` blocklist inherits a future-exec-flag residual (a new ripgrep exec flag would pass) — comment it as a conscious choice, same as the `git grep` arm.
- Do NOT regress the `keeper dispatch work::…` or `git -O<orderfile>` allow-cases (the `-O` exec flag is grep-only).
- Every path stays exit-0 and fail-closed-for-a-marked-session; a throw must never disable the deny.

### Test notes

Add allow AND deny table cases with reason-naming assertions: deny `rg --pre x .`, `rg --pre=x .`, `rg --hostname-bin y .`, `find . -fls /tmp/x`, `keeper dispatch --prompt "x"`, `keeper dispatch --prompt-file /tmp/x`; allow `rg -n --json foo`, `keeper dispatch work::fn-1-x.3`, `git log -O<order>`. Fast `bun test` tier (pure predicate).

## Acceptance

- [ ] `rg --pre`/`--pre-glob`/`--hostname-bin` (space and `=` forms) are denied for a diagnosis role, while ordinary rg read flags remain allowed.
- [ ] `find -fls` is denied; `keeper dispatch --prompt`/`--prompt-file` (all forms) are denied for every escalation role while `keeper dispatch work::`/`close::` stay allowed.
- [ ] `botctl`'s flag surface is inspected (dangerous flags blocked) or explicitly documented as having none.
- [ ] Existing allow-cases (`keeper dispatch work::…`, `git -O<orderfile>`) still pass; the guard stays exit-0 and fail-closed-for-marked; new deny reasons name the offending flag.
- [ ] `bun test test/escalation-guard.test.ts` is green.

## Done summary

## Evidence
