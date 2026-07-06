## Description

Finding F1 (src/baseline-store.ts:133). The toolchain-fingerprint hash input
embeds a RAW NUL byte as the field delimiter between bunVersion and platform.
A literal NUL makes git classify the entire 697-line module as binary (the
commit shipped with no reviewable diff; the audit had to reconstruct the file
out-of-band), and it breaks grep, blame, and many editors on a
security-sensitive parser. Evidence: git show HEAD:src/baseline-store.ts
reports "Binary files differ" and file(1) reports "data"; the module contains
exactly one NUL byte at the baselineKey fingerprint delimiter.

Replace the literal NUL with a string escape sequence in the source so the
delimiter byte fed to fnv1a is unchanged — identical runtime bytes, identical
hash — while the file stays text and diffs normally. This is the only change;
do not touch the hash algorithm, the key shape, or any other field.

Files: src/baseline-store.ts

## Acceptance

- [ ] git show HEAD:src/baseline-store.ts is text (git diff renders it, file(1) reports a text type, no NUL bytes remain).
- [ ] baselineKey produces byte-identical output for the same input as before the change (fingerprint hash unchanged), covered by an existing or added pure unit assertion.

## Done summary

## Evidence
