## Overview

The root `CLAUDE.md` grew to 547 lines / 40KB by accreting one
architecture-narration paragraph per feature — past the point where Codex
silently truncates the `AGENTS.md` symlink (a 32 KiB `project_doc_max_bytes`
cap), and dense enough to dilute the ~15 rules that actually change agent
behavior. Twice-tried manual compression has decayed each time. This epic
strips the file to ~80–100 imperative guardrails (relocating the "how it
works" prose to README `## Architecture`, its established home) and makes the
cut durable with a content+size lint wired into `keeper commit-work`'s lint
matrix — so a re-narrating CLAUDE.md edit fails the commit instead of
relying on discipline.

## Quick commands

- `bun scripts/lint-claude-md.ts`   # exits 0 on the stripped file, 1 on any size/content violation
- `wc -l CLAUDE.md`                  # ~80–100, must be <=120
- `printf 'fn-999 narrate\n' >> CLAUDE.md && bun scripts/lint-claude-md.ts; git checkout CLAUDE.md`   # proves the content gate fires

## Acceptance

- [ ] CLAUDE.md is <=120 lines / <=16KB, only imperative guardrails, every definite-keeper rule preserved
- [ ] `scripts/lint-claude-md.ts` gates size + re-narration fingerprints (fn-NNN, lowercase version numbers, ISO dates, past-tense provenance) with no false positive on `SCHEMA_VERSION` / "would otherwise"
- [ ] the lint runs inside `keeper commit-work`'s matrix (linter="claude-md") only when CLAUDE.md is staged, a no-op elsewhere
- [ ] architecture/rationale prose relocated to README `## Architecture`; the 4 README back-references updated to resolve
- [ ] the docs-prune rule lifted to CLAUDE.md as rule #0, naming the lint script

## Early proof point

Task that proves the approach: `.1` (the lint script + the commit-work matrix arm). If it fails — the matrix arm can't be made a clean no-op in other repos, or the version-number regex can't avoid the `SCHEMA_VERSION` false-positive — fall back to a standalone `bun run lint:claude-md` wired into the `test:full` tier instead of the commit-work matrix.

## References

- `scripts/lint-no-real-git.ts` — the lint template (pure exported `scanText`, `main():number`, `if (import.meta.main) process.exit(main())`)
- `src/commit-work/lint-matrix.ts:183` — `runScopedLint`, the gate to extend; the `cli-boundaries` arm at `:258` is the `existsSync`-gated script shell-out model
- `README.md:1552` — `## Architecture`, the relocation destination (flat **bold-lead-in** prose; it legitimately carries fn-/version history, so the lint must NOT point at it)
- `plugins/plan/template/agents/worker.md.tmpl:212` — the docs-prune rule lifted verbatim to rule #0 (it does not quote the banned phrases, so the lift is lint-safe)
- Overlaps: open epics fn-938 and fn-940 also edit CLAUDE.md/README; this epic is dep-wired to run after them so the strip has final say over the file shape
- Codex caps AGENTS.md project docs at 32768 bytes and silently drops the remainder — the correctness motivation for the <=16KB target

## Docs gaps

- **README.md**: absorb the relocated event-sourcing / autopilot / bus / process prose into `## Architecture` in the bold-lead-in register, collapsing duplicates rather than appending; update the back-references at README.md:296, 676, 1749, 3401-3402 that point at moved/renamed CLAUDE.md sections
- **plugins/plan/CLAUDE.md:51**: optional one-line `bun run lint:claude-md` pointer in its lint table

## Best practices

- **Keep/cut test (Anthropic):** "Would removing this line cause the agent to make a mistake? If not, cut it." — the acceptance bar for the strip
- **Dual gate (size + content):** a line cap alone incentivizes cramming terser-but-still-narrative prose; the content regex is what actually stops re-narration
- **Scope to the literal CLAUDE.md path:** README and plugins/plan/CLAUDE.md legitimately carry fn-/version history, and a glob would double-hit the AGENTS.md symlink — scan the one file
