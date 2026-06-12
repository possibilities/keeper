## Description

**Size:** M
**Files:** src/store.ts, src/flock.ts (new), test/ additions

### Approach

The write-side spine. atomicWrite/atomicWriteJson in src/store.ts mirroring Python exactly: tmp file in the target's directory (pid+random suffix), write, fsync, rename, parent-dir fsync, unlink tmp on any throw; JSON shape = recursive key sort at all depths + indent 2 + single trailing newline (JSON.stringify does not sort — implement a recursive sorter). Every atomic write records a touched-path: CLAUDE_CODE_SESSION_ID fail-OPEN (silent skip), walk up at most 20 levels for .planctl/, write one <uuid4hex>.txt under .planctl/state/sessions/<sid>/touched/ containing the repo-relative POSIX path + newline, all exceptions swallowed. src/flock.ts: bun:ffi dlopen by platform candidate names (darwin libc.dylib, linux libc.so.6), flock(fd, op) with LOCK_EX=2/LOCK_NB=4/LOCK_UN=8, fds from node:fs openSync held in scope for the lock lifetime, LOCK_UN before closeSync, EWOULDBLOCK 35/11 by platform. Extend LocalFileStateStore with saveRuntime and lockTask (LOCK_EX on .planctl/state/locks/<task_id>.lock, mkdir parents, unlock in finally). Tests in bun:test: golden cross-serializer parity (spawn python3 -c to serialize a shared nested fixture incl. unicode and deep nesting with json.dumps(indent=2, sort_keys=True), byte-compare); flock interop BOTH directions with a real python3 peer using marker-file sync and LOCK_NB EWOULDBLOCK assertions, no sleeps; atomic-write crash-path (tmp unlinked on throw).

### Investigation targets

**Required** (read before coding):
- planctl/_util.py:60-84 and planctl/store.py:99-116 — the writer spec incl. sort_keys
- planctl/store.py:16-96 — touched-log mechanics and fail-open polarity
- planctl/store.py:207-219 — lock_task contract
- src/store.ts — the landed read side being extended; module-header comment discipline

**Optional** (reference as needed):
- test/src-store.test.ts — bun:test idioms (tmp dirs, env save/restore)

### Risks

bun:ffi inside the compiled binary is the epic's novel surface — dlopen system libraries by name only (never embed); verify the flock units pass against dist/planctl-bun's runtime, not just bun-run. Bun.file fd handles are GC-hazardous — node:fs openSync only.

### Test notes

bun test green incl. interop and golden tests; lint/typecheck green; no Python file touched.

## Acceptance

- [ ] atomicWriteJson byte-identical to Python on the golden fixture (recursive sort, indent 2, trailing newline)
- [ ] Touched-log writes match Python layout and fail-open behavior
- [ ] lockTask takes a real flock(2); interop proven both directions against python3; EWOULDBLOCK constants per platform
- [ ] saveRuntime lands; tmp files never survive a failed write

## Done summary

## Evidence
