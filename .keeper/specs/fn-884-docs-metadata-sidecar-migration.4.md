## Description

**Size:** M
**Files:** a re-runnable migration script (keeper repo, e.g. scripts/docs-migrate.ts, importing src/sidecar.ts from task .1); operates on /Users/mike/docs (commits land there)

### Approach

Idempotent, dry-run-first migration over `~/docs` (853 `.md`, recursive). Reuse the strip-signature + sidecar logic from `src/sidecar.ts` (task `.1`) — do NOT re-derive the regex. Steps:
1. `git -C ~/docs tag pre-migration-<date>` before any write.
2. Dry-run pass: walk recursively; for each `.md`, classify {has-auto-stamp, has-sidecar, metadata-less}; print counts. ABORT if the auto-stamp match count is 0 (means the signature is wrong — the stamp is an EOF `---`/`## Metadata`/```yaml fence with INDENTED `session-id:`/```sh `claude --resume` block; a naive `^session-id:` matches nothing).
3. Strip ONLY auto-stamped blocks (full signature, EOF-anchored, gated on `session-id:` inside the fence). LEAVE hand-authored `## N. Metadata` sections. Verify each stripped file is strictly shorter (byte count).
4. Sidecars: create from the parsed block if absent; merge missing fields (esp. `gist-url`) if present; backfill SPARSE sidecars (`path`/`type: doc`/`created` from git first-commit or mtime) for metadata-less docs.
5. Fix ALL corrupted `gist-url`s (4 docs / 8 files: tui-ceding-control-to-another-tui, 2026-06-12-claudewrap-deep-dive-review, claude-dir-inventory, promptctl-dependency-map) with the bounded regex `https?://[^\s"'<>]+`.
6. SKIP `README.md`, `.git`, `.kit`. INCLUDE `archive/`. Commit in ~50-file tranches.

### Investigation targets

**Required:**
- src/sidecar.ts (task .1) — the shared strip-signature + sidecar read/merge/write
- a sample auto-stamped doc (e.g. ~/docs/pocketctl-ota-dev-approaches-2026-03-30.md) — confirm the exact EOF block shape before stripping
- ~/docs/promptctl-dependency-map.{md,yaml} — the corrupted gist-url shape

### Risks

- False-positive strip on hand-authored `## N. Metadata` (no `session-id:` in fence) — gate strictly. ~/docs is git-tracked → diff-review the first tranche before continuing.
- Re-runnable: a second run must be a no-op (already-stripped docs have no signature; sidecars already present).

### Test notes

Dry-run output (counts) is the first evidence. Spot-check 3-5 stripped docs + their sidecars by hand. Confirm a second run reports 0 changes.

## Acceptance

- [ ] dry-run prints non-zero auto-stamp match count; `pre-migration-<date>` tag exists
- [ ] all auto-stamped blocks stripped; hand-authored `## N. Metadata` untouched; every stripped file strictly shorter
- [ ] every `.md` (except README) has a sidecar; metadata-less docs got sparse sidecars; 4 corrupted gist-urls fixed
- [ ] second run is a no-op; changes committed to ~/docs in tranches

## Done summary
Built scripts/docs-migrate.ts (idempotent, dry-run-first) reusing src/sidecar.ts: stripped machine stamps from 335 docs (heading + bare-fence variants, incl. empty numbered-Metadata husks), backfilled/merged 823 .yaml sidecars, fixed corrupted gist-urls. Committed to ~/docs in 24 tranches after a pre-migration tag; second run is a clean no-op.
## Evidence
