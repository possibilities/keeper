## Overview

Final phase of the agentwrap launch migration: collapse the now-redundant
pluggable exec-backend abstraction. agentwrap is keeper's sole, direct launch
path (autopilot + manual dispatch); keeper uses tmux DIRECTLY for pane
operations (kill/list/rename/focus/close-classification) and for the crash-
recovery restore replay. The `ExecBackend` interface, `resolveExecBackend`, and
the `exec_backend` config TOGGLE are removed. agentwrap becomes a hard runtime
dependency (no tmux-launch fallback) — validated at boot.

## Quick commands

- `cd /Users/mike/code/keeper && bun test test/exec-backend.test.ts test/config.test.ts && bun run test:full`
- Prove the abstraction is gone: `! grep -rnE 'ExecBackend|resolveExecBackend|VALID_EXEC_BACKENDS' src/ cli/ | grep -v node_modules` (should match nothing except kept drift-guard comments)
- Boot check smoke: temporarily point `KEEPER_AGENTWRAP_PATH` at a missing file, start keeperd, confirm a prominent "agentwrap not found" boot warning naming the resolved path.

## Acceptance

- [ ] autopilot (`confirmRunning`) + manual `keeper dispatch` launch via the agentwrap path DIRECTLY — `resolveExecBackend` and the `ExecBackend` interface are deleted; nothing branches on a backend type.
- [ ] The `exec_backend` toggle (`VALID_EXEC_BACKENDS` + `execBackend` field/parse + its threading through daemon.ts/autopilot-worker.ts/cli/dispatch.ts) is removed; a stale `exec_backend:` in config is silently ignored (boot stays clean).
- [ ] KEPT and unchanged: `DEFAULT_EXEC_BACKEND` (the persisted `backend_exec_type` tag), `execBackendEnvMeta` (dep-free, hook-imported), the byte-pinned drift-guard comments + fixture, the `retryable` exit-code routing, the 30s agentwrap capture timeout, `agentwrap_path`/`resolveAgentwrapPath`, and `MANAGED_EXEC_SESSION`.
- [ ] The tmux PANE helpers + a SCOPED tmux restore-replay launch survive as direct seams; reaper/renamer/jobs/autopilot-probe/restore all still work (crash recovery revives orphaned agents).
- [ ] keeperd validates agentwrap presence at boot (logs the resolved absolute path; prominent warning if missing).
- [ ] docs/exec-backend.md retired; README/dispatch SKILL/CLAUDE.md/config-comment reflect the direct-binding reality; `bun run test:full` green.

## Early proof point

Task that proves the approach: `.2` (promote agentwrap launch + delete the
abstraction) — it compiles with the `ExecBackend` interface gone and the
autopilot/dispatch launching directly via agentwrap. If it fails: the extracted
kept-surface seams from `.1` are already in place, so the deletion can be re-tried
without destabilizing pane ops or restore.

## References

- KEPT invariants (do NOT remove): `DEFAULT_EXEC_BACKEND` is the persisted `backend_exec_type` schema tag (restore-worker.ts stamps it; the hook's `execBackendEnvMeta` returns it — keep it + keep that fn dep-free in exec-backend.ts). The KEEPER_TMUX_PANE carrier comment (exec-backend.ts:293) + the agentwrap CLI/exit-code contract block (:875-894) are byte-pinned cross-repo drift guards enforced by a fixture — keep verbatim, do not move (no file rename). The `retryable` split in confirmRunning (autopilot-worker.ts:1140-1162) and `AGENTWRAP_CAPTURE_TIMEOUT_MS=30s` are load-bearing.
- Restore replay (scripts/restore-agents.ts:601-603) replays a spec-less `claude --resume` argv — it KEEPS a direct tmux launch (this epic does not migrate restore to agentwrap; that is a deferred follow-up).
- The live `~/.config/keeper/config.yaml` `exec_backend` key is handled out-of-band by the operator post-landing (silently ignored once the code lands; not a repo file).
- Overlap awareness (rebase, NOT a blocking dep): fn-887 edits cli/dispatch.ts + autopilot-worker.ts + docs/exec-backend.md; fn-889 (codemod) edits daemon.ts + db.ts + README. Different functions — rebase if either lands first; this epic stays independent.

## Docs gaps

- **docs/exec-backend.md**: RETIRE (delete) — it documents the now-removed abstraction; the module is comment-documented and README covers the shape.
- **README.md `## Config` + `## Architecture`**: delete the `exec_backend` bullet + de-qualify `agentwrap_path`; rewrite the `ExecBackend`/`resolveExecBackend`/two-backend architecture prose to "launch via agentwrap, tmux for pane ops".
- **plugins/keeper/skills/dispatch/SKILL.md:22**: "via whatever exec_backend is configured" → "via agentwrap".
- **CLAUDE.md:144**: keep the hook import-allowlist entry accurate (exec-backend.ts stays, still provides the dep-free `execBackendEnvMeta`).

## Best practices

- **Delete in reverse-dependency order:** extract/preserve the kept surface (pane ops + restore replay) as non-interface seams FIRST (task .1, keeps compiling), then repoint the launch callers and delete the interface LAST (task .2) — let `tsc` surface every stale seam; no `any` stopgaps, no tombstone no-op impls.
- **agentwrap is now a HARD dep:** fail-fast at boot (spawnSync presence check in main(), pass PATH, log the resolved absolute path) rather than a per-launch ENOENT → never-bound-breaker spiral.
- **Shrink the test fakes:** several worker tests inject fakes implementing the FULL ExecBackend interface — shrink them to the kept pane-op subset so a stale broad fake can't structurally mask a real gap.
