## Description

Finding F1 (cli/jobs.ts:660-667). The `v`-focus handler's comment block
describes the OLD pluggable-backend behavior: "The backend is resolved PER
ROW from `backend_exec_type` ... every type resolves to the tmux backend in
`resolveExecBackend`". The code below (line ~714) was changed to call
`createTmuxPaneOps({ ... })` directly with no per-row `backend_exec_type`
resolution, and `resolveExecBackend` was deleted in this epic. The inline
comment at lines 711-713 already states the correct direct-seam reality.
Trim the stale block at 660-667 to the direct-seam reality so no comment
names a deleted symbol.

## Acceptance

- [ ] The comment block above the `v`-focus handler no longer references `resolveExecBackend` or per-row `backend_exec_type` resolution
- [ ] The comment accurately describes the direct `createTmuxPaneOps` seam and the NULL session/pane skip

## Done summary
Trimmed the stale v-focus comment in cli/jobs.ts to the direct createTmuxPaneOps seam reality, removing the deleted resolveExecBackend symbol and per-row backend_exec_type resolution references.
## Evidence
