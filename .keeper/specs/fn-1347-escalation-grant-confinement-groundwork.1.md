## Description

**Size:** M
**Files:** src/grant-leaf.ts, plugins/keeper/plugin/hooks/grant-guard.ts, plugins/keeper/plugin/hooks/escalation-guard.ts, plugins/keeper/hooks/hooks.json, test/grant-guard.test.ts, test/escalation-guard.test.ts, CLAUDE.md, README.md

### Approach

Create `src/grant-leaf.ts` as a dep-free (node:* only, hook-importable) module owning the grant contract: a versioned leaf schema carrying parent job id, exact agent_type, incident id plus its fencing identities (attempt id / instance event id, per the incident-fenced-clear discipline), writable root, role, expiry, and a daemon-minted monotonic fencing token; a single leaf-path derivation function shared by every consumer; an owner-private writer (0o700 directory under the system-temp roots, fresh lexical leaf per write) and a validating reader with anti-TOCTOU fstat checks returning typed verdicts (valid / absent / expired / tuple-mismatch / malformed). Extend the leaf primitive already proven in wrapped-guard rather than inventing a new one.

Replace the env-keyed escalation-guard with a new `grant-guard` PreToolUse hook keyed on the hook payload's subagent identity: when the payload's agent_type names one of the four escalation agents (merge-resolver, deconflicter, unblocker, repairer), ENFORCE fail-closed — every mutating tool call (Bash write-vectors, Edit/Write/MultiEdit) requires a valid exact-tuple grant whose writable root covers the target and whose role admits the operation (unblocker: no source writes at all; merge-resolver/deconflicter: write within the granted checkout; repairer: write within the granted shared-checkout root). Protected paths (`.git/config`, credentials, hook/MCP config) are denied even under a valid grant. Any other agent_type, and top-level calls without agent identity, are outside jurisdiction — inert. Deny via the permissionDecision envelope, always exit 0; internal errors while in jurisdiction deny (fail closed). FIRST step before coding the guard: verify from recorded events-log rows and the branch-guard/wrapped-guard keying exactly which payload fields carry agent_id/agent_type for Bash AND for Edit/Write calls; if edit-tool payloads lack a usable identity, stop and surface as a blocked design question.

Bookkeeping in the same change: hooks.json swaps the escalation-guard registration for grant-guard with a rewritten load-bearing description; CLAUDE.md's hook-list clause and dep-free import list update to name grant-guard and the grant-leaf module (net shrink — the lint gates stay green); README's escalation-guard paragraph is rewritten for the grant guard.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/plugin/hooks/escalation-guard.ts — the skeleton to replace: pure predicate + decision ladder split, three-state jurisdiction, deny-envelope shape, bash lexer for bypass vectors (heredoc, -c, redirect, tee, command substitution, env-runner)
- plugins/keeper/plugin/hooks/wrapped-guard.ts:273-1275 — the owner-private leaf write/read primitive (SYSTEM_TMP_ROOTS, 0o700, fstat nlink/dev/ino checks) to extend
- plugins/keeper/plugin/hooks/branch-guard.ts:254-268 — how a guard keys on payload agent_id/agent_type
- test/escalation-guard.test.ts — the denial truth-table template to mirror
- plugins/keeper/hooks/hooks.json — registration + description conventions

**Optional** (reference as needed):
- src/derivers.ts, src/dispatch-failure-key.ts — dep-free ref/key helpers hooks may import
- src/exec-backend.ts:1411 — the empty KEEPER_ESCALATION_ROLE carrier this replaces (carrier itself retires in the retirement epic)

### Risks

- Hook payload identity semantics for edit tools are load-bearing and unverified — hence the mandatory first verification step with a stop-and-surface fallback
- The guard must not regress the always-exit-0 discipline: a throwing guard can fail-close an entire session

### Test notes

Denial tests FIRST, pure and in-process per the escalation-guard truth-table pattern: every bypass form, three-state jurisdiction, fail-closed-in-jurisdiction inversion, envelope shape, plus grant-leaf reader verdicts (valid/absent/expired/mismatch/malformed/TOCTOU) over synthetic leafs in a sandboxed tmpdir. Run via explicit named paths, never bare `bun test`.

## Acceptance

- [ ] A dep-free grant-leaf module exposes leaf write, leaf-path derivation, and validating read with typed verdicts, and is importable from hooks without touching bun:sqlite or db helpers
- [ ] Escalation-agent-typed subagent calls are denied without a grant and allowed under an exact-tuple grant, with protected paths still denied and role limits enforced
- [ ] Non-escalation subagents and identity-less top-level calls pass through untouched
- [ ] The escalation-guard hook and its registration are gone; grant-guard is registered with an accurate description; CLAUDE.md and README describe the new guard; lint gates green
- [ ] The new denial truth-table suite and the updated sibling guard suites pass via named test gates

## Done summary
Shipped escalation grant confinement groundwork: dep-free src/grant-leaf.ts (versioned owner-private grant leaf, shared path derivation, atomic writer, anti-TOCTOU fstat reader with valid/absent/expired/tuple-mismatch/malformed verdicts, grantCoversWrite override + isGrantProtectedPath); payload-identity-keyed grant-guard PreToolUse hook (Bash + edit tools) confining the four escalation agents' mutations to a validated exact-tuple unexpired grant covering the target, unblocker diagnosis-only, protected paths surviving grants, CVE-hardened Bash lexer carried forward. wrong-tree-guard and wrapped-guard honor exact grants via an injected override without weakening postures. Retired the env-keyed escalation-guard + test; updated hooks.json, CLAUDE.md. Verified from recorded events that Edit/Write payloads carry agent_type/agent_id in subagent context.
## Evidence
