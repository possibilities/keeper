## Description

**Size:** M
**Files:** claude/matt/skills/improve-codebase-architecture/SKILL.md, claude/matt/skills/improve-codebase-architecture/HTML-REPORT.md, claude/matt/skills/improve-codebase-architecture/references/design-vocabulary.md, claude/matt/README.md

### Approach

Fork the architecture-survey skill through the README's four-step transform, resolving its three dangling references. /grilling becomes a reference to /matt:grill-me (the single in-plugin home for the interview primitive — never a second inline copy). /domain-modeling retargets the keeper domain-docs layer: glossary updates and ADR offers follow the engineering/domain-docs reflex, pointed at via keeper prompt render engineering/domain-docs, never restated. /codebase-design — the load-bearing vocabulary the skill and its HTML report lean on — is replaced by a new compact references/design-vocabulary.md inside this skill dir carrying only the terms the fork actually uses (deep module, interface vs implementation, depth, seam, adapter — one adapter is a hypothetical seam, two are real — leverage, locality, and the deletion test), adapted from the pinned source and attributed like the rest; SKILL.md and HTML-REPORT.md point at it with read-when wording. Keep the Explore-subagent survey, the deletion test framing, and the self-contained temp-dir HTML report. The ending offers /plan:defer to queue a picked opportunity on the board as the natural next move. Append this fork's line to the README sync log.

### Investigation targets

*Verify before relying.*

**Required**:
- /Users/mike/src/mattpocock--skills/skills/engineering/improve-codebase-architecture/SKILL.md and HTML-REPORT.md — the source, incl. the /codebase-design references at HTML-REPORT.md:42,108,123
- /Users/mike/src/mattpocock--skills/skills/engineering/codebase-design/SKILL.md — the vocabulary source to compress
- claude/matt/README.md — the transform + sync-log conventions task 1 established

### Risks

- The vocabulary compression is the judgment call: too little and the survey loses its analytical teeth; too much and a sixth skill sneaks in as a reference file. Include only terms this skill's prose actually invokes.

### Test notes

grep the forked files for /grilling, /domain-modeling, /codebase-design — zero occurrences; every references/ pointer resolves to an existing file.

## Acceptance

- [ ] The forked skill is discoverable, user-invoked, provenance-pinned, and free of dangling Matt-ecosystem references
- [ ] The design vocabulary lives in a references file this skill's prose points at with read-when wording, covering the deletion test and the module/seam/adapter terms it uses
- [ ] The survey flow ends by offering to queue the picked opportunity via plan:defer
- [ ] The README sync log records the fork

## Done summary

## Evidence
