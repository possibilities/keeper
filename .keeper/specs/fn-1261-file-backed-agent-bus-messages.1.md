## Description

**Size:** S
**Files:** src/bus-artifact.ts, test/bus-artifact.test.ts

### Approach

Introduce the content-independent claim-check contract shared by the chat sender, watcher, and bus worker. A versioned artifact reference carries an opaque collision-safe id, UTF-8 byte length, and SHA-256; the original body is atomically written without headers beneath a private root derived from the existing bus state path, so no new unsandboxed state class appears. Resolution accepts only supported typed references, confines ids beneath that root, verifies immutable regular-file content, and returns a trusted display path without executing it.

The module must expose pure encode/decode/validation decisions plus thin filesystem operations for create, verify, remove, and bounded orphan enumeration. Reuse the repository's atomic-write and private-permission conventions rather than duplicating ad hoc receiver spill behavior. The body cap remains one mebibyte.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/db.ts:7161 — existing atomic same-directory write helper and permission contract.
- src/note-store.ts:169 — private 0700 directory and 0600 file conventions.
- src/daemon.ts:8018 — realpath/root confinement precedent for file references received over a local wire.
- cli/handoff.ts:184 — same-host spill-before-UDS-send pattern.

**Optional** (reference as needed):
- src/bus-db.ts:420 — message retention and queued age-immunity semantics the artifact API must support.
- test/helpers/sandbox-env.ts:139 — existing bus state sandbox variables; derive the artifact root from these rather than adding ambient host state.

### Risks

Symlink and traversal mistakes turn a peer reference into an arbitrary-file read or delete. Artifact creation must be complete before publication, collision-safe under concurrent senders, and private from the first visible inode. Orphan enumeration must be bounded rather than a whole-directory scan.

### Test notes

Use temp roots and pure seams. Cover permissions, atomic visibility, opaque-id validation, traversal and symlink rejection, size cap, length/digest mismatch, missing/non-regular files, collision behavior, exact body bytes, and bounded orphan pages.

### Detailed phases

1. Define the versioned reference and trusted resolved-artifact types.
2. Implement private root creation, atomic artifact publication, confined verification, and removal.
3. Add bounded orphan enumeration primitives and exhaustive fast tests.

### Alternatives

A raw absolute path is simpler but cannot be safely distinguished from arbitrary peer input. Receiver-side spilling avoids sender storage but leaves content on the bus and changes behavior by message size.

### Non-functional targets

Artifact operations are bounded by the one-mebibyte message cap; no operation scans an unbounded directory or changes permissions outside Keeper-owned state. Files are 0600 and their owned root is 0700.

### Rollout

This task adds inert primitives only. No sender emits references until task 2, and no lifecycle row depends on them until task 3.

## Acceptance

- [ ] A supported artifact reference round-trips an opaque id, byte length, and SHA-256 without containing message content.
- [ ] Publishing an artifact creates an immutable 0600 regular file beneath a 0700 Keeper-owned bus root, atomically complete before the function succeeds.
- [ ] Reference resolution rejects unsupported versions, malformed ids, traversal, symlink escape, missing/non-regular files, oversize bodies, and length or digest mismatch without exposing an arbitrary path.
- [ ] Artifact roots derive from the existing sandboxable bus state location and do not introduce writes outside it.
- [ ] Orphan enumeration and deletion primitives are explicitly bounded and fast tests cover their page boundaries and failure-soft behavior.

## Done summary
Added src/bus-artifact.ts: the versioned, typed Bus message artifact claim-check contract (pure encode/decode/validation plus confined publish/resolve/remove/list filesystem ops) with exhaustive fast tests in test/bus-artifact.test.ts covering round-trip, confinement, integrity, and bounded orphan enumeration. Inert primitives only.
## Evidence
