## Overview

`keeper transcript` becomes a multi-harness forensics surface: the harness is a required leading positional (`keeper transcript <claude|pi|codex> <list|show|<session-id>>`, mirroring `keeper agent`), and pi + codex sessions become listable and extractable through per-harness Transcript readers that fold each on-disk format into the existing harness-neutral model. The renderer and pagination pipeline are untouched; every harness difference lives behind a small `TranscriptReader` interface with a registry whose key set is its own membership root (hermes deliberately absent — its history lives behind `hermes sessions export`).

## Quick commands

- `keeper transcript claude list --since 7d` — claude listing unchanged under the new grammar
- `keeper transcript pi list --global --limit 5 && keeper transcript codex list --since 7d` — new readers list real sessions
- `keeper transcript hermes list; test $? -ne 0` — reader-less harness fails loud
- `bun test test/transcript-cli.test.ts test/transcript-pi.test.ts test/transcript-codex.test.ts`

## Acceptance

- [ ] Harness is a required leading positional for list/show/bare-id; the `--harness` flag no longer parses; bare `keeper transcript`, `--help`, `--agent-help`, and a harness token with empty rest print help.
- [ ] `keeper transcript pi …` and `keeper transcript codex …` list and extract real sessions with bounded paging, and `--tools`/`--thinking`/`--role`/`--since`/`--grep` behave as they do for claude.
- [ ] Claude behavior is preserved modulo the grammar: the pre-existing suite passes with only the positional prepended.
- [ ] An unregistered harness token (hermes included) exits non-zero naming the supported set derived from registry keys.
- [ ] The pi-extension transcript tool emits the positional grammar and stays claude-only.

## Early proof point

Task that proves the approach: `.1` (reader seam + harness-first grammar, claude behavior-preservation proven by the re-spelled suite). If it fails: shrink `.1` to the reader seam alone and re-plan the grammar flip as its own task — the seam is independent of the break.

## References

- Overlap: `fn-1239` (replace usage with account routing) — both edit `cli/descriptor.ts` (distinct regions) and `README.md` (distinct sections); dep edge wired to serialize the merges.
- Format reference implementations (re-express locally, never import): `src/agent/transcript-watch.ts` (encodePiCwd, readPiMeta, readCodexRolloutMeta), `src/agent/codex-session-index.ts` (codexSessionIdFromRolloutPath, windowDayDirs, readSessionMeta bounded head read).
- Authoritative codex on-disk schema: openai/codex `codex-rs/protocol/src/protocol.rs` (RolloutLine/RolloutItem/SessionMetaLine) and `codex-rs/core/src/rollout.rs` (head readers, ARCHIVED_SESSIONS_SUBDIR).
- pi format: pi-mono `session-format.md` (session versions 1-3, id/parentId tree links, `--…--` dir encoding).

## Docs gaps

- **README.md**: update the History-forensics bullet — `keeper transcript <harness>` grammar, pi/codex now extractable (consolidate with the existing multi-harness events-log claim).
- **docs/plugin-composition-map.md**: optional — add `keeper transcript <harness>` only if the map aspires to enumerate the harness-positional CLI family.

## Best practices

- **Unknown line/entry types fold to a skip, never throw** — codex RolloutItem has 8+ variants (world_state, inter_agent_communication, compacted beyond the mapped set), pi has 12+ entry types; a closed match breaks on the next CLI release, and one bad JSON line aborting a read is codex's own shipped bug (openai/codex#24425).
- **Bound every read** — per-line byte cap before JSON.parse (attacker-influenced content), head-slice-only reads for list scoping, mtime + day-dir pre-filters before opening codex files.
- **Order codex entries by the top-level RolloutLine timestamp** — session_meta carries a second inner timestamp; the outer one is canonical.
- **Never render codex encrypted reasoning** — response_item.reasoning is ciphertext; readable reasoning comes only from event_msg.agent_reasoning*.
- **Path-scope session roots** — resolve ids under the harness's sessions tree only; reject separator/`..` escapes in session-id tokens (claude's isSafeSessionId precedent).
- **codex archived/ is deliberately excluded** — the YYYY/MM/DD walk skips ARCHIVED_SESSIONS_SUBDIR; a code comment states the exclusion is intentional.
