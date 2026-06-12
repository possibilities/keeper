## Description

**Size:** M
**Files:** src/verbs/scaffold.ts (new), src/cli.ts, test/ additions

### Approach

The program's biggest single port, phase-faithful to run_scaffold.py: missing_session_id fail-closed at entry (zero writes — check before the lock, not lazily at emit); bounded input via the spine reader; parse via the wrapper with YAMLError → bad_yaml "YAML parse error" and decode failure → "not valid UTF-8"; assert-all buckets with the exact priority order and non-dominant-appended-to-details behavior; type-vs-value forks (coercion guard before value check so the right bucket fires); duplicate_epic guard inside the flock with the fullmatch regex and --allow-duplicate; two-pass ordinal dep resolution with detectCycles on the ordinal-keyed graph; epic.depends_on_epics via resolveEpicGlobally (ambiguous lists owners); flock scope exactly: dup-guard through ALL atomic writes inside, emit alone outside; in-RAM checkEpicTreeInMemory(checkFilesystemRepos true, epicSpecContent) BEFORE any write — integrity_failed leaves zero disk trace; stamp minted directly on the epic def (restamp non-member); writes via atomicWriteJson with written_paths tracked and mid-write unwind unlinking SPECS BEFORE JSONs; pre-commit raise at emit leaves the tree on disk with no rollback; created_by_close_of ignored leniently; success envelope {epic_id, task_ids, repo_distribution (sorted)} through the invocation-bearing mutating emit; pre-commit failures through the accumulate-all path; commit_failed carve-out untouched.

### Investigation targets

**Required** (read before coding):
- planctl/run_scaffold.py — the whole runner; this spec's anatomy summary is a map, the source is the spec
- tests/test_scaffold.py — the 54-test pin set (integration-marked; run with --run-slow)
- tests/test_creation_verbs.py — matrix + gap pins
- src/integrity.ts:365 checkEpicTreeInMemory — the landed options-bag signature

### Risks

Three envelope shapes in one verb — route explicitly. The flock-scope and unwind-order details are correctness, not style: a write outside the lock reopens the mint race; JSON-before-spec unwind poisons the id counter.

### Test notes

seed_epic round-trip green via dist/planctl-bun (the keystone); PLANCTL_BIN=dist/planctl-bun uv run pytest tests/test_scaffold.py --run-slow green minus python_only residue; fast gate untouched.

## Acceptance

- [ ] test_scaffold.py green under the --run-slow conformance pass (python_only skips visible)
- [ ] seed_epic works under conformance; envelope keys byte-compatible
- [ ] Matrix + gap pins green via the compiled binary

## Done summary

## Evidence
