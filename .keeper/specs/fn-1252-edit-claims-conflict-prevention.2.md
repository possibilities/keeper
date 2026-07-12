## Description

**Size:** M
**Files:** plugins/plan/src/edit_claims.ts (new), plugins/plan/src/verbs/scaffold.ts, plugins/plan/src/specs.ts, plugins/plan/src/emit.ts, the refine-apply verb module, docs/problem-codes.md, plugins/plan/test/saga-scaffold.test.ts, plugins/plan/test/src-specs.test.ts, plugins/plan/test/src-edit-claims.test.ts (new)

### Approach

Introduce the structured edit-claims contract (see CONTEXT.md: Edit claim) in one new
pure module owning parse, validation, and render. A claim is exactly one of
`path` / `glob` / `resource` plus optional `certainty` (`expected` default,
`possible`). Validation is loud and collect-all: exactly one kind key per entry;
paths repo-relative and normalized (strip `./`, no trailing slash; reject `..`,
absolute, backslash); globs validated and complexity-bounded with pinned semantics
(`*` never crosses `/`; no `**` — a dep-free linear matcher mirroring the keeper-root
fnmatch approach, since the plan plugin cannot import keeper-root src); resource is a
lowercase-kebab free-form token. Scaffold and refine-apply add_tasks REQUIRE the
field per task entry — missing mints a new `claims_invalid` code (registered in the
problem-code registry and docs/problem-codes.md, slotting into the collect-all
cascade after spec_invalid); an explicit empty list is legal and means "no
predictable repo writes." Claims persist on the task JSON alongside tier/model, and
the spec markdown's `**Files:**` line becomes a deterministic derived render of the
claims injected under ## Description at write time, replacing any hand-authored line
— derived means derived, no validate-against mode. The epics-projection copy-through
is deliberately NOT part of this task (no reducer change; the four-site slot-order
invariant stays untouched).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/verbs/scaffold.ts:364-598 — the per-task validate loop and collect-all error cascade the claims validation joins; :1183 — inMemTaskDefs assembly where the field persists
- plugins/plan/src/specs.ts:122 — validateTaskSpecHeadings, the current spec-body validation the derived render sits beside
- plugins/plan/src/emit.ts:244 — the problem-code registry claims_invalid registers in
- src/glob.ts — the keeper-root dep-free fnmatch (isGlobToken/compileFnmatch, ReDoS-safe, non-separator-crossing) to mirror, not import
- plugins/plan/src/store.ts — atomicWriteJson and friends; all state writes route through these

**Optional** (reference as needed):
- plugins/plan/test/src-specs.test.ts — the frozen-golden byte-parity pattern the render tests follow
- plugins/plan/README.md — the plan.yaml schema section that documents task entry fields

### Risks

- The refine-apply verb must gain exact parity (add_tasks entries carry claims; rewrite_specs must not clobber the derived line) — locate its module and saga test rather than assuming names
- Legacy committed tasks carry no claims — every reader must treat absence as vacuous, never throw

### Test notes

Golden byte tests for the derived render (same input claims → identical Files: line);
saga tests for the claims_invalid envelope (missing field, malformed kind, bad glob,
path escape — all collected in one pass); explicit-empty-list passes.

## Acceptance

- [ ] Scaffolding a task without edit_claims fails with claims_invalid naming every offending task in one pass; an explicit empty list passes
- [ ] Invalid claim values (path escape, absolute path, backslash, malformed or over-complex glob, multiple kind keys) are rejected loudly with claims_invalid, never silently normalized
- [ ] A scaffolded task's JSON carries its claims and its spec's Files: line is byte-deterministically derived from them, replacing any hand-authored line
- [ ] refine-apply add_tasks enforces and persists claims identically; rewrite_specs preserves the derived line
- [ ] docs/problem-codes.md carries the claims_invalid row in the same change

## Done summary

## Evidence
