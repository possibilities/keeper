## Description

Finding F1 (`src/agent/main.ts:2220`, evidence path: `main.ts:2220` seam vs
`test/plugin-composition-map.test.ts:133/182`). The gate seam
`const stripScanDirs = (sources.workerPluginIsolation ?? false) && hasFlagToken(remainingArgs, "--dangerously-skip-permissions")`
is never exercised end-to-end. The existing test drives `discoverPlugins`
with an explicit `{stripScanDirs}` boolean and separately asserts the flag
rides the built argv, but nothing asserts that `main()` reads the flag back
out of `remainingArgs` at this call site to compute the gate. The gate is
live (flipped ON in task .4), so a silent no-op — e.g. if the flag is
consumed upstream or sits after a `--` separator — would leave workers
inheriting the scanned plugin set with no failing test.

## Acceptance

- [ ] A test (or a clean-machine-check stage) drives the real `main()` arg vector through the seam and asserts scan dirs are stripped for a worker argv (config knob ON + flag present) and retained for an interactive argv (flag absent).
- [ ] The assertion fails if the flag observation at the seam regresses (e.g. flag no longer in `remainingArgs` at that point).

## Done summary
Added an end-to-end test driving the real main() arg vector through the worker plugin-isolation seam: a worker argv (knob ON + --dangerously-skip-permissions) strips the scanned plugin set while an interactive argv retains it. Red-capable — regresses if the seam stops observing the flag in remainingArgs.
## Evidence
