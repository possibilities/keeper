## Description

**Size:** S
**Files:** plugins/prompt/src/cli.ts, plugins/prompt/src/render.ts, plugins/prompt/src/find_snippets.ts, plugins/prompt/src/project_root.ts, plugins/prompt/src/build_snippets.ts

### Approach

Give the `render` and `find-snippets` verbs the `--project-root` flag that
`render-plugin-templates` already has (cli.ts:191-193 passes null; render.ts:227 calls
resolveProjectRoot(null)), and add a corpus-aware fallback: when the resolved root has no
corpus, fall back to the configured authoring home so renders work from any repo. Fix the two
messages in find_snippets.ts:72,80 that reference the phantom `list-snippets` verb — add a real
`list-snippets` verb (unranked enumeration; only `list-bundles` exists today). Populate the
`used-in` reverse index from a consumer scan during `build-snippets` (every snippet id shows
which bundles/skills reference it), or if that proves disproportionate, delete the dead field
everywhere and note it in the epic. Behavioral bar, not keystrokes: an agent in any repo can
discover, list, and render any snippet without cd-ing.

### Investigation targets

**Required** (read before coding):
- plugins/prompt/src/project_root.ts — the .git walk and the no-repo fallback branch
- plugins/prompt/src/cli.ts:191-202 — render vs render-plugin-templates flag asymmetry
- plugins/prompt/src/find_snippets.ts:72,80 — phantom verb messages

**Optional** (reference as needed):
- plugins/prompt/src/build_snippets.ts — where the index is built, for used-in population

### Risks

- A global fallback to the arthack authoring home reintroduces the cross-repo coupling this epic reduces; keep the fallback config-driven so task .3's vendored corpus can become the primary source without another engine change.

### Test notes

Engine has its own test tier under plugins/prompt; add coverage for --project-root and the
fallback (resolution decisions through a pure seam, no real git). Verify by running
`keeper prompt render engineering/orient` from the keeper root.

## Acceptance

- [ ] `keeper prompt render <ref>` and `keeper prompt find-snippets` accept --project-root and succeed from the keeper repo without it
- [ ] `keeper prompt list-snippets` exists and the find_snippets messages reference real verbs only
- [ ] used-in is populated by build-snippets from a consumer scan, or removed everywhere with the band-aid note in arthack CLAUDE.md deleted

## Done summary
render and find-snippets now accept --project-root and resolve the corpus from any repo via a config-driven (KEEPER_PROMPT_CORPUS_ROOT) fallback when the .git root holds no corpus; added the list-snippets enumeration verb, making find_snippets' phantom-verb hints real. used-in was already populated by build-snippets (findUsages).
## Evidence
