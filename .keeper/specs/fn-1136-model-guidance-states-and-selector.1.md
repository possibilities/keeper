## Description

**Size:** M
**Files:** plugins/plan/scripts/model-guidance-check.ts, plugins/plan/model-selector.yaml, plugins/plan/skills/model-guidance/references/opus.md, plugins/plan/skills/model-guidance/references/sonnet.md, plugins/plan/test/consistency-model-selector.test.ts

### Approach

Add a `--state` mode beside the frozen parity gate. A pure, total classifier core (mirroring the existing pure-core + disk-wiring split) maps every configured axis value to exactly one state — models: missing | stub | stale | fresh; efforts: missing | present — with no throw path. Fail-closed lattice: fresh requires positive evidence (parsed provenance with `status: researched` as an exact string AND the recorded research sha256 matching the reference bytes); researched-but-hash-mismatch → stale; `status: stub`, absent status, unparseable header, or any type coercion → stub; no reference file, research entry, or guidance block → missing. Provenance parsing: slice the FIRST `<!-- ... -->` comment block from the reference file (the files open with an H1 — do not anchor to byte 0; the body may contain YAML-looking prose) and hand the inner text to the shared `parseYamlInput`; validate fields string-strict — YAML 1.1 coerces `researched: 2026-07-04` to a JS Date, so tolerate Date for date fields, and any coercion of `status` classifies as stub. Stamp `status:` into both reference headers (opus → researched, sonnet → stub) and add a new OPTIONAL top-level `efforts_provenance: {last_reviewed, status}` key to model-selector.yaml, learned by the config coercion (validated when present, fail-closed when absent) and read ONLY by the state core — the frozen `--check` core must not read it. Reference bytes change, so recompute both research sha256s in the same change. `--state` emits one JSON envelope on stdout: per-value state plus the provenance facts that drove it (status, researched date, resolves_to, hash parity).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/scripts/model-guidance-check.ts:155-240 — the frozen pure core, disk wiring, and main() arg handling (currently hard-rejects any non---check arg)
- plugins/plan/src/yaml_input.ts — the shared YAML 1.1 parser to reuse for the header block (pinned version "1.1"; note its date coercion)
- plugins/plan/skills/model-guidance/references/opus.md:1-14, sonnet.md:1-14 — the live provenance header shape (H1 first, then the comment block)
- plugins/plan/test/consistency-model-selector.test.ts:27,65-82 — the drift-gate test that goes red on byte changes, and the hand-built-input pattern for pure-core tests

**Optional** (reference as needed):
- plugins/plan/src/subagents_config.ts:118 — loadSubagentsMatrixFromDisk (axis loader)
- plugins/plan/src/models.ts:136-145 — configuredEfforts / configuredModels

### Risks

- Freezing violation: `--check` must stay byte-identical — keep the classifier a parallel additive core plus a new main() branch only.
- The Norway problem: unquoted provenance values coercing to non-strings must classify as stub — never crash, never pass as fresh.

### Test notes

Drive the classifier core with hand-built inputs in the existing test style: absent header, header not first block, coerced status, Date-typed researched, hash drift, explicit stub, researched-with-parity. Assert `--check` fixtures unchanged. After the stamps and re-hash, the live-config test classifies sonnet as stub and opus as fresh.

## Acceptance

- [ ] The state mode emits one JSON envelope classifying every configured axis value: model values exactly one of missing/stub/stale/fresh, effort values exactly one of missing/present
- [ ] Fail-closed proven by tests: absent, unparseable, or type-coerced provenance classifies as stub; hash-mismatched researched provenance classifies as stale; fresh only with exact researched status plus hash parity
- [ ] Check-mode behavior is unchanged and the drift gate plus fast suite are green after the status stamps and sha256 re-hash land
- [ ] On the live config, sonnet classifies as stub and opus as fresh; a config lacking the efforts provenance key still classifies totally with no throw

## Done summary
Added a fail-closed --state classifier beside the frozen --check gate: a pure total core maps every axis value to one state (models missing/stub/stale/fresh, efforts missing/present) via first-comment-block string-strict provenance parsing, with status stamps in both reference headers, re-hashed research shas, and an optional efforts_provenance config key.
## Evidence
