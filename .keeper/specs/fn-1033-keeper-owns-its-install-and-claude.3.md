## Description

**Size:** M
**Files:** system/buildbot/master.cfg, scripts/install.sh

### Approach

Two arthack-side edits that complete the decoupling. Lands AFTER tasks 1-2 and
the operator cutover, so arthack stops owning `~/.claude` symlinks only once
keeper's guard has taken over.

1. **Buildbot `keeper-install` job.** Add an `install` sub-block to keeper's entry
   in the `PROJECTS` registry (master.cfg:61-74). It yields a `keeper-install`
   builder that green-gates (Dependent) on keeper's build and reuses its poller
   (master.cfg:360-372); its single step runs `bash scripts/install.sh` with
   `workdir = /Users/mike/code/keeper` — which MUST equal keeperd's checkout so the
   module-path guard and the daemon agree on the source. If a plist-change gate is
   wanted, model it on sitter's precedent (master.cfg:177-180).
2. **Decouple arthack/scripts/install.sh.** Drop the `claude` case from
   `stow_system()` (install.sh:34) and the `bun link` step (install.sh:610-616).
   LEAVE arthack's legitimate keeper-DEPENDENCY verifies untouched: keeper-py
   editable path (:318-338), plan-plugin presence (:342-357), and
   `keeper prompt render-plugin-templates --project-root $PROJECT_ROOT` (:386,
   which renders ARTHACK's own templates).

### Investigation targets

**Required** (read before coding):
- system/buildbot/master.cfg:61-74 (keeper PROJECTS entry), 309-372 (normalize_jobs install/deploy wiring), 177-180 (sitter gated-reload precedent), 21 (checkconfig gate)
- scripts/install.sh:28-119 (`stow_system`, the `claude` case :34), 610-616 (the `bun link` step), 318-357 (keeper-dependency verifies to KEEP)

### Risks

- Ordering: do not drop arthack's `claude` stow case until keeper's guard owns `~/.claude/{settings.json,CLAUDE.md}` on the box (after task 1 + the operator cutover) — else a window with no owner → guard warn+skip → possible profile-farm hard-error.
- The buildbot install builder's checkout path must equal keeperd's (`/Users/mike/code/keeper`).
- Do NOT touch arthack's keeper-dependency verifies (arthack depending on keeper is not the same as installing keeper).

### Test notes

- Run the buildbot `checkconfig` gate (master.cfg:21) after editing master.cfg; confirm the `keeper-install` builder appears and green-gates on keeper's build.

## Acceptance

- [ ] `keeper` `install` sub-block added to `PROJECTS` → a `keeper-install` Dependent builder running `bash scripts/install.sh` (workdir `/Users/mike/code/keeper`), green-gated on keeper's build; `checkconfig` passes
- [ ] arthack/scripts/install.sh: the `claude` stow case (:34) and the `bun link` step (:610-616) removed
- [ ] arthack's keeper-dependency verifies (keeper-py, plan-plugin, render-plugin-templates) left intact
- [ ] Lands after task 1 + the operator cutover — no `~/.claude` ownership gap

## Done summary
keeper-install buildbot builder now runs keeper's own scripts/install.sh (workdir /Users/mike/code/keeper), Dependent-gated on keeper's green build; arthack/scripts/install.sh drops the claude stow case and the keeper bun link step while keeping keeper-dependency verifies. checkconfig passes.
## Evidence
