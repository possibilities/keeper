## Description

Originating finding F1 (Should Fix) with merged F2 (Test Gap). Evidence path:
`src/project.ts:75-86` (`trailerProjectRoot`) checks `!isAbsolute(project)` on the
raw `--project` flag string and returns `null` for a tilde form, whereas the verb
at `src/verbs/close_preflight.ts:103-105` runs `expandUser(project)` before its
`isAbsolute` check and accepts it. The `null` from the trailer makes cli.ts:880's
`trailerProjectPath` fall back to `resolveProject(format)`, which `emitError`s when
cwd is not a planctl project (`src/project.ts:58-59`) — re-introducing the spurious
missing-project error the conformance fix targets, for the tilde-from-outside-cwd case.

Run `expandUser` (and `resolveAbs`/realpath) on the input inside `trailerProjectRoot`
before the `isAbsolute` check, mirroring the verb's own `--project` branch so the
trailer and verb agree on what counts as a valid project root. F2 lands the regression
test in the same commit (shared file-touch on the close-preflight surface).

## Acceptance

- [ ] `trailerProjectRoot` expands a tilde `--project` before its absolute check, matching close_preflight.ts
- [ ] A `~`-form `--project` from a non-project cwd resolves through the project root with no spurious trailer error
- [ ] test/saga-close-preflight.test.ts covers the tilde `--project`-from-outside-cwd case asserting no missing-project error
- [ ] lint, typecheck, and `bun test` (fast + slow) green

## Done summary

## Evidence
