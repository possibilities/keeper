## Description

Finding f-001 (test/server-worker.test.ts:1773–1833): the "TRACE=1 emits op=diffTick line for a slow tick" test uses spin-wait loops and 500 rows to push diffTick over the 10 ms threshold, then asserts only on shape IF lines exist — explicitly accepting zero emitted lines as a passing outcome (see comment at line 1822). On a fast CI machine the threshold may never be crossed and the gate is silently unverified.

Fix: force a deterministic threshold crossing so lines.length > 0 can be asserted unconditionally. The preferred approach is to move the assertion out of the "hope CI is slow enough" loop by injecting a mock performance.now() that returns values guaranteed to exceed a stage threshold, or by restructuring the test as a unit test with explicit performance.now override via module mocking, rather than relying on wall-clock spin.

## Acceptance

- [ ] The slow-tick test asserts lines.length > 0 unconditionally, not just shape-if-present
- [ ] The test does not rely on wall-clock spin loops to cross the threshold
- [ ] The fast-tick companion test (line 1835) is unaffected

## Done summary

## Evidence
