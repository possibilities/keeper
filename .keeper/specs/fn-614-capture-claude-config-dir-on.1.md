## Description

**Size:** S
**Files:** plugin/hooks/events-writer.ts (probe instrumentation; reverted after verification)

### Approach

Add a single throwaway `Bun.write` call inside the `SessionStart` branch of the hook's main flow that dumps `process.env.CLAUDE_CONFIG_DIR ?? "(unset)"` to `/tmp/keeper-env-probe.txt`. Commit the probe as its own commit. Fire one real session under the arthack-claude.py launcher. Read the probe file and confirm the value matches what the launcher set. Revert the probe instrumentation as a follow-up commit (keep the verification commit in history for the audit trail).

If the probe shows the value present and correct, mark this task done and proceed to task 2.

If the probe shows `(unset)` or an unexpected value, **stop** — the whole approach changes (would require `ps -E` / `/proc/<pid>/environ` scraping, with the same scoping discipline as the existing spawn_name `ps` probe). Re-plan before any schema work.

### Investigation targets

**Required** (read before coding):
- `plugin/hooks/events-writer.ts:372-422` — the existing `spawnInfo` SessionStart-gated scrape; the probe goes adjacent to this block.
- `plugin/hooks/events-writer.ts:436` — the `import.meta.main` gate (probe runs only inside `main`, not on test imports).

**Optional** (reference as needed):
- `~/code/arthack/apps/arthack-claude/arthack-claude.py` — the launcher that sets `CLAUDE_CONFIG_DIR`. Confirm what value it sets so the probe verification is unambiguous.

### Risks

- **Probe file races between concurrent sessions** — multiple SessionStart hooks could overwrite. Mitigate by writing per-pid: `/tmp/keeper-env-probe.${process.pid}.txt`.
- **Probe accidentally lands in production code** — gate visually with a TODO-REVERT comment and ensure the revert commit lands before task 2 begins.

### Test notes

Not unit-testable by design (probe is throwaway instrumentation, verified by manual observation of one real session). No fixture / no automated test.

## Acceptance

- [ ] Probe instrumentation committed as one commit on main.
- [ ] One real session fired under the arthack-claude.py launcher.
- [ ] `/tmp/keeper-env-probe.${pid}.txt` exists and matches the launcher's `CLAUDE_CONFIG_DIR` value.
- [ ] Probe instrumentation reverted as a follow-up commit on main.
- [ ] Done summary records what value was observed (so the audit trail captures the verification).

## Done summary
Probe confirmed CLAUDE_CONFIG_DIR=/Users/mike/.claude-profiles/multi-claude-3 inherits cleanly from arthack-claude.py launcher into the hook subprocess. Probe committed (36f8dd3) and reverted (73e405f); approach for schema bump in task 2 is green.
## Evidence
