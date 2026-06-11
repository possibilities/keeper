## Description

**Size:** M
**Files:** src/restore-worker.ts, scripts/restore-agents.ts, README.md, docs/exec-backend.md, test/restore-worker.test.ts, test/restore-agents.test.ts

### Approach

Restore expansion: bump `RESTORE_SCHEMA_VERSION` 2→3 (side-file schema,
restore-worker.ts:121 — independent of DB SCHEMA_VERSION, which does NOT move).
Each session bucket gains a `backend` field stamped from the bucketed jobs'
`backend_exec_type` (a session name is backend-unique in practice; if a mixed
bucket ever occurs, split the bucket key, but do not engineer for it beyond an
assert). Reader precedence: a v2/legacy file or a bucket without `backend` reads
as `zellij`. scripts/restore-agents.ts drops the hardcoded `createZellijBackend`
import (:53) and routes each bucket's `ensureLaunched` through
`resolveExecBackend({ backendType: bucket.backend })`; NULL/unknown → skip the
bucket with a stderr note, never default-launch into the wrong multiplexer.
De-zellijify the help text and JSDoc ("original zellij session" → backend-neutral).

Docs sweep (per docs-gap-scout): README config section (drop zellij_session +
autoclose_windows, add exec_backend), ExecBackend prose ("Zellij is the only
backend" passage + the reap paragraph), restore prose (per-bucket backend type +
the v2→v3 framing "(no DB SCHEMA_VERSION bump — only the side-file's own
RESTORE_SCHEMA_VERSION bumps 2→3)"), hook env table (tmux row). docs/exec-backend.md:
lead/factory examples cover both backends, prune reapSurfaces sections, collapse
the "Extending to a new backend" how-to, update constants. Keep README's dense
inline-reference style.

Close with the epic-level verification: `bun run test:full`, plus the sandbox
smoke from the epic Quick commands (scratch KEEPER_CONFIG with `exec_backend: tmux`
+ `tmux -L keeper-smoke` server; verify a dispatched window appears with
remain-on-exit set and coords land in the sandbox DB). The real config flip stays
with the human.

### Investigation targets

**Required** (read before coding):
- src/restore-worker.ts:121-266 — RESTORE_SCHEMA_VERSION + tier/bucket builders (NULL-session jobs are omitted by design — accepted, do not backfill)
- scripts/restore-agents.ts:53,90,326,707 — backend import, schema whitelist, the ensureLaunched binding to reroute
- test/restore-agents.test.ts — classifySchemaVersion + applyRestore test shapes to extend

**Optional** (reference as needed):
- README.md config + restore + ExecBackend sections (docs-gap-scout line refs: ~305-343, ~2167-2219, ~2229-2277, ~53-60/1678-1702)
- docs/exec-backend.md:1-45, 101-108, 194-240, 271-287

### Risks

- Forward-compat: restore-agents refuses FUTURE schema versions — bumping to 3 means an OLD restore-agents binary refuses a new file (correct, by design); assert the v3-written/v2-read matrix in tests.
- The smoke test must use sandboxed paths (KEEPER_CONFIG + scratch -L socket + sandbox DB) — never the live daemon's DB or the default tmux server.

### Test notes

Extend restore-worker tests (bucket carries backend; v3 shape) and restore-agents
tests (v2 legacy reads as zellij; per-bucket routing dispatches the right backend
via a capturing fake; unknown-backend bucket skips). Docs changes need no tests.
`bun run test:full` mandatory; record the sandbox smoke output in Evidence.

## Acceptance

- [ ] restore.json v3 buckets carry `backend`; v2 files restore as zellij; restore-agents routes per bucket and skips unknown backends with a note
- [ ] README + docs/exec-backend.md carry no stale zellij-only/reap/autoclose/zellij_session prose
- [ ] Sandbox smoke: with `exec_backend: tmux`, a dispatch lands in the scratch tmux server with remain-on-exit set and coords in the sandbox DB
- [ ] `bun run test:full` green

## Done summary
restore.json bumped to schema v3: each session bucket carries a backend tag (default zellij), restore-agents routes per-bucket via resolveExecBackend and skips unknown backends with a note; v2/legacy files read as zellij. README + docs/exec-backend.md de-zellijified (exec_backend config, tmux -f /dev/null hook coords, reap/autoclose prose removed). Full suite green; tmux sandbox smoke verified remain-on-exit + KEEPER_TMUX_SESSION coord.
## Evidence
