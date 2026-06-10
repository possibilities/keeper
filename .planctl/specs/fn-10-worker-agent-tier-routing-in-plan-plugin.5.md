## Description

**Size:** S
**Files:** CLAUDE.md, README.md, skills/plan/SKILL.md, docs/diagrams/planctl-workflow.mermaid.md, docs/reference/commit-at-mutation-boundary.md

### Approach

Rewrite every worker-routing doc to the present-tense end state — workers are
generated `agents/worker-<tier>.md` files in the `plan` plugin, addressed
`plan:worker-<tier>`; `claim`/`worker resume`/`resolve-task` emit `worker_agent`;
`/plan:work` spawns it; keeper launches with no `--plugin-dir`. Follow the
project's no-backward-facing-advice rule: NO "formerly work-plugins",
"(deleted in fn-N)", or tombstones — state the new fact directly.
`planctl-bug-history.md` is exempt (intentional history). Add a one-line
operational note that `CLAUDE_CODE_SUBAGENT_MODEL`, if set, overrides every
worker agent's `model` frontmatter and flattens all tiers.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md:46 — the "Skills and agents" block: worker-location sentence, keeper `--plugin-dir` launch sentence, the `resolve-task` bullet (~51) and `worker resume` bullet (~52); add `worker_agent` to both envelope field lists and the `CLAUDE_CODE_SUBAGENT_MODEL` note
- README.md — the fn-593 `resolve-task` note (mentions picking a tier-plugin / `--plugin-dir`); reframe to the emitted `worker_agent` name
- skills/plan/SKILL.md:394 — "tier picks which work-plugins/<tier> keeper loads" → tier is surfaced as `worker_agent: plan:worker-<tier>`
- docs/diagrams/planctl-workflow.mermaid.md:52 — the `worker_box` label "keeper loaded matching work-plugins/<tier>/ pre-boot"
- docs/reference/commit-at-mutation-boundary.md:~490 — skim the `worker resume` mention; add `worker_agent` if it enumerates the envelope fields

### Risks

The CLAUDE.md block is dense and load-bearing (other agents read it) — keep it
accurate and present-tense. Run after task 4 so the docs describe the fully
settled state.

### Test notes

Grep the repo for residual `work-plugins`, `--plugin-dir`, and bare
`work:worker` outside `planctl-bug-history.md` and confirm only intentional
references remain. No code tests; doc-only.

## Acceptance

- [ ] CLAUDE.md, README.md, skills/plan/SKILL.md, mermaid diagram, and the commit-boundary ref all describe the present-tense `plan:worker-<tier>` / `worker_agent` / no-`--plugin-dir` world
- [ ] no "formerly"/"work-plugins"/tombstone phrasing outside `planctl-bug-history.md`
- [ ] `CLAUDE_CODE_SUBAGENT_MODEL` flatten-all-tiers note added to CLAUDE.md

## Done summary

## Evidence
