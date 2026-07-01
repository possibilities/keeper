## Overview

Agents flail reading the plan board because every read-only `keeper plan <verb>`
prints its JSON envelope AND a second top-level JSON object on its own line
(`{"plan_invocation":{…}}`). `json.load` throws "Extra data"; `jq` silently
applies the filter to both documents and emits corrupt output. The read-only
trailer has no live consumer (the events deriver `JSON.parse`s the whole stdout,
which throws on the two-value stream). This epic makes every `keeper plan`
read/inspection call emit exactly one JSON value, bounds the unbounded list
surfaces, guards the invariant, and signposts the already-clean orient surfaces
(`keeper status`, `keeper query epics`) so agents reach for the right tool.

## Quick commands

- `keeper plan epics | jq -e . >/dev/null && echo OK`  # single JSON value, jq clean
- `keeper plan status | python3 -c 'import sys,json; json.load(sys.stdin); print("OK")'`
- `keeper plan detect >/dev/null; echo $?`  # still exits 1 in a non-plan dir
- `keeper plan tasks --epic fn-1 | jq '.truncated, .total, .returned'`
- `bun test plugins/plan/test`  # conformance surface green

## Acceptance

- [ ] Every read-only/inspection `keeper plan <verb>` emits exactly one top-level JSON value on stdout.
- [ ] `keeper plan detect` still emits its found-false error envelope and exits 1 (the `detect || init` idiom survives).
- [ ] `keeper plan validate --epic` emits one JSON value (invocation merged into its envelope on the stamp path).
- [ ] `keeper plan list`/`tasks` output is bounded with a `{total, returned, truncated, hint}` envelope; human render byte-unchanged.
- [ ] A conformance test asserts no read verb prints more than one top-level JSON root (root-counting, not line-count).
- [ ] keeper CLAUDE.md + `keeper plan --help` signpost `keeper status` / `keeper query epics` as the board-read surfaces.

## Early proof point

Task that proves the approach: `.1` (single-value read contract + guard). If it
fails: the fallback is routing the trailer to stderr rather than dropping it —
but no consumer was found, so drop is the verified-safe path and stderr is only
the escape hatch.

## References

- Overlap: `fn-1038` (per-cell work plugins) also writes into `plugins/plan/test/*` and regenerates oracle fixtures there — coordinate the test-tree edits (wired as an epic dep).
- RFC 8259 §2 — a JSON text is exactly one value; `json.loads` raises "Extra data" past the first root.
- OpenTofu dual output streams / AWS CLI pagination envelope — references for keeping telemetry off the result stream and for the truncation-envelope shape.

## Docs gaps

- **plugins/plan/README.md** (`## Auto-commit` ~L99): scope the `plan_invocation` trailer to mutating verbs only — read verbs emit one value.
- **plugins/plan/README.md** (`validate --epic` ~L144, `## Output Contract` ~L136-146, `## Help for Agents` ~L171): single-JSON guarantee, truncation-envelope shape, orient-surface signpost.
- **CLAUDE.md** (keeper root): add a terse board-orient guardrail after "Plans are READ-ONLY".
- **plugins/plan/CLAUDE.md** (L12 validate divergence, L28 validation-marker, L51 Running-Things table): single-envelope validate + the new conformance guard.

## Best practices

- **One JSON value per invocation:** the failure is in the host JSON parser, not the LLM — prompting an agent to tolerate two roots cannot fix it. [RFC 8259]
- **Telemetry never on the result stream:** provenance goes to stderr/side-channel or is dropped; stdout stays the answer. [OpenTofu dual streams]
- **Guard by parsing roots, not counting lines:** a single pretty-printed value spans many lines; assert one root / zero trailing bytes.
