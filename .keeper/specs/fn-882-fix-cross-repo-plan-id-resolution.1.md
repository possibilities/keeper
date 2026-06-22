## Description

**Size:** M
**Files:** plugins/plan/src/ (the keeper plan verb dispatch + project/id resolution), plus its tests

Make the id-addressed `keeper plan` verbs resolve a globally-unique id
regardless of cwd, so a cross-repo worker can stamp/read a task owned by
another repo's plan board.

### Approach

Find where the id-addressed verbs (`done`, `show`, `cat`, refine-context,
and any other taking a concrete `fn-N[.M]`) resolve their target. Today
they resolve the plan project from cwd only. Extend them to resolve
cwd-then-GLOBAL, reusing the SAME `resolve_epic_globally` helper that
`keeper plan epic add-deps` already uses (don't fork a new resolver). A
bare id resolves to its owning project wherever it lives; an ambiguous
legacy-dup id surfaces the same ambiguous signal add-deps emits. Leave
`list` project-scoped (it's a board view, not an id lookup). Confirm the
done path then writes/stamps into the OWNING project's store (the same
project the id resolved to), not the cwd project.

### Investigation targets

**Required** (read before coding):
- the `resolve_epic_globally` implementation + its add-deps call site (the pattern to reuse)
- the `done` / `show` / `cat` / refine-context verb handlers in plugins/plan/src and how they currently resolve the project from cwd
- `keeper plan detect` (cwd→project) and the multi-project discovery (how global resolution enumerates projects)

**Optional** (reference as needed):
- the cross-repo dispatch path (how target_repo becomes the worker cwd) to confirm no dispatch-side change is needed once resolution is global

### Risks

- Global resolution must not change single-repo behavior (cwd project still wins first); only fall through to global when the id isn't in the cwd project.
- Ambiguous/legacy-dup ids must surface a clear signal, not silently pick one project.
- The stamp must land in the OWNING project's on-disk store + commit there, not the cwd repo.

### Test notes

Regression test: create a task in plan project A, then from project B's cwd
run the done path and assert it resolves + stamps in A. Cover the
not-found and ambiguous cases too. Add to the appropriate tier (process-level
→ test:full).

## Acceptance

- [ ] id-addressed verbs (done/show/cat/refine-context) resolve cwd-then-global via the reused `resolve_epic_globally` helper
- [ ] a task in project A can be stamped done from project B's cwd; the stamp lands in A's store
- [ ] single-repo behavior unchanged (cwd project wins first); ambiguous ids surface a clear signal; `list` unchanged
- [ ] regression test covers the cross-repo stamp + not-found + ambiguous cases; tests green

## Done summary

## Evidence
