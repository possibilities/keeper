## Description

**Size:** M
**Files:** `apps/planctl/` in `/Users/mike/code/arthack` -- schema definition, CLI dispatch, file writer, tests (cross-repo task; target_repo defaults to keeper but the actual changes land in the arthack repo's planctl app)

### Approach

Add `approval` as a top-level optional field on planctl's epic and task JSON schemas, valued `"approved" | "rejected" | "pending"`. Default to `"pending"` when absent. Validate the enum at every read/write boundary. The serializer MUST preserve every unknown top-level field on round-trip (load -> mutate known fields -> serialize back) so a forward-compat partial rollout never strips data. Add a `set-approval <epic_id> [<task_id>] <status>` CLI subcommand that uses planctl's existing atomic temp+rename write helper. Ship this BEFORE any keeperd change -- keeperd's RPC writes will be stripped by planctl's next rewrite if planctl does not know the field yet.

### Investigation targets

**Required** (read before coding):
- `/Users/mike/code/arthack/apps/planctl/` -- discover the schema definition, CLI dispatch (likely Click), existing atomic-write helper, and how `status` is currently round-tripped
- The existing epic/task status-flip CLI subcommand -- pattern template for `set-approval`
- The serializer used for `.planctl/{epics,tasks}/*.json` -- note EXACT indent, key order, trailing newline (keeperd must match byte-for-byte in task `.3`; document the exact form in this task's evidence)

**Optional:**
- The existing planctl test layout -- so the three new tests fit the existing pattern

### Risks

- planctl tests for "preserve unknown fields on rewrite" may not exist yet. They must exist before this task is done -- without that guarantee, the entire rollout is fragile (forward-compat blind spot).

### Test notes

Three tests: (a) `set-approval` writes the file atomically and lands the correct status; (b) round-tripping a file with an unknown top-level field preserves that field; (c) invalid status enum is rejected at CLI boundary.

## Acceptance

- [ ] `approval` field accepted on epic and task JSON; enum validated as `"approved" | "rejected" | "pending"`
- [ ] Missing field defaults to `"pending"` (or is treated equivalently to `"pending"` by every reader)
- [ ] Round-trip rewrite preserves all unknown top-level fields
- [ ] `set-approval` subcommand writes the file via atomic temp+rename (same directory)
- [ ] Three new tests pass; exact serializer form (indent, key order, trailing newline) documented in this task's evidence so task `.3` can match it byte-for-byte

## Done summary
Added `approval` top-level field to planctl epic and task JSON (enum: approved/rejected/pending; default 'pending' for missing/null). New top-level `planctl set-approval <epic_id> [<task_id>] <status>` verb writes the file atomically via temp+rename in the same directory; runner mutates the loaded dict so unknown top-level fields ride through untouched (forward-compat for keeperd writes in task .3). Three required test cases plus full normalize / overwrite / serializer-form coverage in apps/planctl/tests/test_set_approval.py (19/19 pass; full planctl suite 2213/2213). Canonical serializer form pinned for task .3 byte-for-byte: json.dumps(data, indent=2, sort_keys=True) + '\n' — indent=2 spaces, lexicographic key order, single trailing \n, UTF-8; atomic = tempfile.mkstemp(dir=path.parent, suffix='.tmp') -> write+fsync -> os.replace -> fsync parent dir (see /Users/mike/code/arthack/apps/cli_common/cli_common/atomic.py). NOT in VALIDATION_CLEAR_VERBS — approval is gating state, not structural.
## Evidence
- Commits: arthack@35abfb24e
- Tests: apps/planctl/tests/test_set_approval.py (19/19)