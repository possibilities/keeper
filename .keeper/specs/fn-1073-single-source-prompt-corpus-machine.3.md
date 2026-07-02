## Description

**Size:** M
**Files:** plugins/prompt/ (vendored corpus location), vendor.lock (new), scripts/ (drift lint), plugins/plan/skills/hack/SKILL.md, plugins/keeper/skills/{autopilot,await,dispatch,handoff}/SKILL.md

### Approach

Vendor the keeper-relevant snippet subset into keeper (the snippets keeper/plan skills cite plus
the bundles they belong to), with arthack remaining the authoring upstream: commit the subset
plus a vendor.lock recording the upstream commit SHA and the filter rule; a CI step verifies the
vendored subset matches the locked upstream state. Point render resolution (task .1's
config-driven source) at the vendored corpus first. Split the overloaded marker: byte-verbatim
bakes (hack/SKILL.md, 4 sites) get explicit begin/end bake guards and a byte-equality lint that
re-renders each bake and asserts identity; the four keeper-skill orient sites keep their
skill-specific summaries under a distinct pointer marker that the lint ignores. Run after the
corpus-hygiene task so the vendored SHA captures the cleaned canonicals.

### Investigation targets

**Required** (read before coding):
- grep -rn "Canonical source" across the repo — the 8 marker sites and their two semantics
- plugins/plan/skills/hack/SKILL.md — the 4 bake sites (keeper-history-forensics, docs-dir-and-gist-open, escalate-inline-or-plan, commit-via-keeper-default)
- ~/code/arthack/claude/arthack/template/_partials/ — corpus layout, bundle membership for the cited snippets

**Optional** (reference as needed):
- plugins/prompt/src/render.ts — readSnippetBody, for the lint's render step

### Risks

- Two-way drift: arthack edits after vendoring go unseen until the lock is bumped — acceptable by design (the lock IS the review point); the CI verify makes it visible, never silent.
- Subset selection: err toward including a bundle whole rather than cherry-picking members, so bundle renders stay coherent.

### Test notes

Lint proof: mutate one byte inside a bake guard locally, byte-equality lint goes red; restore,
green. vendor.lock verify: bump a vendored file without bumping the lock, CI verify goes red.

## Acceptance

- [ ] Keeper-relevant subset vendored with vendor.lock (upstream SHA + filter rule) and CI verification
- [ ] Bake sites carry begin/end guards; byte-equality lint gates them; pointer sites use a distinct marker the lint ignores
- [ ] Render cites in keeper/plan skills resolve against the vendored corpus from the keeper root

## Done summary
Vendored the keeper-relevant snippet subset (engineering + source-dirs domains + engineering-rules bundle) under plugins/prompt/corpus with a vendor.lock (upstream sha + filter rule + sha256 manifest); render resolution defaults to it so a fresh clone renders every keeper/plan cite with no arthack checkout. Split the overloaded marker into BAKE:BEGIN/END guards (byte-equality lint) and a distinct POINTER marker; scripts/vendor-corpus.ts + the prompt suite gate hash, bake identity, and cite resolution.
## Evidence
