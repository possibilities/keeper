A repo with no configured test-gate script mints
worktree-recover-suite-gate-unavailable / worktree-finalize-suite-gate-unavailable
needs_human rows on every close verification (backlog #93; two live
specimens: fn-5 and fn-11 recover rows on agentbrain, which has no gate
script). A repo that has never configured a suite is not an operator
emergency. Evidence: runPackageSuiteGate src/autopilot-worker.ts:7633-7638
(no script → cannot-run), recover mint :8653, finalize mints :6603-6605 and
:6740-6747, baseline analogue noTestGateOutcome src/baseline-worker.ts:183-189.
Deadline-kill and install-failure classifications stay exactly as they are.
