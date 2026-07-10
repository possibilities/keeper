## Description

**Size:** S
**Files:** docs/adr/00NN-*.md (pick a genuinely-unused number >= 0035), CLAUDE.md, CONTEXT.md

### Approach

Write a new ADR recording, in the existing MADR-ish context/decision/consequences shape (model it on a recent `003x` ADR): (a) global-instruction ownership for codex+pi moving to keeper — one keeper-owned `system/shared/AGENTS.md` materialized per-harness by the launch guard; (b) pi uses the always-on `AGENTS.md` CONTEXT-file channel, NEVER `SYSTEM.md` (which REPLACES pi's built-in prompt); (c) the divergence-policy split (hard-error for the claude leaf, warn-and-respect for codex/pi); (d) a terminology note disambiguating the two senses of "AGENTS.md" — the repo-convention symlink `AGENTS.md -> CLAUDE.md` (edit-in-place, never rm+recreate) vs the new self-healing shared-source LEAVES (delete the source, never the leaf). Pick a genuinely-unused ADR number >= 0035 (the index carries duplicate numbers — verify the chosen one is unused before writing). Add ONE line to CLAUDE.md near the existing "AGENTS.md is a symlink to this file" rule disambiguating the shared-source leaves from the repo symlink — keep `bun scripts/lint-claude-md.ts` green (consolidate, never append bloat). Add a CONTEXT.md glossary entry near the "Install and reload" section for the shared-instruction-source / canonical-leaf concept in house style (`**Term**: 1-2 sentence def. Avoid: rejected synonyms`). Forward-facing only — no fn-ids/dates/past-tense in CLAUDE.md/CONTEXT.md.

### Investigation targets

**Required** (read before coding):
- docs/adr/ — a recent `003x-*.md` for the template + numbering convention (verify the chosen >=0035 number is unused; duplicates exist in the index)
- CLAUDE.md:17 — the existing "AGENTS.md is a symlink to this file. Edit in place; never rm+recreate" rule (add one disambiguating line near it)
- CONTEXT.md — the "Install and reload" section for house style + placement
- scripts/lint-claude-md.ts — the size/content gate (stay green)

### Risks

- The CLAUDE.md line must not tip the lint gate (fails above 120 lines / 16 KiB, warns above 100) — consolidate an existing line if needed.

### Test notes

`bun scripts/lint-claude-md.ts` exits 0. Docs-only, no code tests.

## Acceptance

- [ ] A new ADR under `docs/adr/` (unused number >= 0035) records the ownership move, the pi-context-file-not-SYSTEM.md decision, the divergence-policy split, and the AGENTS.md terminology disambiguation.
- [ ] CLAUDE.md carries one line disambiguating the repo AGENTS.md-symlink rule from the self-healing shared-source leaves, and `bun scripts/lint-claude-md.ts` passes.
- [ ] CONTEXT.md has a house-style glossary entry for the shared-instruction-source / canonical-leaf concept.

## Done summary
Added ADR 0035 recording the shared global-harness-instruction ownership decision (keeper-owned system/shared/AGENTS.md, pi context-file channel, divergence-policy split, AGENTS.md terminology disambiguation), plus a CLAUDE.md disambiguating line and a CONTEXT.md glossary entry for the shared-source-leaf concept.
## Evidence
