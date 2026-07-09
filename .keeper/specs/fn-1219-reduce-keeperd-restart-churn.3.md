## Description

**Size:** M
**Files:** scripts/daemon-load-roots.txt, scripts/daemon-fingerprint.ts, scripts/install.sh, test/daemon-load-surface.test.ts, test/helpers/depgraph.ts, test/reconcile-core-depgraph.test.ts, src/reconcile-core.ts, docs/install.md

### Approach

One checked-in roots manifest (scripts/daemon-load-roots.txt: one path per line, `#` comments, kept sorted) declares the daemon load surface: `src`, `plugins/plan/src`, `plugins/plan/subagents.yaml`, `package.json`, `bun.lock`, `plist/arthack.keeperd.plist`. One TS seam (scripts/daemon-fingerprint.ts) consumes it with pure decision code separated from git execution: `parseRootsManifest`, `composeRevParseArgs`, and `composeFingerprint` are pure and unit-tested; a thin main() executes `git rev-parse HEAD:<root> ...` as an argv array (no shell interpolation), folds the manifest file's own blob hash into the composite, prints the composite on stdout, and exits distinctly for a per-root resolution failure vs git being wholly unavailable. install.sh's source-changed gate then keys on the seam instead of whole-repo HEAD: per-root failure → exit 1 (loud red install — a manifest bug someone must fix); git wholly undeterminable → degrade to the plist gate alone exactly as today; keep the write-fingerprint-only-after-confirmed-load discipline and the existing fingerprint filename (the format change costs one benign extra bounce on rollout). The boundary test (fast tier, pure readFileSync — NO subprocess, NO git) extracts the closure walker from the reconcile-core depgraph test into test/helpers/depgraph.ts (refactor that test to consume the shared module, keeping its ratchet and self-tests intact) and extends it with two new edge classes: `new Worker(new URL("./x.ts", import.meta.url))` spawn edges — each seeded as an additional closure root, with the discovered worker-edge count asserted > 0 (the daemon spawns ~21; src/bus-worker.ts is reachable ONLY this way) — and attribute imports (`with { type: "json" }` / `{ type: "text" }`), which are real runtime edges (the embedded subagents.yaml and package.json imports). The test reads the manifest via the seam's parseRootsManifest (one parser — the hashed boundary and the enforced boundary cannot drift) and asserts every reachable in-repo path falls under a manifest directory root or equals a file root, with an injected-violation self-test. Rider: the slotKey template literal in src/reconcile-core.ts embeds a RAW 0x00 byte; replace it with the escaped form (the characters backslash-x-0-0 inside the literal — the identical code unit, never a different delimiter) so rg stops classifying the file as binary and silently truncating searches. docs/install.md gains a short operator note stating the reload-trigger contract.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- scripts/install.sh:80-144 — the reload gate: fingerprint block :96-103, confirmed-load write :137-142, degrade comment :88-95
- test/reconcile-core-depgraph.test.ts — walkClosure/parseImports/typeOnly/stripComments/resolveSource, the ratchet map, and the injected-violation self-test to extract and extend
- src/daemon.ts:6224-8306 — the new-Worker spawn sites the walker must learn to parse
- plugins/plan/src/subagents_config.ts:26 — the embedded text-attribute import of ../subagents.yaml (why that file is a manifest root)

**Optional** (reference as needed):
- src/agent/dispatch.ts:14 — package.json attribute import (second attribute-edge exemplar)
- src/reconcile-core.ts — slotKey literal carrying the raw NUL (byte offset ~71698)
- docs/adr/0029-daemon-load-surface-fingerprint.md — the decision record this task implements
- docs/install.md — operator doc to extend

### Risks

- A missed edge class silently narrows the enforced boundary — the worker-count assertion and injected-violation self-tests are the guard; treat an unresolvable dynamic import reaching daemon code as a failure, not a skip.
- The full-closure walk covers hundreds of modules; keep it pure file reads so it stays fast-tier.
- Never execute install.sh's reload path in-lane — it would bounce the host's live daemon mid-epic; shellcheck (via commit-work) plus the seam's own tests and an in-lane seam invocation are the verification surface.

### Test notes

`bun test` green including the new boundary test and the refactored reconcile-core depgraph test; running `bun run scripts/daemon-fingerprint.ts` twice in-lane (worker Bash — fine outside bun test) prints identical composites; rg matches src/reconcile-core.ts as text after the NUL fix.

## Acceptance

- [ ] A checked-in roots manifest exists and both the fingerprint seam and the boundary test consume it through one shared parser
- [ ] The fingerprint CLI prints a deterministic composite (two consecutive runs identical) and exits non-zero with a distinct message when a declared root fails to resolve at HEAD
- [ ] The fast suite contains a boundary test walking the daemon entrypoint's transitive closure — worker-spawn and attribute-import edges included, worker-edge count asserted positive — proving every reachable in-repo module falls under a manifest root, and an injected violation fails it
- [ ] The install script's reload gate keys on the seam's composite with the asymmetric failure directions (per-root failure loud, git-unavailable degrades to the plist gate) and still writes the fingerprint only after a confirmed load
- [ ] rg classifies src/reconcile-core.ts as a text file and the slotKey runtime value is unchanged
- [ ] docs/install.md states the reload-trigger contract; full fast suite green

## Done summary

## Evidence
