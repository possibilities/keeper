## Overview

Retire the legacy `chatctl` app from `~/code/arthack` now that the keeper
Agent Bus (fn-875, fixed by fn-878) is live and parity-verified. This is the
Layer-3 / phase-2 teardown: remove chatctl end to end AND rewrite its
canonical per-prompt agent advice against the bus, so a human can direct
agents to chat over `keeper bus` exactly as they did with chatctl — with the
upgraded authoritative-message + collaboration contract. After this lands,
NO `chatctl` reference survives in arthack and a fresh session arms ONLY the
keeper-bus monitor.

ALL tasks land in `~/code/arthack` (a different repo from keeper, where this
epic is tracked). The keeper Agent Bus itself is DONE and OUT OF SCOPE — this
epic only removes the old system and ports its per-prompt advice.

## Quick commands

- `grep -ri chatctl ~/code/arthack --exclude-dir=.git --exclude-dir=.venv --exclude-dir=node_modules --exclude-dir=__pycache__ --exclude-dir=.keeper` — MUST return clean (only lockfile content hashes / generated caches are acceptable, and ideally none)
- `launchctl list | grep -i chatctl` — MUST be empty (daemon unloaded)
- `cd ~/code/arthack && uv sync` (or the repo's lock check) — workspace still resolves with chatctl removed
- `keeper prompt render bundle/hookctl-bus-pointer` (or the new bundle id) — the rewritten bus advice renders
- Start a fresh claude session — it arms the keeper-bus monitor and NO chatctl monitor

## Acceptance

- [ ] `apps/chatctl/` is deleted (app + tests + monitors.json + plugin.json)
- [ ] The `arthack.chatctl.run-server` LaunchAgent is unloaded (`launchctl bootout`) and its plist deleted; `~/.local/state/chatctl/` daemon is no longer running
- [ ] `chatctl` is removed from the pyproject workspace (members, sources, packages, tool configs) and the lockfiles (uv.lock, pnpm-lock.yaml) are regenerated; the workspace resolves
- [ ] The portalctl `apps.yaml` chatctl entry is removed
- [ ] The 5 messaging snippets are REWRITTEN against the bus (already-listening blind; authoritative no-gate + the 3 frictionless behaviors; reach by current/former name; leadership pointer) and `_index.yaml` updated; the `hookctl-chatctl-pointer` bundle is replaced by a bus bundle and `user_prompt_submit.ts` (+ its test) rewired
- [ ] CLAUDE.md + claude/CLAUDE.md inter-agent guidance points to `keeper bus` (forward-facing — no chatctl→bus change narration outside the commit message)
- [ ] FINAL SWEEP: `grep -ri chatctl` over arthack is clean; the prompt engine renders the new bus advice; a fresh session arms only the keeper-bus monitor
- [ ] pairctl is UNTOUCHED in behavior (its only chatctl reference is a code comment — update the comment, do not change logic)

## Early proof point

Task that proves the approach: `.1` (stop the daemon + delete the app). If
deleting the app surfaces an unexpected hard dependency (a real import, not a
comment), STOP and surface it — the only known reference outside apps/chatctl
is pairctl's comment (lineage note) and the prompt snippets/bundle, all of
which are handled in `.3`. Recovery: if a live import is found, decouple it
first before deleting.

## References

- chatctl footprint (44 files) confirmed by `grep -ril chatctl` over arthack (excl .git/.venv/node_modules/__pycache__/.keeper).
- Daemon: `system/launchagents/Library/LaunchAgents/arthack.chatctl.run-server.plist`, label `arthack.chatctl.run-server` (currently loaded, pid 877). Unload: `launchctl bootout gui/$(id -u)/arthack.chatctl.run-server`.
- Workspace: `pyproject.toml` lines ~39 (members `"chatctl"`), ~76 (`chatctl = { workspace = true }`), ~117 (`"apps/chatctl"`), ~221-222 (ruff/mypy `"chatctl"`/`"chatctl.*"`). Lockfiles `uv.lock`, `pnpm-lock.yaml`.
- portalctl: `apps/portalctl/apps.yaml` lines ~56-59 (`app: chatctl` + `chatctl.run-server` daemon).
- Per-prompt advice: 5 snippets in `claude/arthack/template/_partials/snippets/messaging/` (chatctl-watch-monitor, chat-send, chat-inbox-note, peer-message-format, brief-dispatch-defaults) + `_index.yaml`; bundle `claude/arthack/template/_partials/bundles/hookctl-chatctl-pointer.yaml`; wired at `claude/arthack/hooks/user_prompt_submit.ts:167` (inter-agent keyword reminder) + `claude/arthack/hooks/tests/user_prompt_submit.test.ts`.
- Advice CONTENT to port: the settled contract already authored in keeper's `plugins/keeper/skills/bus/SKILL.md` + `keeper bus --help` (already-listening blind, authoritative no-gate + attribution/loop-stop/human-wins, reach by any name, leadership ladder). Mirror that voice; keep it forward-facing.
- pairctl comment: `apps/pairctl/pairctl/helpers.py:23-24` (a docstring lineage note, NOT an import).

## Alternatives

- Scaffold in arthack's own planctl vs a cross-repo epic in keeper's planctl — chose cross-repo-in-keeper (one control plane; all tasks set `target_repo`).
- Delete the snippets outright vs rewrite against the bus — chose REWRITE: the per-prompt inter-agent advice must keep working (point at `keeper bus`), it's the canonical surface fn-875.5 deferred.

## Rollout

Cutover: the keeper bus is already live, so removing chatctl closes the
short coexistence window. After teardown, sessions that still have a stale
chatctl monitor armed (started pre-teardown) will see that monitor error
harmlessly until they restart; fresh sessions arm only keeper-bus. No keeper
schema or data change. Rollback = `git revert` in arthack + `launchctl
bootstrap` the chatctl plist; but the bus is the durable replacement.

## Architecture

The teardown splits along clean seams: (1) runtime removal (daemon + app +
portal entry), (2) workspace/lockfile surgery, (3) per-prompt advice rewrite
(the agent-facing seam — independent files), (4) docs + a holistic final
sweep that gates the whole thing. (1)→(2) is a hard chain (remove the member
before regenerating locks); (3) is independent; (4) verifies all.
