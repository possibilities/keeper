## Overview

`/plan:prompt` is a new interactive prompt-polishing loop in the plan plugin: the argument is a raw
prompt, and the skill does nothing but make that prompt better for the working/planning agent that
will eventually read it — one small human-approved change per turn, toward a named word-count
target, until "ready". One static hand-authored SKILL.md plus two one-line doc index edits; no
code, no daemon surface, read-only with respect to the repo, clipboard-only export.

## Quick commands

- `head -12 plugins/plan/skills/prompt/SKILL.md` — frontmatter sanity: slash-only (`disable-model-invocation: true`) and the read-only lockdown (`disallowed-tools`) present
- In a live session: `/plan:prompt "add a login page"` — expect a target-rung announcement and one before → after proposal, with no file writes

## Acceptance

- [ ] `/plan:prompt` runs as a slash-only interactive loop: one approved change per turn toward an announced named size target from the six-rung ladder
- [ ] Displayed prompt and clipboard copy are byte-identical; nothing is ever written to disk
- [ ] Plan plugin docs index the new skill (README skills table + CLAUDE.md one-liner)

## Early proof point

Task that proves the approach: `.1` (the only task). If it fails: tighten the SKILL prose against the smoke-run transcript — the contract is fully specified, so failure is wording, not structure.

## References

- `~/docs/2026-07-01-staltz-agent-verbosity-word-counts.md` — source word-count ladder (Staltz verbosity thread)
- `plugins/plan/skills/close/SKILL.md` — read-only lockdown frontmatter precedent (allowed-tools + disallowed-tools + disable-model-invocation)
- `plugins/plan/skills/defer/SKILL.md` — state-it-back approval voice and injection-guard wording precedent

## Docs gaps

- **plugins/plan/README.md**: add a `/plan:prompt` row to the Planning Skills table (deliverable of task 1, tracked here)
- **plugins/plan/CLAUDE.md**: add the static-skill one-liner for `/plan:prompt` (deliverable of task 1, tracked here)

## Best practices

- **Constraint polarity preservation:** compression's most dangerous artifact is softening modality ("must not" → "try not to"); every rewrite gets a modal-shift check [EMNLP 2025 prompt-compression research]
- **One change per turn:** bundled proposals cause anchoring and rubber-stamping; a single before → after keeps accept/reject unambiguous [approval-fatigue literature]
- **Full-prompt redisplay:** diff-only views cause intent drift across turns — the verbatim block is also the only persistence mechanism [practice-scout synthesis]
- **Quoted-heredoc clipboard:** `pbcopy <<'DELIM'` keeps `$`, backticks, and escapes literal; unquoted echo-pipes mangle them [Greg's Bash Wiki]
