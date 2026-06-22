## Description

**Size:** S
**Files:** test/tmux-launch-stripped-env.test.ts, CLAUDE.md, src/dispatch.ts

The net-new real-tmux verification harness (no precedent in the repo — every
existing tmux test stubs `runTmuxCommandFn`) that reproduces keeperd's
environment and proves the two hard blockers are fixed, plus a final
docs-consistency pass over the whole patched surface.

### Approach

- **Real-tmux test:** spawn `agentwrap` under `env -i` with a minimal PATH (`/opt/homebrew/bin:/usr/bin:/bin`) and NO locale vars, targeting a dedicated scratch socket `--agentwrap-tmux-L awtest-<pid>` and `--agentwrap-tmux-detached`. Assert: (1) [Patch A] the printed JSON parses correctly under the C-locale-inducing stripped env (the `\x01` delimiter + locale default both exercised); (2) [Patch B] the JSON returns within ~1s without `--wait-for-stop`. Gate the whole file on `which tmux` (skip when absent so non-tmux CI stays green). Teardown ALWAYS runs `tmux -L awtest-<pid> kill-server` so the human's live server is never touched.
- **Docs consistency:** holistic pass now that all flags/codes/schema have landed — revise (not append) the CLAUDE.md / AGENTS.md `## tmux transport` section (~33-54) to the final flag list, JSON schema, exit-code taxonomy, env-forwarding, timeout, abs-binary, locale, and GC behavior; confirm `AGENTWRAP_HELP` (src/dispatch.ts ~57-95) lists `--agentwrap-tmux-env` and `--no-artifacts` at column alignment. Forward-facing only (state current behavior, no change-history).

### Investigation targets

**Required:**
- test/_main-harness.ts — the existing harness (for contrast; this test does NOT use it — it spawns a real subprocess).
- test/tmux-launch.test.ts — existing stubbed patterns + `parseJsonOutput`.
- CLAUDE.md:33-54 — `## tmux transport` section to revise.
- src/dispatch.ts:57-95 — `AGENTWRAP_HELP` to reconcile.

**Optional:**
- The stripped-env reproduction is already proven manually: a C-locale `tmux -L scratch new-window -F '...\t...'` sanitizes tabs to `_`; under `\x01` + locale default it parses.

### Risks

- Flakiness / host coupling: the test MUST use a unique per-pid scratch socket and always kill-server in teardown (even on assertion failure) so it never leaks tmux servers or touches the live one.
- CI without tmux: the `which tmux` skip-gate keeps CI green; note in the test that it is local/tmux-host best-effort.

### Test notes

This task IS the test. Run it locally with tmux present and confirm it passes and leaves no `awtest-*` socket behind (`tmux -L awtest-<pid> ls` errors after teardown).

## Acceptance

- [ ] A `which tmux`-gated real-tmux test spawns agentwrap under `env -i` on a scratch `-L` socket and asserts the JSON parses (Patch A) and returns < ~1s without `--wait-for-stop` (Patch B).
- [ ] Teardown always kill-servers the scratch socket (even on failure); no `awtest-*` server leaks; the human's live tmux is untouched.
- [ ] CLAUDE.md/AGENTS.md `## tmux transport` and `AGENTWRAP_HELP` reflect the final landed flags, exit codes, and JSON schema (forward-facing, revised not appended).
- [ ] `bun lint && bun typecheck && bun test` green.

## Done summary
Added the real-tmux stripped-env verification harness (test/tmux-launch-stripped-env.test.ts) that spawns agentwrap under env -i on a per-pid scratch socket, proving the immediate launch JSON parses under C-locale and returns <~1s without --wait-for-stop. Docs (CLAUDE.md tmux section, AGENTWRAP_HELP) already reflected the final flags/codes/schema from predecessor commits; no revision needed.
## Evidence
