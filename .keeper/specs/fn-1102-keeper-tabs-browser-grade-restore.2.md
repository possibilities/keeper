## Description

**Size:** S
**Files:** src/restore-set.ts, src/resume-descriptor.ts, src/restore-worker.ts, test/resume-descriptor.test.ts, test/restore-set.test.ts, test/restore-worker.test.ts

### Approach

Resume by exact identity: every RestoreCandidate's `resume_target`
becomes the job_id (the claude session UUID — `claude --resume <uuid>`
resolves exactly), while `label` keeps the latest title for display. Flip
the candidate constructors in restore-set.ts (shared collector, topology
deriver, current-set deriver) and resumeTarget() in resume-descriptor.ts
(job_id primary; title feeds labels only). buildResumeCommand keeps its
display shape but renders the UUID target. restore.json's resume_target
field changes meaning, so bump RESTORE_SCHEMA_VERSION. A UUID resolves
only within the job's project dir plus its git worktrees, so the cwd
prefix already emitted on every resume command is load-bearing — keep it
mandatory in every render path; a missing or torn-down cwd surfaces as
that one candidate's failed outcome, never a batch abort. No
--fork-session: resuming the same session is the expected browser-like
continuation.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/resume-descriptor.ts:29-77 — resumeTarget + buildResumeCommand
- src/restore-set.ts:401 — collector label/resume_target assignment; :661 — topology constructor; :855 — deriveCurrentSet constructor
- src/restore-worker.ts:205 — RESTORE_SCHEMA_VERSION; :354 — buildRestoreTier (pre-resolved resume_target in restore.json)

**Optional** (reference as needed):
- src/exec-backend.ts:919-920 — --resume argv assembly (unchanged; sanity only)

### Risks

- Humans recognize sessions by name: dry-run and outcome renders must keep the title label prominent next to the UUID target or restore output becomes unreadable.

### Test notes

resume-descriptor tests assert UUID target + title label;
restore-set assertions updated for all derivers; restore-worker fixture
asserts the bumped side-file schema version and UUID-valued
resume_target.

## Acceptance

- [ ] Every restore, dump, and apply path resumes by the job's session UUID; titles appear only as display labels
- [ ] restore.json carries a bumped side-file schema version with UUID-valued resume targets
- [ ] Every rendered resume command retains a cwd prefix so UUID resolution succeeds from the session's project dir

## Done summary

## Evidence
