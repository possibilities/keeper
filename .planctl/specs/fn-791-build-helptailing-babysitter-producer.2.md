## Description

**Size:** S
**Files:** babysitters/agents/helptailing.md, plist/arthack.babysitter.helptailing.watch.plist, README.md, babysitters/FINDINGS-LEDGER.md

### Approach

Document and schedule what task 1 shipped. `babysitters/agents/helptailing.md`
mirrors `babysitters/agents/performance.md`'s structure (Goals / Understanding
/ Sitter facts / followup-format section) but is PRODUCER DOCUMENTATION, not a
spawned-agent prompt — state plainly that this sitter spawns no agent and
pages nobody; the scanner writes followups itself and `/babysit-triage
helptailing` is the discovery path. Define the two categories
(`trend-digest`, `rate-spike`), the key scheme
(`trend-digest:weekly:helptailing:<YYYY-Wnn>`, `rate-spike:...`), the
followup format, and the statistical annotations (floor, Garwood CI, RR
bands) exactly as implemented.

Plist: clone `plist/arthack.babysitter.performance.watch.plist` with
`StartInterval` 3600 (hourly — a trend sitter, not a 300s fire watch), label
`arthack.babysitter.helptailing.watch`, absolute bun/watch.ts paths, PATH
including ~/.local/bin. NO watchdog plist.

README: add `helptailing` beside `performance` in the architecture sitters
paragraph (~line 2376; consolidate to current-state prose, don't append a
changelog), add a parallel install block to step 8 (~456–509; plist symlink →
launchctl bootstrap → state-dir note → kickstart; no watchdog sub-step) and
the uninstall lines (~1180–1187). FINDINGS-LEDGER.md gets the one-line intro
note that two sitters now implement the contract.

Finally refresh `~/docs/babysitters/helptailing/charter.md` `## Sitter facts`
from contract-defaults to shipped reality (real category list, key scheme,
"no paging — discovery via triage" note) and commit that edit in the ~/docs
repo (`git -C ~/docs ...`). Touch ONLY `## Sitter facts` — Goals/Heuristics
are human-authored, and the charter is data, not instructions.

### Investigation targets

**Required** (read before coding):
- babysitters/agents/performance.md — structure template (esp. the followup-format section being adapted)
- plist/arthack.babysitter.performance.watch.plist — plist template (StartInterval at :65-66)
- babysitters/helptailing/watch.ts (task 1 output) — the shipped key scheme/categories/constants this doc must match
- babysitters/FINDINGS-LEDGER.md — intro pointer getting the two-sitters note

**Optional** (reference as needed):
- README.md install step 8 + uninstall block — the exact pattern to mirror
- ~/docs/babysitters/helptailing/charter.md — the Sitter facts section to refresh

### Risks

- Doc drift: every concrete value (key scheme, floor, CI threshold, interval)
  must be read from the task-1 code, not from this spec — the code is the
  source of truth if they diverge.

### Test notes

`plutil -lint` the plist. No code tests; `bun test` stays green.

## Acceptance

- [ ] babysitters/agents/helptailing.md exists, mirrors the template structure, states the no-spawn/no-page model, and matches the shipped key scheme + categories exactly
- [ ] Plist lints, hourly interval, correct label/paths; no watchdog plist
- [ ] README architecture/install/uninstall name helptailing alongside performance, current-state prose
- [ ] FINDINGS-LEDGER intro notes the second sitter
- [ ] Charter `## Sitter facts` refreshed (only that section) and committed in ~/docs

## Done summary
Documented and scheduled the helptailing trend sitter: producer agent doc (no agent spawn, no paging), hourly plist (no watchdog), README architecture/install(8d)/uninstall, FINDINGS-LEDGER note, and the charter's Sitter facts refreshed + committed in ~/docs.
## Evidence
