## Description

**Size:** M
**Files:** src/agent/config.ts, src/pair/panel.ts, src/agent/triple.ts, src/agent/main.ts, test/agent-config.test.ts, test/pair-panel.test.ts, test/agent-presets.test.ts, test/agent-matrix.test.ts, test/helpers/agent-main-harness.ts

### Approach

Cut both panel.yaml readers over to the object form in one move. Seam A (validating loader):
`PanelSelections.panels` becomes `Record<string, {strength, members, description}>` — the
loader validates STRUCTURE only (per-panel unknown-key rejection over exactly those three
keys; non-empty `members` of panel-eligible triples via the existing predicate; non-empty
`strength` and `description` strings) and detects a legacy list-form panel value explicitly,
failing with an error that names the panel and directs regeneration via /plan:panel-guidance
(never the generic "must be a non-empty list"). No policy in the loader: counts, band
vocabulary, and effort gravity belong to the plan plugin's gate. Duplicate identical members
stay legal here (ordinal disambiguation is a launch feature). The launch path reads
`.members`; top-level allowed keys stay {panels, default} and default-must-name-a-defined-
panel is unchanged. Seam B (lenient harvester): harvest members from BOTH shapes — a bare
list or an object's `members` — so `providers check` and `presets list` never go dark on a
stale file, and additionally harvest `strength`/`description` as optional raw strings (empty
when absent). Discovery surface: the presets-list JSON panel entries gain `strength` and
`description`; both JSON and human output order panels by the band ladder
weak<light<standard<strong<max (unknown bands last), then name; the human line carries the
band alongside the existing default marker. The presets-resolve error hint keeps its current
behavior and failure semantics — no new fail-loud read anywhere in the display paths.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/config.ts:618 — loadPanelSelections (loop at :632-661 is the list validation being replaced); :326 PanelSelections; :386 ALLOWED_PANEL_KEYS; :597 isPanelEligibleHarness (reuse, never fork)
- src/agent/triple.ts:474 — extractHostTriples; the Array.isArray guard near :505 is the silent-drop hazard; :424 HostTriples; :437 hostTripleRefs (providers-check member refs)
- src/agent/main.ts:1840 — runPresetsList JSON (:1882-1886) + human (:1919-1929) emitters; :1748-1760 presets-resolve panel hint
- src/pair/panel.ts:379 — resolvePanelMembers (the launch-path consumer)

**Optional** (reference as needed):
- test/agent-config.test.ts:296-390 — the list-form loader cases to migrate
- test/agent-presets.test.ts:385-639 — hostTriples fixtures and the presets --json expectation
- test/pair-panel.test.ts:83,208-284 — PanelSelections literals; test/helpers/agent-main-harness.ts:34,232 — default panel seams
- test/agent-matrix.test.ts:1291-1297 — providers-check panel-member ref flattening

### Risks

- A partial cutover (loader only) leaves providers check and presets list silently empty —
  both seams land in this task by design; treat any test showing an empty panel harvest on a
  valid object-form file as a defect.
- Growing the harvester must not change presets list failure semantics: it stays tolerant of
  files the validating loader would reject.

### Test notes

Migrate every list-form fixture to object form; add cases for the legacy-form remediation
error (message names the panel and /plan:panel-guidance), per-panel unknown-key rejection,
blank strength/description rejection, dual-shape harvesting in the harvester, strength/
description in presets --json, ladder ordering, and providers-check refs over both shapes.

## Acceptance

- [ ] An object-form panel configuration loads, and panel member resolution preserves declaration order and ordinal disambiguation of duplicate members.
- [ ] A legacy list-form panel value fails the validating loader with an error naming the panel and directing regeneration via /plan:panel-guidance.
- [ ] `keeper agent presets list --json` emits per-panel strength and description; both output forms order panels weak→strong by band then name, and the human listing shows each band plus the default marker.
- [ ] `keeper agent providers check` lints members from object-form and legacy list-form files alike — no silent drop of either shape.
- [ ] The root fast suite is green.

## Done summary
Cut both panel.yaml reader seams over to the described object schema {strength, members, description} (ADR 0046): the validating loader rejects legacy list-form panels with a /plan:panel-guidance remediation error, the lenient host-triples harvester reads both shapes, and presets list emits per-panel strength/description ordered weak->strong by band then name in both JSON and human output.
## Evidence
