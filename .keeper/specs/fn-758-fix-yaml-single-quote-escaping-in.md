## Overview

The `yq()` helper in `babysitters/agents/performance.md` uses shell-eval single-quote escaping (`s/'/'\'''/g`) instead of YAML single-quoted scalar style (`s/'/''/g`). A finding key containing a single quote would produce malformed YAML frontmatter. Keys in practice use `category:scope:fn-N` format and never contain single quotes, but the escaping is objectively wrong and would surprise any YAML-aware reader.

## Acceptance

- [ ] `yq()` at performance.md:286 uses `sed "s/'/''/g"` (YAML double-single-quote style)
- [ ] A key containing a single quote produces valid YAML single-quoted scalar output

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1     | kept   | .1   | Genuine correctness bug at performance.md:286; shell-eval escaping is wrong for a YAML single-quoted scalar |
| F2     | culled | —    | Cosmetic clutter (charter.yaml artifact); no behavioral consequence |
| F3     | culled | —    | Self-correcting — first babysit invocation auto-creates rounds/ via mkdir -p |
| F4     | culled | —    | Prose clarity issue in LLM template; behavior correct, fix on next touch |
| F5     | culled | —    | Documentation silence on stale in Step 3; behavior correct per contract |

## Out of scope

- Test automation for LLM-prompt-level behaviors (structurally awkward per auditor)
- Removing the charter.yaml artifact (cosmetic only)
