## Overview

Remove the `keeper bus chat broadcast` (fan-to-all) capability from the Agent
Bus entirely. Agents reach for broadcast to spray the whole fleet when a
directed send fails — routing around the failure instead of surfacing it —
which is unwanted. Stripping the CLI verb, the server publish branch, the
null-target fan-to-all primitive, and all advice removes the temptation at the
source. Directed `chat send` and the offline-planner `keeper bus wake` path are
untouched; end state is a bus that only does directed, honest, self-reporting
sends.

## Quick commands

- `keeper bus chat broadcast hi` — must fail with an unknown-chat-verb usage error (exit 1).
- `keeper bus chat send <peer> hi` — directed send still works (delivered / not_connected / unknown_target …).
- `bun run test:full` — root suite incl. the bus integration tier.
- `cd plugins/plan && bun test` — covers the work.md.tmpl advice edit.

## Acceptance

- [ ] The broadcast verb, server publish branch, and null-target fan-to-all primitive are gone; directed send + wake are unchanged.
- [ ] All broadcast advice (CLI help, bus skill, CLAUDE.md, README.md, plan work template) is stripped, forward-facing only.
- [ ] No schema/SCHEMA_VERSION change; the `event = 'send'` wake filter is preserved.
- [ ] Both the root and `plugins/plan` test suites pass; lands as one atomic commit.

## Early proof point

Task that proves the approach: `.1` — narrowing the publish `event` union to
`"send"` FIRST makes `tsc` enumerate every broadcast reference, proving the
strip is total before any case arm is deleted. If it fails (a stray reference
can't be cleanly removed): surface the tsc list and reassess whether any
non-broadcast caller depended on the variant.

## References

- Agent Bus architecture: README.md `## Architecture` (the thirteenth-worker bus relay paragraph ~3190).
- fn-921 `send_only:true` register invariant (CLAUDE.md ~47) — preserved; it governs directed sends.
- Overlap (advice-file conflict-avoidance, NOT a code dependency): fn-934 and fn-936 also edit CLAUDE.md / README.md. Wired as epic deps to serialize the doc edits under autopilot; remove with `keeper plan epic rm-dep` to run concurrently.

## Docs gaps

- **plugins/keeper/skills/bus/SKILL.md**: prune the broadcast description, the example block, and the "Broadcast is NOT a delivery fallback" guard (the temptation is gone with the verb).
- **CLAUDE.md / README.md / cli/keeper.ts**: one-line broadcast prunes (the strip task owns these inline).
- **plugins/plan/template/skills/work.md.tmpl**: remove the broadcast tombstone in the `/work` Phase-2c fallback bullet (forward rule stays).
