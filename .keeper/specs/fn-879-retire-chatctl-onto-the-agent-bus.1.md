## Description

**Size:** S
**Files:** apps/chatctl/ (delete), system/launchagents/Library/LaunchAgents/arthack.chatctl.run-server.plist (delete + unload), apps/portalctl/apps.yaml

Remove the chatctl runtime: unload its daemon, delete the app and tests,
drop the portal entry.

### Approach

First UNLOAD the running daemon: `launchctl bootout
gui/$(id -u)/arthack.chatctl.run-server` (it is currently loaded, pid 877).
Then delete the plist `system/launchagents/Library/LaunchAgents/arthack.chatctl.run-server.plist`
and the symlinked copy under `~/Library/LaunchAgents/` if present. Delete the
whole `apps/chatctl/` directory (app, tests, monitors.json, plugin.json).
Remove the `app: chatctl` entry (and its `chatctl.run-server` daemon line)
from `apps/portalctl/apps.yaml`. Do NOT touch the workspace manifest/lockfiles
here — that is task 2 (this keeps the destructive app-delete isolated as the
early proof point).

### Investigation targets

**Required** (read before coding):
- system/launchagents/Library/LaunchAgents/arthack.chatctl.run-server.plist (label + program)
- apps/portalctl/apps.yaml (the chatctl entry, ~lines 56-59)

### Risks

- Confirm no LIVE import of chatctl outside apps/chatctl before deleting (grep `from chatctl`/`import chatctl` across arthack excluding apps/chatctl) — the only known reference is pairctl's COMMENT (handled in task 3) and the prompt snippets/bundle (task 3). If a real import exists, STOP and surface.
- `launchctl bootout` may report "No such process" if already unloaded — that is fine (idempotent).

### Test notes

After: `launchctl list | grep chatctl` is empty; `ls apps/chatctl` is gone; portalctl renders without the chatctl app.

## Acceptance

- [ ] `arthack.chatctl.run-server` is unloaded (`launchctl list | grep chatctl` empty) and the plist deleted (repo + ~/Library/LaunchAgents)
- [ ] `apps/chatctl/` fully deleted
- [ ] portalctl `apps.yaml` no longer lists chatctl
- [ ] no LIVE chatctl import was found outside apps/chatctl (verified before delete)

## Done summary

## Evidence
