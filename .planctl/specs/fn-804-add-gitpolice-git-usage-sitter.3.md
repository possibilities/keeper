## Description

**Size:** S
**Files:** plist/arthack.babysitter.gitpolice.watch.plist (new), agents/gitpolice.md (new), README.md, CLAUDE.md, FINDINGS-LEDGER.md

### Approach

Mechanical scaffolding from the performance templates, describing the
shipped scanner's actual behavior. (1) plist: copy the performance plist
shape — Label arthack.babysitter.gitpolice.watch, ProgramArguments bun
run <abs>/gitpolice/watch.ts --tick, StartInterval 300 (never
KeepAlive), RunAtLoad, std out/err under
~/.local/state/babysitters/gitpolice/, header comment per the template
pattern (TEMPLATE caveat, manual symlink + bootstrap install/uninstall
one-liners, what-it-does paragraph covering the census + followups).
(2) agents/gitpolice.md: producer doc per agents/performance.md
structure — "no agent is spawned" framing, corpus layout (followups/ +
census.ndjson + cursor + seen.json + heartbeat), the two categories +
shared schema-skew, key/fingerprint scheme
(raw-git-write:<session_id>::<project_dir>, orphan-files:<project_dir>),
census record schema v1, known blind spots (indirect git via
subshells/xargs/scripts, snapshot tick-time lag, triage's own
sanctioned escape-hatch git is counted — accepted self-instrumentation).
(3) README.md: enumerate both sitters, repoint SUPPORTED_SCHEMA_VERSIONS
references to the lib/ module, add gitpolice launchd setup/teardown
block + --json ad-hoc line. (4) CLAUDE.md: whitelist-invariant location
to lib/, name both sitters, add gitpolice/watch.ts to the layout list.
(5) FINDINGS-LEDGER.md: add gitpolice to the implementing-sitters
enumeration. Then cross-check ~/docs/babysitters/gitpolice/charter.md
Sitter facts against the landed producer doc — report drift, do not
blind-update (the charter is human-gated; if facts diverge, fix the
facts section only, in the ~/docs repo, as a separate commit).

### Investigation targets

**Required** (read before coding):
- plist/arthack.babysitter.performance.watch.plist — the template (header comment shape, paths, interval posture)
- agents/performance.md — producer-doc structure to mirror
- gitpolice/watch.ts as landed by task .2 — the behavior being documented (categories, paths, census schema)

**Optional** (reference as needed):
- README.md:16,36-38,52-79,88,106 — the stale/single-sitter spots docs-gap-scout flagged
- CLAUDE.md:4,21-22,37-42 — same
- ~/docs/babysitters/gitpolice/charter.md — Sitter facts cross-check target

### Risks

- Docs drifting from the landed scanner — write them FROM the shipped code, not from the plan.

### Test notes

`plutil -lint plist/arthack.babysitter.gitpolice.watch.plist` passes;
bun test + lint stay green (docs-only change otherwise).

## Acceptance

- [ ] plist template lands, plutil-lints clean, and follows the no-install-verb/manual-bootstrap convention
- [ ] agents/gitpolice.md documents categories, key/fingerprint scheme, census schema v1, and blind spots, matching the landed scanner
- [ ] README.md and CLAUDE.md name both sitters and point schema-pin references at lib/; FINDINGS-LEDGER.md lists gitpolice
- [ ] charter.md Sitter facts verified against the producer doc (drift fixed in ~/docs or confirmed none)

## Done summary
Verified and landed the gitpolice docs/plist deliverables: plist (plutil-clean), agents/gitpolice.md, README/CLAUDE.md/FINDINGS-LEDGER.md all name both sitters and point schema-pin at lib/. Completed the tree (lint scope + dup pin-test removal) and fixed the charter Sitter facts (NOT YET BUILT -> BUILT) as a separate ~/docs commit.
## Evidence
