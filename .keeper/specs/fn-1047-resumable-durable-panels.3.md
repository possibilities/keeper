## Description

**Size:** M
**Files:** src/pair/panel.ts, src/agent/dispatch.ts, cli/agent.ts, test/agent-panel-cli.test.ts

### Approach

Add slug addressing + introspection on top of the reconcile machinery. `panelWait`
(:746) gains `--slug` (resolve `<state>/panels/<slug>/`), keeping `--dir`; if both are
given, `--dir` wins (document it). New read-only `panel status --slug`: single-pass
per-leg classify (completed/running/failed/absent) using the launched_at-based grace
(NOT wait-start — a read-only call's waitStartMs=now would never elapse the grace and
report a dead-no-result leg as running forever), printing a JSON snapshot distinct from
PanelVerdict. New `panel prune`: enumerate `panels/*`, and delete a dir only when ALL
three hold — (a) `FileLock.tryAcquire` succeeds (no start mid-reconcile), (b) NO leg
pidfile is live (a live pid vetoes deletion regardless of age; the lock alone is not a
liveness signal since a running detached run is lock-free), and (c) a `started-at`
sentinel mtime is older than the TTL (mirror statusline LEAF_TTL_MS; never dir-mtime,
which a leg write bumps). Delete TOCTOU-safely: rename-to-trash (`<state>/panels/.gc/`)
then recursive-remove the trash entry, O_NOFOLLOW / EAFP (tolerate ENOENT/ENOTEMPTY),
best-effort/fail-open like gcSweep. Route the two new verbs in `runPanel` + cli/agent.ts
and add all three synopsis surfaces (PANEL_HELP, dispatch USAGE + KEEPER_AGENT_HELP).

### Investigation targets

**Required** (read before coding):
- src/pair/panel.ts:746-800 — panelWait (--dir today; add --slug), buildVerdict/PanelVerdict shape, the grace at :514 (why status needs launched_at)
- src/statusline-worker.ts (~:360 gcSweep, :104 LEAF_TTL_MS) — the age-based readdir sweep + best-effort unlink template
- src/usage-flock.ts — FileLock.tryAcquire for the prune non-blocking guard
- src/agent/dispatch.ts:84,221,224-238 — the two synopsis surfaces + prose; cli/agent.ts:9 JSDoc; src/pair/panel.ts:847 PANEL_HELP

### Risks

- prune racing a resume: flock-try guards a mid-reconcile start, but a running detached run is lock-free — the live-pid veto (b) is what actually protects it. TOCTOU on the delete itself needs rename-to-trash, not path-string recursive rm.
- status must not block and must not mutate; it reads the manifest lock-free (atomic writer from .2 prevents torn reads).
- Unknown/pruned slug for wait/status: exit 2 (missing manifest) — keep consistent with today's corrupt-manifest exit 2.

### Test notes

- status: seed leg states and assert the three-state snapshot uses launched_at grace (a dead-no-result leg reports failed/absent, not running). wait --slug resolves the same dir as --dir. prune: a live-pid dir is kept, a lock-held dir is skipped, a terminal aged-out dir is trashed-then-removed; assert no deletion of a fresh or live run. All via injected deps + KEEPER_STATE_DIR sandbox.

## Acceptance

- [ ] `wait --slug` resolves the slug dir (—dir still works, --dir wins if both); unknown slug → exit 2
- [ ] `panel status --slug` prints a non-blocking per-leg snapshot using launched_at grace (no false "running")
- [ ] `panel prune` deletes only dirs that are lock-free AND have no live leg pid AND are past TTL, via rename-to-trash TOCTOU-safe delete; fail-open
- [ ] Three verbs in all synopsis surfaces (PANEL_HELP + dispatch USAGE + KEEPER_AGENT_HELP + cli JSDoc); suite green

## Done summary
Added slug-addressed panel wait/status (durable-dir resolution, --dir wins), a non-blocking status snapshot classifying legs via launched_at grace, and a prune GC verb (lock-free + pid-dead + past started-at TTL, TOCTOU-safe rename-to-trash). All three verbs documented in PANEL_HELP, dispatch USAGE + KEEPER_AGENT_HELP, and cli JSDoc.
## Evidence
