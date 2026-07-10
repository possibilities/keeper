## Overview

`keeper transcript` landed (commit 6fa1650e) with one high-severity discovery bug and
several robustness gaps surfaced by a verified deep review. This epic makes session
discovery correct for every real project path (Claude bucket encoding), makes pagination
coordinates self-consistent, makes listing fault-tolerant against the live-mutating
transcript tree, makes the character budget honest, and hardens the pi-extension bridge
against oversized or malformed model-supplied parameters. Fixes only — no new surface.

## Quick commands

- `bun test test/transcript-cli.test.ts test/pi-extension.test.ts`
- `cd <a worktree lane whose path contains a dot> && keeper transcript list` — must list that lane's sessions

## Acceptance

- [ ] `keeper transcript list`/`show --project` find sessions for project paths containing dots/underscores (worktree lanes)
- [ ] Human entry labels round-trip with `--offset`/`--before`, and human output never exceeds the requested `--max-chars`
- [ ] A file vanishing between scan and parse degrades one row, never the whole list
- [ ] The pi `keeper_transcript` tool bounds its params, reports clamps, and returns partial output (not failure) on buffer overflow

## Early proof point

Task that proves the approach: task 1 (encoder fix pinned by a hard-coded literal-bucket fixture).
If it fails: the char-class encoding rule is wrong for some path class — fall back to probing both encodings per bucket at discovery time.

## References

- Commit `6fa1650e` — the feature under hardening
- Live reproduction: dotted worktree-lane cwd bucket `…custody-5` exists with sessions; dotted `--project` returned `range: [0, 0) of 0`
- GenesisTools `src/utils/claude/projects.ts` — the identical separator-only encoder bug in the wild (cautionary)
- Node `child_process` docs — `maxBuffer` byte semantics, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` carries truncated stdout
- TypeBox — validation keys off `Symbol.for("TypeBox/Kind")`; string-keyed markers are suspect

## Best practices

- **Encode buckets as `replace(/[^A-Za-z0-9]/g, "-")`:** verified multi-source (official docs + community + GH issue); per-char, non-collapsing [practice-scout]
- **Read-and-catch, never existsSync-then-read:** the transcript tree mutates live under the reader (TOCTOU) [practice-scout]
- **Branch child-process errors on `error.code`, not message text:** maxBuffer overflow is a RangeError with code `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` [Node docs]
- **`maxBuffer` counts bytes, char budgets count UTF-16 units:** clamp char params assuming ≤4 bytes/char worst case [Node docs]
- **Keep pagination wording tool-local:** CONTEXT.md reserves "cursor" for the fold cursor — help text says offset/page boundary, never cursor [docs-gap-scout]
