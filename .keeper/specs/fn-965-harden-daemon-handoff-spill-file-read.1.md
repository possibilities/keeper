## Description

Two findings on the daemon's handoff spill-file read path, bundled because
both touch `src/daemon.ts:2592-2631` and land as one commit.

F1 (daemon.ts:2601): `readFileSync(msg.doc_path, "utf8")` reads a fully
caller-controlled path verbatim and inlines the bytes into durable
`events.data` + the queryable `handoffs` projection. A foreign same-user
RPC caller hitting `request_handoff` directly can name any daemon-readable
path (e.g. `~/.ssh/id_ed25519`) and exfiltrate it. Resolve `doc_path` to an
absolute real path and assert it has `resolveHandoffSpillDir()` (src/db.ts:110)
as a prefix (and/or that the basename matches `<handoff_id>.txt`) BEFORE
reading; reject out-of-dir paths with a loud `ok:false`, consistent with the
existing missing/empty/oversized failures.

F3 (daemon.ts:2613 empty, daemon.ts:2623 oversized): the empty-file and
oversized-file `ok:false` branches are unexercised — the integration test
covers only happy-path + missing-file. Add a 0-byte spill file and a
>`HANDOFF_DOC_MAX_BYTES` (64KB) spill file and assert their distinct
`ok:false` error strings. Cover the new out-of-dir rejection branch from F1
in the same test.

## Acceptance

- [ ] `doc_path` resolving outside `resolveHandoffSpillDir()` is rejected with a loud `ok:false` before any file read; the legit CLI path (spill file under the dir) still succeeds.
- [ ] Tests assert the empty-file and oversized-file `ok:false` error strings, plus the new out-of-dir rejection.

## Done summary

## Evidence
