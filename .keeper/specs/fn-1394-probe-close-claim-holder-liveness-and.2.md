## Description

Every path that positively terminates a session must clear that session's
plan marker (~/.local/state/keeper/sessions/<sid>.json):

- keeper session terminate's kill path (locate the CLI/daemon
  implementation) clears the target session's marker once death is
  positively confirmed — never on refusal paths
  (session_identity_unproven / session_command_unowned leave the marker).
- The daemon reap paths that confirm a session terminal from folded
  evidence (the reaper sweeps in src/autopilot-worker.ts and the leg
  cascade's owner-terminal handling) clear the dead session's marker as
  part of claim release.
- Export one small marker-clear helper from
  plugins/plan/src/session_markers.ts and reuse it; hooks must NOT import
  it (hook import rules stay untouched).
- A marker-clear failure is non-fatal and bounded-logged; the task-1
  liveness probe remains the correctness backstop.

Files: plugins/plan/src/session_markers.ts, src/autopilot-worker.ts, the
session-terminate implementation (cli/ or src/daemon.ts — locate), tests
beside each touched surface.

## Acceptance

- [ ] Confirmed-death terminate clears the marker; refusals do not.
- [ ] Reaper/cascade terminal confirmation clears the dead session's marker.
- [ ] Marker-clear failures are non-fatal, bounded-logged.
- [ ] No hook imports the marker helper; lint gates stay green.

## Done summary

## Evidence
