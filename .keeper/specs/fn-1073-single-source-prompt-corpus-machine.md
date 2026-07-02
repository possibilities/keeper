## Overview

The prompt-snippet corpus is keeper's canonical-advice store, but the retrieval and render
machinery is broken from inside keeper: `keeper prompt render <ref>` resolves the project root
by walking to the nearest `.git`, and the corpus lives in the sibling arthack checkout, so every
render cite in keeper's skills fails in the repo that prints it. The managed-file render pipeline
(sha256 sidecars + PreToolUse block) exists but its automation is inert: promote.sh renders zero
plugins, check-generated emits a nonexistent regenerate path, and a fresh clone cannot spawn a
work:worker because rendered files are gitignored with no install/CI render. End state: renders
resolve from keeper, the pipeline regenerates and drift-checks in CI, a keeper-relevant corpus
subset is vendored with provenance, and keeper agent boots without arthack's stow package.

## Quick commands

- `keeper prompt render engineering/orient` — succeeds (today: unknown snippet id)
- `bash scripts/promote.sh` render step reports >0 plugins rendered (today: silent zero)
- `keeper prompt check-generated <rendered file>` prints a regenerate command whose paths exist

## Acceptance

- [ ] Every `keeper prompt render <ref>` cite that appears in keeper/plan skill bodies resolves from the keeper repo root
- [ ] Fresh-clone simulation (delete rendered outputs, run the install/CI render, run the suite) passes with work:worker spawnable
- [ ] Byte-verbatim bakes are lint-gated against their canonical snippets; the loose-pointer marker is a distinct marker
- [ ] Corpus carries zero orphaned snippets, zero unrendered [[wikilinks]], and a populated (or removed) used-in index
- [ ] `keeper agent` launches on a machine with no arthack checkout using keeper's shipped default plugins.yaml

## Early proof point

Task that proves the approach: `.1` (render resolution). If it fails: fall back to vendoring
FIRST (task .3) and pointing resolution at the vendored corpus only, dropping the arthack
fallback entirely.

## References

- plugins/prompt/src/project_root.ts — resolution walk
- plugins/prompt/src/render_plugin_templates.ts:236-276 — discoverPluginDirs scan set
- plugins/prompt/src/check_generated.ts:218,226-228 — regenerate-hint root bug
- Corpus authoring home: ~/code/arthack/claude/arthack/template/_partials/ (92 snippets, 11 bundles)
- Sidecar serialization is byte-frozen: sort_keys, indent=2, ensure_ascii=False, em-dash, trailing newline (render_plugin_templates.ts:28-36,147-153)

## Docs gaps

- **README.md**: "Load the plugins" manual step collapses to a one-liner once the shipped default plugins.yaml lands
- **plugins/plan/CLAUDE.md**: Running Things table gains the render/drift-lint row
- **/Users/mike/code/CLAUDE.md**: choosectl reference becomes devctl (landed by the corpus-hygiene task)

## Best practices

- **Vendored-subset pattern:** commit the subset plus a vendor.lock recording upstream SHA + filter rule; CI verifies the subset matches the locked SHA
- **Drift gate:** regenerate then `git diff --exit-code` in CI; hash content, never timestamps; mark committed renders linguist-generated
- **Generator invocation recoverable from the repo:** the exact render command lives in the repo, not in shell history
