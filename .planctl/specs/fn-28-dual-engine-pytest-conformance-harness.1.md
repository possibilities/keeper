## Description

**Size:** S
**Files:** planctl/store.py, README.md, AGENTS.md, tests/test_global_state.py (or a new focused test module)

### Approach

Add an env short-circuit to `now_iso()` modeled exactly on `get_actor`'s `PLANCTL_ACTOR` shape: when `PLANCTL_NOW` is set, validate it matches the `%Y-%m-%dT%H:%M:%S.%fZ` format exactly and return it verbatim; malformed values are a hard error (clear message, non-zero exit) — never a silent wall-clock fallback; unset keeps today's `datetime.now(UTC)` behavior unchanged. Document the variable in the README and AGENTS.md env-var lists as a present-tense pinned cross-implementation contract ("overrides the clock source for all timestamp stamping; any conforming implementation must honor it") — one-liner entries following the existing `PLANCTL_ACTOR` pattern. No backward-facing prose anywhere.

### Investigation targets

**Required** (read before coding):
- planctl/store.py:230-261 — `get_actor`, the env-seam shape to mirror
- planctl/store.py:264-277 — `now_iso`, the seam site and the exact format docstring

**Optional** (reference as needed):
- README.md:99-102 — existing env-var list entry style
- AGENTS.md:101-102 — agent-facing env-var list

### Risks

Contract ambiguity defeats the seam's purpose — the format check must be strict (exact strptime round-trip, not "looks ISO-ish"), because the future Bun implementation will be held to the identical contract.

### Test notes

Unit-level: set/unset/malformed cases on `now_iso` directly. Boundary-level: drive a timestamp-writing verb via the test invoker with `PLANCTL_NOW` in the env and assert the stamped field equals the frozen value — this is the test the conformance engine will rely on transitively.

## Acceptance

- [ ] `now_iso()` returns `PLANCTL_NOW` verbatim when set and valid; raises a clear hard error when malformed; behaves exactly as before when unset
- [ ] A test pins the exact accepted format string so contract drift fails loudly
- [ ] README.md and AGENTS.md env-var lists carry a one-line `PLANCTL_NOW` entry, present-tense, no test-harness narration

## Done summary

## Evidence
