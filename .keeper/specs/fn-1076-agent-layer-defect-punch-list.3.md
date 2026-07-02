## Description

**Size:** S
**Files:** scripts/ (new lint), package.json (wire into test/lint path)

### Approach

A small lint over both plugins' skill trees that catches the shipped defect class: a skill
whose directory name repeats its plugin namespace (keeper:keeper-await fired 36 times over 5
days before correction). Assert: skill dir names are lowercase-hyphen, do not start with the
plugin name + hyphen, and every SKILL.md frontmatter name (if present) matches its directory.
Wire it beside lint-claude-md in the standing lint path so it runs in the fast tier (pure fs
reads, no daemon).

### Investigation targets

**Required** (read before coding):
- scripts/lint-claude-md.ts — the pattern for a standing repo lint (structure + wiring)
- plugins/{keeper,plan}/skills/ layout + frontmatter shape

### Risks

- None notable; keep the rule set minimal so it never fights a legitimate future name.

### Test notes

Fixture-style: run the lint against a synthetic bad tree in a tmpdir; both plugins pass today.

## Acceptance

- [ ] Lint exists, runs in the fast tier, fails on a keeper/keeper-await-style fixture, passes the live tree

## Done summary
Added scripts/lint-skill-ids.ts — a fast-tier guard catching the plugin skill double-prefix defect class (keeper/keeper-await), wired as lint:skill-ids beside lint-claude-md with a fixture test that fails on a synthetic bad tree and passes the live plugins/.
## Evidence
