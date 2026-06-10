## Description

**Size:** S
**Files:** README.md, cli/keeper.ts, CLAUDE.md, skills/await/SKILL.md

### Approach

Document the now-shipped snapshot contract once all five mains carry the
flags (hence deps on .2 and .3).

- `README.md` `## Architecture` client bullets (~599-951): revise the TTY-
  gate description from a two-way split to three-way — TTY=live TUI,
  non-TTY=snapshot (print + `keeper-meta:` + exit), `--watch`=force stream;
  update each per-subcommand one-liner's non-TTY clause; add a snapshot
  invocation example to the fenced blocks. Consolidate, don't append.
- `cli/keeper.ts` `USAGE` (~39): the viewer one-liners ("Live jobs list",
  "Live usage frames") now mislead an agent — note that non-TTY is a
  one-shot snapshot read; mention the three flags exist on viewer subcommands.
- `CLAUDE.md`: confirm snapshot reuses the existing pid-isolated
  `/tmp/keeper-<sub>.<pid>.*` sidecars (no new env-configurable output path
  → no sixth sandboxEnv entry); if any slow-tier subprocess snapshot tests
  were added, acknowledge view/CLI subprocess tests as a slow-tier trigger.
- `skills/await/SKILL.md` (lines 114,218,299,306,340): clarify a bare
  `keeper jobs` is now a one-shot snapshot read in an agent (non-TTY)
  context — don't append `--snapshot` redundantly, and never append
  `--watch` (it hangs).

### Investigation targets

**Required** (read before coding):
- README.md ## Architecture (~599-951) — the TTY-gate summary + per-sub bullets
- cli/keeper.ts:39 — USAGE constant
- skills/await/SKILL.md:114,218,299,306,340 — the "keeper jobs snapshot" refs
- CLAUDE.md — Test isolation section (sandboxEnv state-path list)

### Test notes

Docs-only; no test impact beyond confirming the CLAUDE.md isolation note is
accurate. No new code.

## Acceptance

- [ ] README architecture: three-way TTY-gate description + per-subcommand
      non-TTY clauses + a snapshot example; accurate for all five.
- [ ] keeper.ts USAGE: viewer one-liners no longer imply streaming for
      agents; the three flags noted.
- [ ] CLAUDE.md: sidecar/sandboxEnv note confirmed accurate (and slow-tier
      note updated if subprocess snapshot tests landed).
- [ ] skills/await/SKILL.md: bare-`keeper jobs`-is-one-shot guidance added;
      no redundant `--snapshot`, no hang-inducing `--watch`.

## Done summary

## Evidence
