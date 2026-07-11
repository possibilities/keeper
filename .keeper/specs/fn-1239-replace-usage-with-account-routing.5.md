## Description

**Size:** M
**Files:** cli/usage.ts, cli/keeper.ts, cli/descriptor.ts, cli/frames.ts, cli/setup-tmux.ts, src/daemon.ts, src/usage-models.ts, src/usage-picker.ts, src/usage-scrape-runner.ts, src/usage-scrape/, src/usage-scraper-worker.ts, src/usage-worker.ts, src/claude-tier.ts, test/usage.test.ts, test/usage-picker.test.ts, test/usage-scrape-cli.test.ts, test/usage-scrape.test.ts, test/usage-scraper-worker.test.ts, test/usage-worker.test.ts, test/frames.test.ts, test/setup-tmux.test.ts

### Approach

Delete the human-facing usage command and every runtime producer/consumer that exists to scrape terminal panels or feed it: tmux PTY driver, scrape runner, usage-model registry, old picker, scraper and watcher workers, daemon wiring, usage frames route, and dashboard pane. Keep task 1's external Capacity observer and account diagnostic as the only quota-related runtime.

Removal is immediate rather than a compatibility alias. `keeper usage` becomes an unknown retired command, `keeper frames --view usage` is no longer a valid view, and tmux setup provisions no usage window. Missing CodexBar never reactivates a built-in scraper.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/usage.ts:962 — separate live/snapshot/frames usage shell
- cli/usage.ts:1608 — usage frames entry
- cli/keeper.ts:35 — top-level usage command registration
- cli/descriptor.ts:500 — usage command descriptor
- cli/frames.ts:34 — valid frame views and usage dispatch
- cli/setup-tmux.ts:57 — dashboard usage pane provisioning
- src/daemon.ts:8575 — usage watcher worker lifecycle
- src/daemon.ts:8849 — usage scraper worker lifecycle
- src/usage-models.ts:1 — shared registry coupling scraper, picker, and UI

**Optional** (reference as needed):
- src/usage-scrape/scrape.ts:793 — profile-aware PTY scraping
- src/usage-scraper-worker.ts:297 — runtime account registry construction
- test/usage.test.ts:1186 — recent-session/profile rendering owned only by the retired UI

### Risks

Generic worker comments and tests cite the usage worker as an archetype; those references must be redirected without changing unrelated worker behavior. Broad filename deletion can accidentally remove the new account observer if matching is imprecise. The general frame-stream implementation and surviving viewer contracts remain accepted.

### Test notes

Remove tests whose sole subject retires and update descriptor/frame/dashboard contract tests to prove absence. Run import/depgraph checks so no production or plugin surface references deleted modules. Do not replace deleted tests with subprocess or live-daemon coverage.

### Detailed phases

1. Remove command, descriptor, frame-view, and dashboard entry points.
2. Remove daemon worker supervision and terminal-scrape implementation modules.
3. Remove usage registry/picker/config reads superseded by account routing.
4. Prune or redirect surviving generic-worker comments and collapse obsolete fixtures.

### Alternatives

Keeping a deprecation stub or proxying to CodexBar was rejected because the human chose to drop the Keeper UI cleanly. Keeping the terminal scraper as a fallback was rejected because absence of CodexBar must disable balancing rather than revive brittle parsing.

### Non-functional targets

The compiled load surface, CLI descriptor, frame registry, and dashboard contain no retired imports or command names. Deletion must reduce startup work and cannot add a new resident TUI or subprocess to default launches.

### Rollout

Task 1's observer and task 2's launcher are already proven before this deletion merges. Physical `agentusage` and profile state remains untouched until the operator archive step.

## Acceptance

- [ ] `keeper usage` and the usage-specific frame route are absent from CLI parsing, help, descriptors, and tests.
- [ ] Keeper provisions no usage dashboard pane and starts no tmux usage scraper, scraper worker, or envelope watcher.
- [ ] `usage_models`, the old picker, terminal parser, and `agentusage` runtime namespace have no production consumers.
- [ ] Missing CodexBar cannot activate any built-in scraping or balancing fallback.
- [ ] Surviving frame-stream and unrelated worker tests remain green with no references to deleted modules.

## Done summary
Retired the human-facing usage command, usage frame view, dashboard pane, daemon usage watcher/scraper workers, terminal-scrape implementation, usage registry/picker, and their dedicated test suites/fixtures, leaving account routing's Capacity observer as the sole quota-related runtime.
## Evidence
