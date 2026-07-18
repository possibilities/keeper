## Description

**Size:** M
**Files:** src/server-worker.ts, src/rpc-handlers.ts, src/rpc-runtime.ts, test/rpc-handlers.test.ts, test/server-worker.test.ts

### Approach

Move shared RPC error constructors, replay/registrar/lookup contracts, and registry construction into a dependency-neutral runtime leaf while keeping the one mutable registry instance owned by the real server-role composition root. `rpc-handlers` installs into the supplied registry; duplicate or partial installation remains boot-fatal, all eight methods are installed before readiness, early requests cannot observe a partial registry, and existing server-worker exports may re-export the exact constructors rather than redeclare them.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/server-worker.ts:1620-1851 — handler types, ReplayBridge, errors, registries, registration, and test reset
- src/server-worker.ts:2107-2195 — registry dispatch and exact `instanceof` error mapping
- src/server-worker.ts:2547-2560 — duplicated eight-method boot-complete gate
- src/server-worker.ts:4059-4061,4624-4632 — role-qualified handler install and inert main-thread import
- src/rpc-handlers.ts:57-62,1035-1055 — reverse imports and explicit duplicate-fatal eight-method installation
- test/rpc-handlers.test.ts:1153-1178 — dependency-neutral validation and error mapping precedent

**Optional** (reference as needed):
- src/dispatch-command.ts:1-20,121-155 — discriminated neutral-leaf pattern
- test/server-worker.test.ts:1-70 — current server-worker test surface

### Risks

- Redeclared error classes break constructor identity while typecheck remains green
- Moving installation to import time or a shared singleton can activate handlers in non-server roles or leak state between in-process tests
- The eight installed methods and readiness gate can drift unless one authoritative inventory drives both

### Test notes

Pin empty plain import, once-only real-role installation, exact eight-method readiness, duplicate/partial-install failure, registry reset isolation, early-request exclusion, replay routing, and unchanged bad_params/slug_conflict/rpc_failed wire mapping.

## Acceptance

- [ ] No runtime import path exists from `rpc-handlers` back to `server-worker`, directly or through the new seam
- [ ] The real server-role root owns one registry instance and installs exactly the authoritative eight handlers before readiness; plain imports and other roles remain inert
- [ ] Duplicate or partial installation fails startup without exposing a partly ready server, and in-process tests can reset state deterministically
- [ ] Shared BadParamsError and SlugConflictError constructor identity, replay routing, validation, and response problem-code mapping remain unchanged
- [ ] Focused RPC-handler and server-worker tests plus typecheck pass

## Done summary

## Evidence
