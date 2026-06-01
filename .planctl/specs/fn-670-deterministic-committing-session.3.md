## Description

**Size:** M
**Files:** apps/planctl/planctl/run_render_approve_context.py, apps/planctl/tests/test_render_approve_context.py, apps/planctl/skills/approve/SKILL.md, apps/planctl/docs/reference/planctl-bug-history.md, apps/jobctl/jobctl/run_commit_work.py

### Approach

Flip the two consumer-side functions in render-approve-context to use the
new server signal and to stop reading non-worker turns.

`pick_target_job` (run_render_approve_context.py:73, task branch :98-126):
among the task's embedded jobs (already minus `approve`), PREFER the job
with the greatest `last_commit_for_task_at` (the committing session); fall
back to the existing freshest-`created_at` pick ONLY when no embedded job
carries the link (task worked-but-not-committed, or pre-v49 data). Treat
missing/non-numeric link as absent (mirror the existing `-inf` defensive
guard). The field surfaces opaquely through `get_epic`'s embedded jobs — no
keeper-API change needed. Optionally debug-log when falling back.

`extract_last_assistant_message` (:129): restrict acceptance to
ASSISTANT-role text turns only — drop the `user`/`role=="user"` branch
(:161-164). This structurally drops `[Request interrupted by user]` (a user
turn), `<task-notification>` injections (user turns — the explicit text-skip
at :186 becomes redundant; remove it), and human prompts, with zero text
matching. Update both docstrings.

Docs: SKILL.md Rule 1 "no user/assistant text turn" → "no assistant text
turn"; add a planctl-bug-history.md entry; update jobctl
run_commit_work.py `_FORBIDDEN_TRAILER_RE` comment to note `Task:` is now
consumed by git-worker for session resolution.

Note: the assistant-only change is independent of the keeper chain and the
pick_target_job change can be unit-tested against synthetic embedded-job
dicts, so this task does not strictly require T1/T2 to be merged to code or
test — the dep is for end-to-end sequencing (keeper writes the field before
planctl relies on it at runtime; planctl falls back gracefully meanwhile).

### Investigation targets

**Required** (read before coding):
- apps/planctl/planctl/run_render_approve_context.py:73-126 pick_target_job, :120-126 _ts max() pattern, :129-189 extract_last_assistant_message, :161-164 user-or-assistant accept, :186 task-notification skip, :336-343 embedded-job passthrough
- apps/planctl/tests/test_render_approve_context.py:133 TestPickTargetJob, :208 TestExtractLastAssistantMessage, :209 test_returns_last_assistant_text, :215 test_skips_task_notification_turns, :240 test_string_content_accepted_verbatim (pins a user-turn return — flip to assistant)
- apps/planctl/skills/approve/SKILL.md Rule 1
- apps/jobctl/jobctl/run_commit_work.py:32-37 _FORBIDDEN_TRAILER_RE comment

### Risks

- test_string_content_accepted_verbatim asserts a role:"user" turn returns "hi" — must flip to assistant under the new contract (intended behavior change, not a regression).
- The link field name/semantics MUST match exactly what T2 writes (`last_commit_for_task_at`, unix-seconds). Pin the contract; a mismatch silently falls back to freshest-claim (the bug we're fixing).
- Fallback when the linked job_id was reaped from the embedded array — degrade to freshest-claim, never crash.

### Test notes

tests/test_render_approve_context.py: pick_target_job prefers the job with max last_commit_for_task_at over a later-created_at non-committing job; falls back to freshest-claim when no job carries the link; the aborted-later-reclaim scenario resolves to the committer. extract: assistant-only returns the last assistant text; a trailing role:"user" `[Request interrupted by user]` is skipped to the prior assistant turn; flip test_string_content_accepted_verbatim to assistant; test_skips_task_notification_turns + test_returns_last_assistant_text still green.

## Acceptance

- [ ] pick_target_job prefers the embedded job with the greatest last_commit_for_task_at; falls back to freshest non-approve created_at when none carry the link; defensive on missing/non-numeric.
- [ ] extract_last_assistant_message accepts assistant-role text turns only; interrupt + task-notification + human-prompt user turns are skipped; redundant text-skip removed.
- [ ] Both docstrings updated; SKILL.md Rule 1, planctl-bug-history.md, jobctl comment updated.
- [ ] pytest test_render_approve_context.py green incl. flipped + new cases.

## Done summary

## Evidence
