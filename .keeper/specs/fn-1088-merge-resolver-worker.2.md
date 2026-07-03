## Description

**Size:** S
**Files:** scripts/ (scratch-conflict harness), plugins/keeper/skills/autopilot/SKILL.md, docs/

### Approach

Prove both branches end to end on a scratch epic (sandboxed state, real git in a temp repo,
manual-tier script — not the fast suite): (a) mechanically-clear seeded conflict → resolver
lands it, tests pass, retry fires, close completes; (b) schema-shaped seeded conflict →
resolver stamps BLOCKED with the unstick sentence, sticky remains, escalation body arrives
unchanged. Land the operator docs: the autopilot skill's conflict flow gains the
resolver-attempt step (attempt → resolved-or-BLOCKED → human path unchanged), and the
composition/problem-code docs pick up the resolve:: key and any new reason strings.

### Investigation targets

**Required** (read before coding):
- The .1 latch + prompt as landed
- sandboxEnv patterns for scratch daemon/state isolation in manual scripts

### Test notes

The harness script is the proof artifact; keep it re-runnable and isolated.

## Acceptance

- [ ] Both branches proven on scratch conflicts; harness committed
- [ ] Operator docs updated (conflict flow + key + reasons)

## Done summary
Added scripts/resolver-conflict-harness.ts: a re-runnable, isolated manual-tier proof (real git + sandboxed keeper projection, 27 checks) of both merge-resolver branches — mechanically-clear resolves keeping both intents then retry clears the sticky so the close proceeds; schema-shaped stamps BLOCKED with the unstick sentence, sticky + human escalation unchanged. Updated operator docs: autopilot SKILL.md resolver-attempt read note, composition-map resolve:: launch producer, CLAUDE.md sibling resolver_dispatched_at invariant.
## Evidence
