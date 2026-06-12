## Description

**Size:** S
**Files:** babysitters/agents/performance.md, babysitters/FINDINGS-LEDGER.md, README.md, plist/arthack.babysitter.performance.watch.plist, plist/arthack.babysitter.performance.watchdog.plist (delete)

### Approach

Bring every doc and install surface to the shipped page-free reality —
current-state prose only, no change-history narration.

`babysitters/agents/performance.md`: rewrite from spawned-agent prompt to
PRODUCER DOCUMENTATION (fn-791's `agents/helptailing.md` is the model):
what the scanner detects, the category list, the key/fingerprint scheme,
the followup format (now scanner-written), and that discovery is
`/babysit-triage performance` — no page, no spawn, no ack. Keep the file at
this path (the babysitters plugin manifest may still list it as an agent —
verify nothing resolves `babysitters:performance` at runtime after task 1;
if the plugin agent registration is now pointless, note it in the doc
header rather than restructuring the plugin).

`babysitters/FINDINGS-LEDGER.md`: redefine the denominator (~lines 24-31)
from "PAGED findings only" to "findings the sitter escalated — wrote a
followup file for"; fix the resurface-anchor wording (~line 183) from "page
time" to "followup-written time" (the filename ts semantics are unchanged,
only the label). Stay in the contract-doc register.

README: install step 8 loses the spawn/page/--plugin-dir/botctl framing and
the ~/.local/bin PATH rationale; step 8b (watchdog) deleted; architecture
~2379-2416 collapsed to the pull model with the dead-man paragraph removed;
uninstall ~1184-1187 keeps a one-time note to `launchctl bootout` + remove
the now-deleted watchdog plist on existing installs. Plists: delete
`plist/arthack.babysitter.performance.watchdog.plist`; in the watch plist
drop the ~/.local/bin PATH entry if nothing else needs it (verify against
the post-task-1 scanner — it no longer execs claude/botctl).

Coordinate with fn-791 task 2, which edits the same README blocks and
FINDINGS-LEDGER intro for helptailing — this epic depends on fn-791, so
those edits land first; merge into their final shape, don't duplicate.

### Investigation targets

**Required** (read before coding):
- babysitters/agents/performance.md — the file being rewritten
- babysitters/agents/helptailing.md (fn-791 task 2 output) — the producer-doc model to mirror
- README.md:465-509, 1184-1187, ~2379-2416 — the three blocks being reworked
- babysitters/FINDINGS-LEDGER.md:16-31, ~183 — denominator + anchor wording
- babysitters/.claude-plugin/plugin.json — whether the agents-only plugin lists performance.md and whether anything still resolves it

**Optional** (reference as needed):
- plist/arthack.babysitter.performance.watch.plist — PATH entry verification

### Risks

- Editing the same README/FINDINGS-LEDGER regions fn-791.2 touches —
  resolved by the epic dep ordering; rebase onto their landed shape.

### Test notes

`plutil -lint` the surviving plist. `bun test` stays green (docs-only
otherwise). Manually walk both README install/uninstall flows for
consistency with the files that actually exist.

## Acceptance

- [ ] agents/performance.md is producer documentation: no page/spawn/ack language, matches the shipped scanner exactly
- [ ] FINDINGS-LEDGER denominator + resurface-anchor wording updated, contract register preserved
- [ ] README install/uninstall/architecture describe only the page-free model; watchdog plist deleted; uninstall covers tearing down the old watchdog LaunchAgent on existing installs
- [ ] Surviving watch plist lints and carries no vestigial PATH entries

## Done summary
Brought all docs and install surfaces to the page-free pull model: rewrote agents/performance.md as producer documentation, redefined the FINDINGS-LEDGER denominator + resurface anchor, collapsed README install/uninstall/architecture, deleted the watchdog plist, and stripped the vestigial ~/.local/bin PATH from the watch plist.
## Evidence
