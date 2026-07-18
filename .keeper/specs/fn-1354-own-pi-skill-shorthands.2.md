## Description

**Size:** M
**Files:** scripts/install.sh, scripts/CLAUDE.md, system/pi-extensions/skill-command-aliases.ts, system/pi-extensions/skill-command-aliases.test.ts, system/pi-extensions/package.json, tests/test_arthack_pi_resources.py

### Approach

After Keeper owns and tests the complete shorthand/discovery path, remove Arthack's global Pi alias extension package and stop provisioning Keeper's Hack and Plan links into Pi's skill directory. Narrow the installer composition rather than deleting the shared-skill helper wholesale: Codex keeps Hack/Plan, and Pi keeps Arthack-owned skills such as design-taste, mrtasty, Gmail, and tmux.

Add an idempotent, ownership-checked reconciliation for upgraded homes that removes only the known alias-extension symlink and Keeper Hack/Plan skill symlinks when their targets match Arthack's managed contract. Foreign real files, directories, and non-matching symlinks remain untouched and are reported. Keep the cleanup independently testable with a temporary home; running it against the live home is a post-finalize operator action, not task acceptance.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- scripts/install.sh:158 — ownership-aware skill-link installation and foreign-path preservation behavior.
- scripts/install.sh:190 — mixed Keeper/Arthack skill helper currently used by both Codex and Pi.
- scripts/install.sh:215 — global extension-link helper and replacement policy.
- scripts/install.sh:462 — harness-specific installer calls that must split Codex from Pi without collateral removal.
- scripts/CLAUDE.md:1 — installer source-of-truth guidance whose Pi ownership statement must match the new boundary.

**Optional** (reference as needed):
- system/pi-extensions/skill-command-aliases.ts:3 — source removed only after Keeper's dependent task lands.
- system/pi-extensions/skill-command-aliases.test.ts:65 — behavioral coverage relocated to Keeper before this test disappears.
- ../keeper/docs/adr/0091-keeper-owned-pi-shorthands-and-skill-discovery.md:1 — final repository and launch-scope ownership contract.
- CLAUDE.md:5 — build-forward migration and current-state documentation rules.

### Risks

Broad edits to `install_shared_agent_skills` can silently remove unrelated Pi skills or Codex Hack/Plan support. Deleting source before reconciling installed links leaves dangling global artifacts, while permissive target matching can delete user-owned state. Tests must not run the full installer against the operator's real home.

### Test notes

Add a sandboxed installer test with temporary source and destination roots. Prove fresh-install composition, exact-target stale-link removal, idempotent reruns, preservation of foreign files/symlinks, and continued Codex plus unrelated Pi skill provisioning. Also run the repository's shell syntax/lint checks applicable to `scripts/install.sh`.

## Acceptance

- [ ] A fresh Arthack install does not create the Pi alias extension or Pi Hack/Plan skill links, while Codex Hack/Plan and unrelated Arthack-owned Pi skills remain provisioned.
- [ ] An upgraded sandbox removes matching managed alias and skill symlinks idempotently but preserves and reports every foreign path at those names.
- [ ] The retired extension source, extension-local tests, and package metadata are absent, with their behavioral coverage present in Keeper first.
- [ ] Arthack's installer guidance describes only its remaining current responsibilities, and focused sandbox plus shell checks pass.

## Done summary

## Evidence
