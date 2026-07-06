## Description

**Size:** M
**Files:** plugins/plan/src/format.ts, plugins/plan/src/cli.ts, plugins/plan/src/verbs/claim.ts, plugins/plan/src/verbs/submit_common.ts, plugins/prompt/src/cli.ts, cli/format.ts (new), cli/query.ts, cli/status.ts, cli/watch.ts, cli/envelope.ts, plugins/plan/test/format.test.ts, test/envelope.test.ts

### Approach

`--format json|yaml|human` becomes the one output-format idiom, with `--json` a documented alias of `--format json`. Extend plan's OutputFormat/formatOutput with a yaml member rendered through the existing yamlDump serializer (literal block scalars, no key sort); the prompt CLI gains the same tri-mode `--format`; keeper-native finite-output JSON readers (status, query, watch, the session/history reads via their descriptors) gain `--format` beside the existing `--json`. Conflicting `--json --format yaml` is exit 2 (explicit contradiction beats silent precedence). `--format human` on a command with no text renderer is exit 2 naming the supported modes — the current silent-JSON fallback is retired, and each descriptor's format_modes lists exactly what renders. Fix the false "`--format yaml` renders YAML" comments by making them true. Byte-frozen: the plan emit() parity family, plan validate/cat, show-session-files snake_case, and watch frames per the envelope EXEMPTIONS — none of these grow yaml and none may advertise it.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/format.ts:8 — OutputFormat lacks yaml; formatOutput's silent fallback to retire
- plugins/prompt/src/yaml_dump.ts — the serializer to reuse (do not add a new YAML dep)
- cli/envelope.ts:11-16,25-35 — envelope stance + EXEMPTIONS list gating which surfaces may grow --format
- plugins/plan/src/verbs/claim.ts:42, plugins/plan/src/verbs/submit_common.ts:54 — the aspirational yaml comments to make true

**Optional** (reference as needed):
- cli/query.ts:82, cli/status.ts:99, cli/watch.ts:114 — existing --json flags becoming aliases

### Risks

- yaml output of envelope-shaped data must round-trip cleanly for jq-equivalent consumers (yq) — keep key order and scalars stable via yamlDump's existing style.
- The exit-2-on-unsupported-human change is a behavior break where scripts relied on silent JSON — acceptable under hard cutover, but the error must name the supported modes.

### Test notes

Per-surface: json/yaml/human render cases, alias equivalence, conflict exit 2, unsupported-mode exit 2, and byte-parity snapshots for every EXEMPTIONS surface proving no change.

## Acceptance

- [ ] Plan, prompt, and the native finite-output readers accept `--format json|yaml|human` with `--json` as alias; yaml renders through the shared serializer
- [ ] Conflicting or unsupported format requests exit 2 naming the supported modes; no silent fallback remains
- [ ] Every descriptor's format_modes matches what actually renders; all envelope-exempt surfaces are byte-unchanged

## Done summary

## Evidence
