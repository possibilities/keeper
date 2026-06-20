## Description

Originating finding F5 (auditor Test Gaps). Evidence path: the unit-test
harness seedState hardcodes the legacy `.planctl` dir
(plugins/plan/test/harness.ts:282) and gitBaseline commits `.planctl/`, so
legacy-board fixtures exist — but the current suite covers only read-side
fallback (the `epic rm ambiguous` test resolves a seeded legacy proj_b). No
test exercises the load-bearing write-back invariant: a mutating CLI verb on
a legacy-only board must commit BACK to `.planctl/` and never force a
`.keeper/` shadow dir (CLAUDE.md "Data directory": "Never force .keeper/ on a
legacy board (it spawns a shadow dir that hides the live one)").

Add an end-to-end case: seed a legacy-only `.planctl/` board, gitBaseline it,
run a mutating verb against it, then assert the resulting `chore(plan):`
commit touched a `.planctl/` path and that no `.keeper/` dir was created at
the board root.

## Acceptance

- [ ] Test seeds a legacy-only .planctl/ board, runs a mutating CLI verb, and asserts the commit touched .planctl/
- [ ] Test asserts no .keeper/ dir exists at the board root after the mutation
- [ ] bun test passes

## Done summary

## Evidence
