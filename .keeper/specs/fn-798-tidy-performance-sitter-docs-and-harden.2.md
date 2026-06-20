## Description

Resolves audit finding F5 (and merged F6). F5: the injection-hygiene
path is the load-bearing security concern of the page-free convergence,
but the only on-disk test (test/keeper-watch.test.ts:2311) asserts a
hostile *key* stays fenced — no case feeds a triple-backtick into a
`detail` or `evidence` value to prove `renderFollowup`'s fence
neutralization (followups.ts:148-155) actually rewrites it. Add a direct
assertion that a ```-bearing detail/evidence value is neutralized.

Merged F6: `sanitizeKey` feeds the on-disk followup filename, so its edge
cases (empty-after-sanitize, the >150-char cap, NUL stripping) are a real
path-safety surface and are pure/cheap to pin. F5 and F6 both harden the
followups writer's untrusted-input handling in the same test file — land
them as one test-coverage commit.

## Acceptance

- [ ] A direct unit assertion proves a triple-backtick in detail/evidence is neutralized by renderFollowup.
- [ ] sanitizeKey has direct unit coverage for empty-after-sanitize, the >150-char cap, and NUL stripping.

## Done summary
Added direct unit coverage for the followups writer's untrusted-input hardening: renderFollowup fence neutralization of triple-backticks in detail/evidence, and sanitizeKey edge cases (empty-after-sanitize, 150-char cap, NUL stripping).
## Evidence
