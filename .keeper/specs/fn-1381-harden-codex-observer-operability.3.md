## Description

**Size:** S
**Files:** src/agent/main.ts, docs/install.md, test/agent-run.test.ts

### Approach

The install docs document arming the codex-pool proof window via the run
wrapper (`keeper agent run pi --x-codex-pool-proof-window=arm ...`), but
the run wrapper's argument handling rejects that launcher flag — only the
direct `keeper agent pi --x-...` form works. The full 13-clause proof
re-run (standing item ~2026-07-26, when the exhausted alias's weekly
window resets) follows the documented form, so either the wrapper must
pass `--x-*` launcher flags through to the launched harness argv, or the
docs must be rewritten onto the direct form. Prefer the passthrough if it
is a bounded argv-handling fix (launcher flags are already a defined
namespace on the direct path); fall back to a docs-only correction if
passthrough would widen the wrapper's contract in ways its guards assume
closed. Reproduce the parse failure first and record the exact error in
the task evidence.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- docs/install.md:245-250 — the documented arming ritual
- src/agent/main.ts — run-verb argv parsing (locate the run handler and where unknown flags are rejected)

**Optional** (reference as needed):
- src/agent/main.ts:3040-3060 — where activate/verify consume launcher-adjacent flags (degraded-flag precedent for strict flag validation)

### Risks

The run wrapper deliberately validates argv tightly (wrapped-guard
interplay); a blanket passthrough must not create an injection or
contract-widening surface — keep it to the `--x-` namespace.

### Test notes

A focused test drives the run-verb argv path with the documented flag and
asserts it reaches the launch argv (or, on the docs-only outcome, the
docs and any agent-help text agree on the direct form).

## Acceptance

- [ ] The command form documented in the install docs for arming the proof window parses and arms without error
- [ ] Docs and CLI help agree on exactly one canonical arming form
- [ ] Focused tests covering the chosen fix pass

## Done summary
Consumed the codex-pool proof-window launcher flag before generic run-arg parsing so keeper agent run pi --x-codex-pool-proof-window=arm reaches the launch argv; restricted to a fresh managed Pi launch and reused the existing launch-scoped proof-window plumbing. Docs and CLI help now agree on one canonical arming form; added focused tests covering forwarding, rejection of arbitrary --x flags, and docs/help agreement.
## Evidence
