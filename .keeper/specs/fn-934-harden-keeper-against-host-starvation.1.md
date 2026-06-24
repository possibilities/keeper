## Description

**Size:** S
**Files:** plist/arthack.keeperd.plist, README.md, CLAUDE.md

### Approach

Take keeperd off the throttled Background QoS so it keeps folding under host
contention. In `plist/arthack.keeperd.plist`, change `ProcessType` from `Background`
to `Standard` and add a `Nice` key of `-5` (launchd honors negative nice for its
agents; do NOT use `Interactive` — it removes all throttling and can starve the
human's foreground work). ProcessType is read at SPAWN, so a plain reload may not
re-read it — apply via `launchctl kickstart -k gui/$UID/arthack.keeperd` (or
bootout+bootstrap) and verify the new priority took (`ps -o nice -p <keeperd-pid>`).
First confirm whether the installed `~/Library/LaunchAgents/arthack.keeperd.plist`
is a SYMLINK to the repo copy (edit-in-place works) or a COPY (needs a re-install
step) — the README install section documents the symlink. Add a short inline plist
comment on the priority rationale and a forward-facing line in the README install
section. Forward-facing prose only.

### Investigation targets

**Required** (read before coding):
- plist/arthack.keeperd.plist:72 — current `ProcessType=Background`; no `Nice` key yet; kickstart documented ~:40; PATH stripped to system dirs
- README.md (LaunchAgent install section) — the symlink/bootstrap steps; confirm symlink-vs-copy

### Risks

- `kickstart` without `-k` may not re-read ProcessType (read at spawn) — use `-k` or bootout/bootstrap and verify.
- If the installed entry is a COPY not a symlink, editing the repo file is a no-op until re-install.
- The reload bounces the running daemon mid-epic — acceptable (a safe restart; event log is durable).

### Test notes

No unit test (a plist + docs change). Verify by reload + `ps -o pid,nice,comm` showing keeperd at the new nice.

## Acceptance

- [ ] `plist/arthack.keeperd.plist` sets `ProcessType=Standard` and `Nice=-5` (not Interactive/Background).
- [ ] The reload procedure is documented and applied; keeperd confirmed running at the elevated priority after reload (symlink-vs-copy resolved).
- [ ] Plist comment + README install note explain the priority choice (forward-facing).

## Done summary
Took keeperd off the throttled Background QoS: ProcessType=Standard + Nice=-5 in the plist, applied via bootout+bootstrap (kickstart -k was insufficient), and verified keeperd running at nice -5. Documented the priority rationale (inline plist comment) and the re-register procedure (README).
## Evidence
