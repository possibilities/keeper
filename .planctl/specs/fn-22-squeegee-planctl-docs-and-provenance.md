## Overview

Shrink planctl's CLAUDE.md from ~24,000 chars of paragraph-brick orchestration prose to terse trip-wire rules backed by reference docs, and sweep fn-NNN provenance out of Python source, tests, and the commit contract doc. The repo already bans backward-facing advice in its own CLAUDE.md — this epic makes the repo obey its own rule.

## Scrub standard

DELETE/REWRITE: fn-NNN ids used as provenance ("fn-12 crush rebuilds...", "(fn-587 and later)", "fn-622: session_id is preserved...") — restate as present-tense fact without the id. KEEP: fn-ids that are data, not history — docstring format examples (api.py's `fn-1-slug.3`), test fixture ids (`fn-1`), regression-guard test names that map to a `docs/reference/planctl-bug-history.md` anchor (verify each against that doc), and everything inside planctl-bug-history.md plus the CLAUDE.md "Removed verbs" list (the two sanctioned history carriers). In `commit_messages.py` / `validation_restamp.py`, the `# fn-NNN:` comment prefixes on canonical verb maps get scrubbed to present-tense notes — the mapped string VALUES are load-bearing, never touch them.
PROTECTED, never delete: `# noqa`, `# type: ignore` (and its first-position ordering on the line), `# ty: ignore`, `# pragma: no cover`, `# fmt: off/on`, shebang lines, `@pytest.mark.*` lines adjacent to scrubbed comments (a dropped marker is a collection error under --strict-markers).
CLICK DOCSTRINGS ARE BEHAVIOR: command-function docstrings render as `--help` text. When scrubbing one, remove only the provenance phrase; never restructure paragraphs, never touch `\b` or `\f` marker lines, never alter the first sentence (it is the short_help). Module docstrings not consumed by Click may be rewritten freely under the standard.
If uncertain whether an fn-ref is provenance or data: KEEP IT.

## Verification (every task)

`uv run pytest tests/ --run-slow` green; `uv run ruff check .`, `uv run ruff format --check .`, `uv run ty check` green; for Click-command files additionally eyeball `planctl <verb> --help` output unchanged where docstrings were touched. Done summaries report lines AND characters deleted.

## Quick commands

- `grep -rcE 'fn-[0-9]+' planctl/*.py | grep -v ':0'` — residual fn-ref count per source file
- `wc -c CLAUDE.md` — char mass after restructure

## Acceptance

- [ ] CLAUDE.md is trip-wires + pointers; Commit behavior section reduced to a one-line pointer; Skills and agents lives in docs/reference/
- [ ] commit-at-mutation-boundary.md carries zero provenance fn-refs while staying authoritative
- [ ] planctl/*.py and tests/ carry fn-refs only where they are data (examples, fixtures, bug-history-anchored test names)
- [ ] Full slow suite + ruff + ty green after every task
- [ ] Done summaries report lines/chars deleted

## Early proof point

Task that proves the approach: ordinal 1 (the restructure — if the new reference doc + pointer shape reads well, the scrub tasks are mechanical). If it fails: keep CLAUDE.md sections in place and only strip provenance ids, no relocation.

## References

- docs/reference/ house format: `# Title` / `**Status:** Authoritative` header, present-tense, cross-reference siblings instead of duplicating
- CLAUDE.md pointer idiom: a trailing `Full contract: docs/reference/<file>.md` line
- AGENTS.md is a SYMLINK to CLAUDE.md (as is .planctl/AGENTS.md) — never edit separately, never replace with a copy

## Docs gaps

- **docs/reference/skills-and-agents.md**: new home for the Skills-and-agents orchestration manual (task 1)
- **README.md**: optionally add a pointer to the new reference doc — one line max

## Best practices

- **Delete duplicates, don't move them:** the Commit behavior body already lives in commit-at-mutation-boundary.md — collapse, don't migrate
- **Doctest blocks are opaque:** never reflow text inside `>>>` blocks
