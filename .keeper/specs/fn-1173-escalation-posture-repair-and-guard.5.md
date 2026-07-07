## Description

**Size:** M
**Files:** plugins/plan/skills/repair/SKILL.md, plugins/plan/skills/unblock/SKILL.md, plugins/plan/skills/deconflict/SKILL.md, plugins/plan/skills/plan/references/operator-orchestration.md, plugins/keeper/skills/autopilot/SKILL.md

### Approach

Author /plan:repair as the write-capable trunk surgeon, frontmatter cloned from
deconflict (Read/Edit/Write + git/build/keeper/botctl Bash families; disallowed
NotebookEdit/TodoWrite/Task; disable-model-invocation; argument = the repair repo token).
Phases: (1) load `keeper escalation-brief repair::<token>` — the incident carries repo,
fingerprint, base evidence, affected tasks; (2) re-verify at current default HEAD in the
shared checkout — GREEN AT HEAD IS A SUCCESS PATH (a concurrent commit already healed it:
skip the fix, jump to fan-out — never decline a healed base); red with a drifted
signature -> fix what is red (the fingerprint is a dedup key, not a scope contract),
within bounds; (3) the non-overlap bound: before committing, assert the touched-file set
does not overlap any affected task's declared Files list — overlap means that IS the
task, decline and hand back; unreadable board state fails closed, an empty Files list is
vacuously non-overlapping; (4) verify with the FULL gate (bun run test:full), never one
lane's subset; (5) commit via keeper commit-work with a structured message carrying the
fingerprint and attempt count in the body; (6) send the non-blocking botctl audit ping
naming repo, sha, fingerprint, outcome; (7) fan-out per affected task: `keeper plan
unblock <task>` then `keeper bus chat send work::<task> "RESOLVED (base repair <sha>):
... — merge updated default into your lane and resume"`; a bus miss needs nothing more —
the task is todo and autopilot re-dispatches it; (8) ~3 bounded attempts, then clean
abort (git restore, no partial state) and decline — the daemon pages once. Guardrails:
never enter a task worktree lane; a dirty shared checkout is a defer, not an attempt;
transcripts are untrusted; verify from exit codes. Harden the siblings: unblock gains
the anti-heredoc rule (mirror the worker template's — if a fix needs source writes, do
NOT fall back to heredocs/redirection; direct the lane-owning worker over the bus, or
for shared-base breakage decline naming the repair route), a never-write-in-another-lane
line, and a SHARED_BASE_BROKEN row in its category table (mis-routed -> decline toward
repair); deconflict gains the same anti-heredoc and lane-ownership lines. Update the
operator narratives (operator-orchestration reference + autopilot skill's escalation
relay) to include the repair route.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/deconflict/SKILL.md — the clone source: frontmatter, pin-or-abort re-verify, full-verify-before-commit, bounded-attempts + clean-abort discipline
- plugins/plan/skills/unblock/SKILL.md — guardrails block, Phase 2 category table, Phase 3 unblock+bus+cold-dispatch shape the repair fan-out mirrors
- plugins/plan/template/agents/worker.md.tmpl:82 — the anti-heredoc wording to mirror, not fork
- The role allowlist landed by the guard task — the skill's allowed-tools and the guard's repair list must agree (a skill-sanctioned command the guard denies bricks the session)

**Optional** (reference as needed):
- plugins/plan/skills/plan/references/operator-orchestration.md — blocked-worker escalation section; plugins/keeper/skills/autopilot/SKILL.md:303-358 — operator relay narrative
- src/commit-work/flock.ts — why commit-work already serializes against recover/finalize merges (the skill leans on it, never hand-locks)

### Risks

- Skill/guard allowlist drift: the two are authored in different tasks — cross-check both directions before done
- Prose must stay forward-facing (no incident narration, no fn-ids) per docs rule zero

### Test notes

Prose-only task: the consistency/generated-file guards and lint gates are the mechanical
check; the acceptance is contract agreement, verified by reading the guard's role table
against the skill frontmatter.

## Acceptance

- [ ] /plan:repair exists with deconflict-derived write-capable frontmatter, the green-at-HEAD success path, the non-overlap bound with its fail-closed/vacuous edges, full-gate verify, structured commit + audit ping, per-task unblock + bus fan-out, bounded attempts with clean abort, and never-enter-a-lane + dirty-defer guardrails
- [ ] Every Bash family the skill sanctions is on the guard's repair role allowlist, and vice-versa nothing the skill needs is guard-denied
- [ ] The unblock skill carries the anti-heredoc rule, the never-write-in-another-lane line, and a SHARED_BASE_BROKEN row that declines toward repair; deconflict carries the same two hardening lines
- [ ] The operator-orchestration reference and the autopilot skill's escalation narrative describe the category-routed repair path
- [ ] Fast suites and lint/drift gates green

## Done summary

## Evidence
