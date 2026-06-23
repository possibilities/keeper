## Description

**Size:** S
**Files:** plugins/plan/test/consistency-skills.test.ts, plugins/plan/test/src-invocation.test.ts

### Approach

Fix the 8 failures + 1 error in the plan suite, all `planctl→keeper`
rename leftovers. In `consistency-skills.test.ts` the verb-extraction
regex matches `planctl <verb>` from fenced bash, but the skills now write
`keeper plan <verb>` — update the extraction so the prefix is `keeper plan`
(note `plan` is now part of the command prefix, then the verb/group
follows), update the per-skill `mutatingVerb` constants
(`planctl scaffold` → `keeper plan scaffold`, `planctl epic queue-jump` →
`keeper plan epic queue-jump`, bare `planctl` → `keeper plan`), and update
the `--help` resolution to invoke `keeper plan <verb> --help`. In
`src-invocation.test.ts` the hardcoded `.planctl/epics` (and any sibling
`.planctl/*`) paths must become `.keeper/*` to match the renamed data dir.
Verify the whole plan suite goes to 0 fail / 0 error.

### Investigation targets

**Required** (read before coding):
- plugins/plan/test/consistency-skills.test.ts:97 (the `/planctl\s+.../` extraction regex), :162/:168/:174 (`mutatingVerb` constants), :189-198 (the failing assertions + the `--help` check)
- plugins/plan/test/src-invocation.test.ts:454 (`EPICS_DIR = join(REPO, ".planctl", "epics")`) and any other `.planctl` literals in the file
- plugins/plan/skills/*/SKILL.md — confirm the current `keeper plan <verb>` wording the extraction must match

### Risks

- The extraction is not a blind string swap: `planctl <verb>` → `keeper plan <verb>` changes the token structure (the CLI is now nested under `keeper plan`). Make sure multi-word groups (`epic queue-jump`) still extract correctly.

### Test notes

`cd plugins/plan && bun test --timeout 30000` must end 0 fail / 0 error.
The `every extracted verb responds to --help (exit 0)` assertions must pass
against the real `keeper plan` CLI.

## Acceptance

- [ ] consistency-skills.test.ts extracts `keeper plan <verb>` tuples and its `mutatingVerb`/`--help` assertions pass
- [ ] src-invocation.test.ts references `.keeper/` not `.planctl/`; the scandir error is gone
- [ ] `cd plugins/plan && bun test` reports 0 fail and 0 error
- [ ] No real git reintroduced (`bun run test:hygiene` still passes)

## Done summary

## Evidence
