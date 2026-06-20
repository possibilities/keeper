## Description

Originating finding F4. The three-branch pill assembly at `scripts/board.ts:785-799` — dangling (`?#N`), intra-project (`#N`), cross-project (`prefix::#N`) — is the user-visible output of the fn-635 cross-project dep resolver but has no direct test assertions. `resolveEpicDep` is fully covered in the readiness suite; the board glue composing it is not. Because `renderEpicBlock` is a private closure inside `main()`, tests will likely need to extract the pill-assembly branches into a small exported helper, or drive them via the board's full render with a minimal fixture. Evidence path: board.ts:785-799, auditor Test Gaps #1.

## Acceptance

- [ ] Dangling dep: `?#<num>` appears in output when `resolveEpicDep` returns `dangling` with a parseable number
- [ ] Intra-project dep: `#<num>` appears when resolved with `cross_project === null`
- [ ] Cross-project dep: `<prefix>::#<num>` appears when resolved with a non-null `cross_project` basename

## Done summary
Extracted the three-branch pill assembly from renderEpicBlock into an exported renderEpicDepPills helper and added direct assertions for the dangling (?#N), intra-project (#N), and cross-project (<prefix>::#N) shapes.
## Evidence
