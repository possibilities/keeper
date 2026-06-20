## Description

**Size:** S
**Files:** test/resume-descriptor.test.ts, test/subagent-invocations.test.ts

### Approach

Run the project biome formatter on the two files and commit the result so `keeper commit-work`
no longer trips on their format debt. Format-only — no logic changes. Confirm the formatter is
clean afterward and the tests still pass.

### Investigation targets

**Required** (read before coding):
- the biome config + the lint/format command keeper commit-work runs (package.json scripts)

### Test notes

- biome check/format reports clean on both files; the two test files still pass; `keeper commit-work --preview-files` no longer flags them.

## Acceptance

- [ ] both test files pass biome format (format-only, tests still green); commit-work no longer trips on them

## Done summary

## Evidence
