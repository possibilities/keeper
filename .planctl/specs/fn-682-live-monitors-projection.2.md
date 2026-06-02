## Description

**Size:** S
**Files:** cli/jobs.ts, README.md

### Approach

Render a "Monitors" section in the EXPANDED `keeper jobs` row, collapse-controlled, alongside `backendCoordsSeg` + `subagentLinesFor` in `renderJobsBody` (~283+). Parse `jobs.monitors` (JSON.parse with `[]` fallback); emit one line per monitor: a provenance label (`monitor` / `bash-bg` / `ambient`) + `command` (truncated to one line — multi-line 1KB+ heredocs exist) + `status`, falling back to `description` when `command` is empty/missing. Follow the per-subagent line shape (cli/jobs.ts:138) and the colorize-at-render pill convention (no leading SGR; `colorizePillsInLine` paints brackets). README: add an "As of schema v51" changelog block (model: v50 block ~1193-1204) describing the monitors column + three-way provenance + re-fold determinism + the keeper-py whitelist gain; revise the jobs CLI bullet (586-618, esp 608-618 fn-668 pattern) row-anatomy to include the monitors segment.

### Investigation targets

**Required** (read before coding):
- cli/jobs.ts:190-209 projectJobRow; 232-249 backendCoordsSeg; ~283+ renderJobsBody expanded region; :138 subagent line shape
- README.md:1193-1204 (v50 changelog block), 586-618 (jobs CLI bullet)

**Optional**:
- cli/jobs.ts:226-228 colorizePillsInLine (pill paint convention)

### Risks

- `command` can be a 1KB+ multi-line heredoc — must truncate to a single line.
- Missing-`command` entries exist in live data — fall back to `description`.

### Test notes

Visual: `keeper jobs`, expand a session running monitors (e.g. chatctl bus + a keeper await), confirm all three labels render and long commands truncate. Add a unit test only if a truncation/label helper is extracted.

## Acceptance

- [ ] Expanded `keeper jobs` row shows a Monitors section: one line per live monitor with provenance label + truncated command + status.
- [ ] Missing-command entries fall back to description; long commands truncate to one line.
- [ ] README v51 changelog block + jobs CLI bullet row-anatomy updated.

## Done summary

## Evidence
