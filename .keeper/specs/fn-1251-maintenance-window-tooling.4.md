## Description

**Size:** S
**Files:** CONTEXT.md or docs/install.md (whichever is the right home)

### Approach

Add a short, discoverable runbook entry — "Offline DB reclaim maintenance window" —
that points at the one-command wrapper from task .2 as the supported path, so a
future agent finds it in one doc read instead of grepping src/backup.ts. Forward-
facing only (no fn-ids/dates/provenance per docs discipline); keep the code-rendered
runbook (`reclaimInstructions`) as the detailed source of truth and have the doc
point at it + the wrapper. Choose the right home (CONTEXT.md glossary vs docs/install.md
Backup & restore section).

### Investigation targets

*Verify before relying — the repo moves.*

**Required:**
- docs/install.md — existing "Backup & restore" section (candidate home)
- CONTEXT.md — glossary (candidate home if a term is warranted)
- task .2's wrapper command name — what the doc points at

## Acceptance

- [ ] A short runbook entry names the supported one-command maintenance-window path and where its detailed runbook lives, discoverable in one read.
- [ ] The entry is forward-facing (no fn-ids/dates/provenance) per docs discipline.

## Done summary
Added a short pointer in docs/install.md's Backup & restore section to bun scripts/maintenance-window.ts as the supported one-command offline reclaim path, alongside the existing reclaimInstructions() detailed runbook.
## Evidence
