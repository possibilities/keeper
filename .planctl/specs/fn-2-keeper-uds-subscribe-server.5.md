## Description

**Size:** S
**Files:** CLAUDE.md, README.md, src/daemon.ts, plist/arthack.keeperd.plist

### Approach

Narrow the V1 fences to V2 reality. The constraint half that still holds — **no client mutations, no reactor, no write path through the socket** — is *narrowed, not deleted*. Run this task last so the docs describe the shipped shape.

1. **CLAUDE.md**:
   - **What this is**: re-version the intro — V1 was reducer-only; V2 adds a read-only UDS subscribe server worker (NDJSON-over-UDS) while the client write path stays forbidden.
   - **Directory layout**: add `src/server-worker.ts` (indented bullet matching `wake-worker.ts`'s style) and `src/protocol.ts`.
   - **Module entry points** table (`Module | Entry | Role`): add a row for `src/server-worker.ts`.
   - **DO NOT**: rewrite the "No UDS server / no RPC verbs" bullet → "No client mutations, no reactor, no write path through the socket. The server is read-only subscribe." Keep the no-write-path spirit.
   - **Event-sourcing invariants**: note that `applyPragmas` runs on the server worker's connection too, and that `data_version` polling (not `fs.watch`) is the server's change primitive as well.
   - Add a durable **Worker contract** subsection: `isMainThread` guard, own `openDb` connection, typed `{kind}`/`{type}` message protocol, supervisor-owned lifecycle, no in-process self-heal — and the two archetypes (sensor worker like wake-worker; subsystem worker like the server, which owns an external endpoint + its own state).
2. **README.md**:
   - "What keeper is NOT" / non-goals: narrow the "No RPC surface, no UDS server" bullet to the V2 version (no client mutations, no reactor, no write path).
   - Architecture: add the server worker as a second independent Worker thread (own readonly connection, `data_version` poll, NDJSON-over-UDS).
   - Install/verify: mention `KEEPER_SOCK` + the default socket path `~/.local/state/keeper/keeperd.sock`. Keep it minimal — there is no shipped client to demo.
3. **src/daemon.ts** top JSDoc: update the boot-sequence comment to document **both** workers and the crash policy (either worker's `error` → `fatalExit`).
4. **plist/arthack.keeperd.plist**: add a commented `KEEPER_SOCK` `EnvironmentVariables` note (the socket lands in `~/.local/state/keeper/`, same dir as `StandardOutPath`).
5. **AGENTS.md** is a symlink to CLAUDE.md — it tracks automatically; confirm, do not edit separately.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md — "What this is", "Directory layout", "Module entry points" table, "Event-sourcing invariants", "DO NOT" section
- README.md — "What keeper is NOT" non-goals, Architecture, Install/verify
- src/daemon.ts:1 — top JSDoc boot-sequence comment (currently names only the wake worker)
- plist/arthack.keeperd.plist — `EnvironmentVariables` / `StandardOutPath` location

**Optional** (reference as needed):
- AGENTS.md — confirm it still resolves to CLAUDE.md (no edit)

### Risks

- Don't delete the still-true constraints (no client mutations, no reactor, no write path) — narrow them. A future agent reading a half-deleted DO-NOT could think mutations are now allowed.
- Keep the module-entry-points table and layout accurate to the final module name (`src/server-worker.ts`).

### Test notes

Docs + one JSDoc comment; no runtime code changes. Confirm `AGENTS.md` still resolves to `CLAUDE.md`. Run `bun run lint`/`typecheck` to confirm the `daemon.ts` comment edit didn't break anything.

## Acceptance

- [ ] CLAUDE.md intro / layout / entry-points table / DO-NOT / invariants updated to V2, with a Worker contract subsection added
- [ ] README non-goals + architecture + install reflect the server worker and `KEEPER_SOCK`
- [ ] `src/daemon.ts` top JSDoc documents both workers + crash policy
- [ ] plist notes `KEEPER_SOCK`; `AGENTS.md` still tracks `CLAUDE.md` (symlink unbroken)
- [ ] Still-true constraints (no mutations / reactor / write-path) are narrowed, not deleted

## Done summary

## Evidence
