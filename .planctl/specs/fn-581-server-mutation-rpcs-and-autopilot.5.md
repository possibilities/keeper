## Description

**Size:** S
**Files:** CLAUDE.md, README.md, src/protocol.ts (header), src/collections.ts (header), src/db.ts (header), scripts/autopilot.ts (header if not finalized in Task .4)

### Approach

Sweep all docs and source-file header docstrings to reflect the lifted
read-only fence, the new RPC layer, and the approvals sidecar's exclusion
from the re-fold determinism guarantee. This task runs last in the epic
so docs describe what actually landed.

Five moves:
1. **CLAUDE.md** — rewrite the "No client mutations, no reactor, no write
   path through the socket" DO NOT bullet. The new contract: the socket
   carries BOTH `query` (subscribe / read) frames AND `rpc` (mutate)
   frames; the server-worker holds a writer connection used solely by RPC
   handlers; the read-only QUERY path is unchanged. Add a new DO NOT-shape
   bullet: "**The `approvals` sidecar is NOT a reducer projection**; it is
   human-driven state written by the `set_approval` RPC, excluded from the
   event-log re-fold determinism guarantee." Extend the "sole writer"
   invariant: "The hook is the sole writer of *hook* events; main is the
   sole writer of *synthetic* events; **the server-worker is the sole
   writer of RPC-driven sidecar tables** (currently: `approvals`)."
2. **README.md** — three sections. "What keeper is" lists `approvals` as
   a third collection and notes that RPCs are the mutation path on the
   same socket. "Example clients" describes the new autopilot render
   shape (epic blocks, close virtual row, pills) and adds an
   `approve.ts` entry. "Inspect" adds `SELECT * FROM approvals;` as an
   out-of-band inspection snippet alongside the existing jobs/epics
   queries.
3. **src/protocol.ts header** — extend the frame-shape catalog with `rpc`
   and `rpc_result`. Update the "Client → server" list to add `rpc`;
   update the "Server → client" list to add `rpc_result`. Note that
   `ErrorFrame` carries RPC error codes (`unknown_method`, `bad_params`,
   `rpc_failed`) in addition to the existing `bad_frame` / `unknown_type`
   set.
4. **src/collections.ts header** — drop "future collection" language; list
   the three registered descriptors (jobs, epics, approvals); note that
   `approvals` is a sidecar (not a reducer projection — humans drive it
   via the `set_approval` RPC). Cross-ref the injection invariant comment.
5. **src/db.ts header** — extend the schema-ownership list with `approvals`;
   note that the table is a sidecar (human-writable via RPC, NOT folded
   from events, excluded from the re-fold guarantee).

Cross-check that the `scripts/autopilot.ts` header docstring (updated in
Task .4) is internally consistent with the new CLAUDE.md and README
language — if not, finalize the autopilot header here.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md (full file; ~150 lines) — the invariants section is the load-bearing edit
- README.md ("What keeper is", "Example clients", "Inspect" sections — gap analysis pointed at lines 49-64, 205-234, 331-363)
- src/collections.ts:1-22 — header docstring
- src/db.ts:1-19 — header docstring
- src/protocol.ts:1-58 — header docstring
- scripts/autopilot.ts:1-129 — header docstring (cross-check after Task .4)

### Risks

- **CLAUDE.md is the source of truth.** An invariant rewrite that doesn't accurately reflect the landed code creates worse drift than no rewrite at all. Read each invariant aloud against the actual server-worker / db.ts / collections.ts state before editing.
- **README inconsistencies.** The three sections are likely cross-referenced inside the file; check that adding `approvals` everywhere it should appear is complete.

### Test notes

No code changes, no unit tests. Run `bun test` to confirm nothing regressed
(no test files import these docstrings, but check that no example block in
a docstring became stale-and-mismatched with the code shape). Manual
read-through pass for accuracy.

## Acceptance

- [ ] CLAUDE.md: the "No client mutations" bullet rewritten to reflect the RPC layer; the sole-writer invariant extended to call out the server-worker as the writer of RPC-driven sidecar tables; a new bullet documents the approvals sidecar's re-fold exclusion
- [ ] README.md: "What keeper is" lists approvals as a third collection and mentions RPCs as the mutation path; "Example clients" describes the new autopilot render shape and adds an `approve.ts` entry; "Inspect" adds a `SELECT * FROM approvals;` snippet
- [ ] src/protocol.ts header: `rpc` and `rpc_result` listed in the frame catalog; new RPC error codes called out
- [ ] src/collections.ts header: jobs/epics/approvals listed; approvals' sidecar character noted
- [ ] src/db.ts header: approvals added to the schema-ownership list with a sidecar note
- [ ] scripts/autopilot.ts header consistent with CLAUDE.md / README language (finalized here if not in Task .4)
- [ ] `bun test` passes with no regressions

## Done summary

## Evidence
