## Description

**Size:** S
**Files:** template/agents/worker.md.tmpl, template/skills/work.md.tmpl (verify-only unless resume semantics change), test/consistency-skills.test.ts

### Approach

Edit the worker template only — the four `agents/worker-*.md` files are
generated, gitignored, and a PreToolUse hook denies direct edits. Three moves:

1. Frontmatter: `maxTurns: 100` -> `maxTurns: 300` (template line ~7; the only
   `maxTurns` in the repo).
2. Hardening prose, two rules, placed in the existing `## Rules` cluster
   and/or adjacent to the existing "Never background a test run and never
   idle-wait on one" rule (same behavioral family). Constraints: the
   `## Doc & comment discipline` block stays at <=5 bullets and must sit
   immediately before `## Rules` — do not add a discipline bullet and do not
   wedge a new `##` section between them (both hard-fail the consistency
   suite). Reuse the existing `BLOCKED:` categories (e.g. `EXTERNAL_BLOCKED`);
   the category enum is closed — no new category. The two rules:
   - Never end a turn text-only to wait on an external event (Monitor
     notification, test run, human input). A worker turn either calls a tool
     or delivers the final return. Poll with a bounded Bash command (timeout +
     retry count) or return `BLOCKED: <category>` naming what is needed.
   - For whole-file content, use Write/Edit tools rather than streaming the
     content through `cat > file <<'EOF'` Bash heredocs; long single-stream
     generations are the dominant mid-stream death exposure. Scope: file
     CONTENT writes only — multi-line commit messages via `keeper commit-work`
     heredocs stay sanctioned.
3. Regression pin: extend the existing per-tier rendered-frontmatter
   assertions in test/consistency-skills.test.ts (~lines 350-363, currently
   `name`/`model`/`effort`) to also assert `maxTurns: 300` in each of the four
   rendered files — this single assertion catches both a stale template and a
   forgotten render.

Then render (`promptctl render-plugin-templates --project-root
/Users/mike/code/planctl`) and run `bun test --timeout 30000`. Echo-check
`template/skills/work.md.tmpl`: read-only verification that the new worker
prose does not contradict the warm/cold resume machinery (~lines 110-173) or
assume a new BLOCKED category; edit it only if a genuine contradiction
surfaces. Note the existing "Harness-dropped predecessor" pickup section in
the worker template — the new rules complement it (return cleanly so a
successor resumes cheaply); keep the wording consistent with it.

### Investigation targets

**Required** (read before coding):
- template/agents/worker.md.tmpl:1-12 — frontmatter; the `maxTurns` line
- template/agents/worker.md.tmpl (the `## Rules` cluster and the existing never-idle-wait rule) — placement anchors for the new prose
- test/consistency-skills.test.ts:350-363 — per-tier rendered frontmatter assertions to extend
- test/consistency-skills.test.ts:415-447 — discipline-block pins the new prose must not violate

**Optional** (reference as needed):
- template/skills/work.md.tmpl:110-173 — resume machinery the prose must stay consistent with
- test/consistency-generated-guard.test.ts:150-200 — proof the rendered files are deny-listed for edits

### Risks

- Prose placement violating a structural pin — the consistency tests name the violated rule; fix placement, never relax the test.
- The heredoc rule reading as a ban on commit-message heredocs — scope it explicitly to file content.

### Test notes

`bun test --timeout 30000` is the complete gate (this repo has no second
tier). The `maxTurns` bump has no runtime-observable assertion beyond the new
frontmatter pin — do not hunt for a behavioral test of the cap.

## Acceptance

- [ ] Template frontmatter carries `maxTurns: 300`; all four rendered `agents/worker-*.md` carry it after render
- [ ] Poll-don't-yield rule and Write/Edit-over-heredoc rule present in the template body and rendered output, placed without violating the discipline-block pins; no new `BLOCKED:` category introduced
- [ ] Rendered-frontmatter test asserts `maxTurns: 300` for all four tiers and fails if the render is stale
- [ ] `bun test --timeout 30000` green; work committed via `keeper commit-work`

## Done summary
Raised worker maxTurns 100->300 and added two drop-hardening rules (poll-don't-yield; Write/Edit over Bash heredocs for file content) to the worker template; pinned maxTurns:300 in the per-tier rendered-frontmatter test. Rendered all four worker agents; full bun test gate green.
## Evidence
