## Description

**Size:** S
**Files:** README.md, CLAUDE.md, ~/.config/keeper/config.yaml, .planctl/specs/fn-725-autopilot-max-concurrent-jobs-cap.md

### Approach

Update the docs to reflect (a) the approve exemption / narrowed cap scope
and (b) the removed viewer sections. Follow each file's existing
structure/register (don't restructure).

- **README.md** config-key table (~285-316): add a `max_concurrent_jobs`
  entry (it is currently missing) noting that `approve`-verb launches are
  exempt from the budget, and add the key to the YAML snippet block; use
  the `zellij_session` bullet as the structural template.
- **README.md** autopilot CLI ref (~710-752) + readiness narrative
  (~1872-1877): remove `--- predicted ---` / `--- schedule ---` from the
  viewer-frame description and the `# viewer: ...` example comment; trim
  the `predictNextDispatches`/`predictFullSchedule` clause.
- **CLAUDE.md** `## Autopilot` (115-124): add one concise bullet — the
  global `max_concurrent_jobs` cap counts root-occupants (planner-exempt
  and now approve-exempt) before per-epic dispatch; `approve` launches are
  exempt so pending-approval rows can't deadlock their own approvers. Match
  the existing bold-term-then-clause register.
- **config.yaml** `max_concurrent_jobs` comment: note that `approve`-verb
  launches are counted outside the cap (total workers can reach
  `cap + live approvers`). NOTE: this file lives at ~/.config/keeper/, not
  in the repo — edit the live file; if an in-repo sample/comment mirror
  exists (check db.ts doc-comments), update that too.
- **fn-725 spec** (low-pri): one-line addendum/strikethrough noting the
  "approval-pending starvation is correct" stance was superseded by this epic.

### Investigation targets

**Required** (read before coding):
- README.md:285-316 (config table), :710-752 (autopilot CLI ref), :1872-1877 (readiness narrative)
- CLAUDE.md:115-124 (`## Autopilot`)
- ~/.config/keeper/config.yaml (the `max_concurrent_jobs` comment block)

**Optional** (reference as needed):
- src/db.ts — `max_concurrent_jobs` default + doc-comments (check for an in-repo comment mirror to keep consistent)
- .planctl/specs/fn-725-autopilot-max-concurrent-jobs-cap.md (the superseded note)

### Risks

- Don't over-claim: the cap still bounds work/close; only approvers are additive. Keep wording precise about WHICH class is exempt.
- The fn-725 spec is historical record — addendum only, don't rewrite its design.

### Test notes

Docs only — no test. Verify the README YAML snippet stays valid YAML and CLAUDE.md bullets render.

## Acceptance

- [ ] README documents `max_concurrent_jobs` + the approve exemption and no longer describes predicted/schedule viewer sections
- [ ] CLAUDE.md `## Autopilot` has a cap + approve-exemption bullet
- [ ] config.yaml comment notes approvers are counted outside the cap
- [ ] fn-725 spec carries a one-line supersession addendum

## Done summary

## Evidence
