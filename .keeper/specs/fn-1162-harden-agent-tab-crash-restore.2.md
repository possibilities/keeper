## Description

**Size:** M
**Files:** src/resume-resolve.ts, src/tabs-core.ts, test/resume-resolve.test.ts, test/tabs.test.ts

### Approach

Invert claude resume resolution from recorded state to on-disk truth. New dep-lean module `src/resume-resolve.ts`: given a candidate (session id, harness, hints: recorded cwd, config_dir, observed-cwd history), locate the conversation artifact and derive the launch cwd. Claude: glob `<root>/projects/*/<uuid>.jsonl` over the job's config_dir root plus `~/.claude`, realpath-deduped (profiles share projects/ via symlink); read the found transcript's tail for the newest complete line carrying a `cwd` field (torn-tail safe — complete newline-terminated lines only) and prefer a tail cwd whose slug matches the holding dir; fall back to matching the observed cwd history against the holding-dir slug (the slug is lossy — `/` and `.` both collapse to `-` — so always match, never reverse). Exactly one resolution proceeds; zero matches or unresolvable multi-matches return a typed preflight failure carrying the found candidates and the one fixing command. Non-claude: artifact-existence gates — pi session file under the cwd's pi project dir matching the resume target, codex rollout by originator, hermes resume store — missing artifact is a typed not-resumable with reason. `planRestore` and `renderSnapshotScript` consume the resolver: resolved cwd replaces the recorded one for claude candidates (recorded cwd demoted to a hint), and preflight failures become plan entries (comments in the dump script, typed outcomes in the restore plan) — the load-bearing `cd` prefix is repaired, never dropped. Filesystem access rides an injectable seam.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/tabs-core.ts:100-123, 341-437 — planRestore + renderSnapshotScript integration points
- src/restore-set.ts:145-186 — RestoreCandidate shape + isRestorableCandidate gate
- src/resume-descriptor.ts:63-108 — buildResumeCommand; the cd prefix documented as load-bearing
- src/dead-letter.ts:224-277 — the complete-line NDJSON parse pattern to mirror for transcript tail reads

**Optional** (reference as needed):
- ~/.claude/projects/-Users-mike-code-keeper/ — real rehomed transcripts (sessions 51ee6f32-…, deba61ad-…) as manual fixtures
- ~/.pi/agent/sessions/--Users-mike-code-arthack--/ — pi session store layout (`<iso-ts>_<uuid>.jsonl`)
- src/db.ts:651-662 — env-override path-resolver pattern to copy for glob roots in tests

### Risks

- Transcript tail formats drift across claude versions — parse defensively, fall back to slug-matching history.
- A resolved cwd that no longer exists on disk (torn-down worktree) must fail preflight with the found project dir named, never drop the cd prefix or fall back to $HOME.

### Test notes

Fixture a fake projects tree: rehomed transcript (recorded cwd A, transcript under slug of B), zero-match, multi-match with tail-cwd disambiguation, multi-match unresolvable. Assert dump output emits the resolved cd and preflight-failure comments verbatim.

## Acceptance

- [ ] A claude candidate whose recorded cwd differs from its transcript's holding project dir resolves to the holding dir, and the dumped script emits the resolved cd.
- [ ] Zero-match and unresolvable candidates surface as typed preflight failures naming the found candidates and the one fixing command — no doomed resume line is ever emitted.
- [ ] Non-claude candidates whose resume target names no on-disk artifact surface as not-resumable with a reason, never a broken launch.

## Done summary
Added src/resume-resolve.ts: disk-anchored claude resume cwd resolution (transcript glob + torn-tail-safe cwd + slug match, typed preflight failures) and non-claude artifact-existence gates. Wired planRestore/renderSnapshotScript (tabs-core) + restore-worker revive.sh to consume the resolver via an injectable fs seam.
## Evidence
