## Description

Closes the TOCTOU window flagged by F1 (src/daemon.ts:2628-2644): the
confinement guard at line 2633 validates `realDoc` (from
`realpathSync(msg.doc_path)` at 2628), but `readFileSync` at line 2644
reads the unresolved `msg.doc_path`, so an in-dir symlink swapped after the
check could still escape the spill dir. Read the already-resolved `realDoc`
instead to close the window for free.

Bundles F2 (merged into F1): add an integration test (alongside the
out-of-dir block around test/integration.test.ts:590) for an in-dir symlink
whose target is out-of-dir, asserting it is rejected with the loud
out-of-dir ok:false. F1 and F2 share the same realpath-confinement code
region and land as one commit.

## Acceptance

- [ ] `readFileSync` in the request_handoff spill read uses the resolved
      in-dir path rather than `msg.doc_path`.
- [ ] An integration test creates an in-dir symlink -> out-of-dir target
      and asserts the out-of-dir ok:false rejection.
- [ ] The existing out-of-dir / empty / oversized / cannot-read branches
      remain green.

## Done summary
Read resolved realDoc instead of unresolved msg.doc_path in the request_handoff spill read, closing the TOCTOU symlink-swap window; added an in-dir-symlink->out-of-dir integration test asserting the loud out-of-dir ok:false.
## Evidence
