## Description

**Size:** S
**Files:** README.md (sitter), sitters/repin/watch.ts (read-only reference)

### Approach

Verify — do not assume — that the sitter fleet currently observes keeper's schema: keeper SCHEMA_VERSION is 102 (keeper repo src/db.ts:49) and sitter is believed to already pin 102, which would make this a process verification rather than a gap closure. Confirm the repin lane (sitters/repin/watch.ts) reads keeper's meta(schema_version) and that the pinned version matches; exercise `bun run repin-schema` only if the pin is actually stale. Write the verification procedure into the sitter README repin section if it is missing, so the next schema bump has a checklist. The deliverable is a verified-live confirmation channel for keeper dispatch observations, recorded in Done summary/Evidence.

### Investigation targets

**Required** (read before coding):
- sitter README repin-lane section (~lines 145-157) — the documented repin behavior
- sitters/repin/watch.ts — what the lane actually checks

### Test notes

Evidence is the observed pin value vs keeper's meta(schema_version), plus a live observation from the sitter fleet if one is cheaply demonstrable.

## Acceptance

- [ ] Sitter's pinned schema version verified against keeper's current meta(schema_version), with the check recorded
- [ ] `bun run repin-schema` run if and only if the pin was stale
- [ ] Verification procedure documented in the sitter README repin section

## Done summary

## Evidence
