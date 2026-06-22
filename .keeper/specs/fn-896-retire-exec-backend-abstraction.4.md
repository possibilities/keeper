## Description

**Size:** S
**Files:** docs/exec-backend.md, README.md, plugins/keeper/skills/dispatch/SKILL.md, CLAUDE.md

Bring docs to the direct-binding reality and run the mandatory full gate.

### Approach

- **Retire docs/exec-backend.md** — delete the file (it documents the removed abstraction; the module is comment-documented + README covers the shape). Remove any cross-references to it.
- **README** — `## Config`: delete the `exec_backend` bullet, de-qualify the `agentwrap_path` bullet (now unconditional), fix the YAML example + the fallback sentence. `## Architecture`: rewrite the `ExecBackend`/`resolveExecBackend`/two-backend prose (the :2680-2691 paragraph + the :994/:1313-1314/:1337/:2275/:2716/:2777/:2842 mentions) to "keeper launches via agentwrap; tmux is used directly for pane ops + restore replay". Forward-facing only (no change-history).
- **dispatch SKILL.md:22** — "via whatever exec_backend is configured — tmux or agentwrap" → "via agentwrap".
- **CLAUDE.md:144** — keep the hook import-allowlist entry accurate (exec-backend.ts stays as the dep-free `execBackendEnvMeta` provider).
- **Full gate:** `bun run test:full` green (this epic touched daemon/worker/db/exec/dispatch — the fast tier does not cover them). Confirm the byte-pinned cross-repo fixture still passes (drift-guards unmoved).

### Investigation targets

**Required:**
- docs/exec-backend.md (whole file — retire); README.md `## Config` (~343-391) + the `## Architecture` exec-backend mentions; plugins/keeper/skills/dispatch/SKILL.md:22; CLAUDE.md:144.
- test/fixtures/agentwrap-launch-stdout.jsonl + its consuming fixture test — confirm green (drift-guards intact).

### Risks

- docs/exec-backend.md + README overlap fn-887/fn-889 (rebase if they land first).
- Forward-facing only — state current behavior, never "was removed in fn-X".

### Test notes

`bun run test:full` must be green. `grep -rnE 'ExecBackend|resolveExecBackend' docs/ README.md` returns nothing.

## Acceptance

- [ ] docs/exec-backend.md retired; README config + architecture, dispatch SKILL.md, and CLAUDE.md:144 reflect the direct-binding reality (forward-facing).
- [ ] The byte-pinned cross-repo fixture passes (drift-guards unmoved).
- [ ] `bun run test:full` green.

## Done summary
Retired docs/exec-backend.md and rewrote README Config + Architecture and dispatch SKILL.md to the direct-binding reality: keeper launches via agentwrap (sole boot-validated transport); tmux -f /dev/null is used directly for pane ops + restore replay. Byte-pinned cross-repo fixture intact; bun run test:full green.
## Evidence
