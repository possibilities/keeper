"""Public API: read-only views into keeper's projections.

Seven readers; all stdlib-only and gated on
``SUPPORTED_SCHEMA_VERSIONS``:

- ``get_session_titles()`` — ``{session_id: title}`` for every titled
  job.  Reads ``jobs``.  Consumed by claudectl's session search.
- ``get_session_name_history()`` — ``{session_id: [title, ...]}`` for
  every job's distinct-titles history.  Reads
  ``jobs.name_history``.  Consumed by claudectl's by-any-name session
  resolver.
- ``get_session_for_pid(pid)`` — latest session id whose ``jobs.pid``
  equals *pid*, or ``None``.  Reads ``jobs`` (the new ``idx_jobs_pid``
  index covers the lookup).  Consumed by
  ``cli_common.session_context``'s psutil ancestor walk.
- ``get_session_identity_for_pid(pid)`` — live identity of the session
  owning *pid* as ``{session_id, title, name_history}``, or ``None``.
  Reads ``jobs`` in one pid-keyed query.  Consumed by the Agent Bus to attribute
  and resolve agents by their current title or any former name.
- ``get_latest_session()`` — most-recently-updated job's
  ``{session-id, cwd, session-name}`` (``session-name`` omitted when
  ``jobs.title`` is NULL), or ``None``.  Reads ``jobs``.  Consumed by
  ``cli_common.session_context.show_context``.
- ``get_epic(epic_id)`` — one epic row as ``dict`` (with
  ``tasks`` / ``jobs`` JSON-TEXT cells defensively decoded to lists)
  or ``None`` when the row is absent.  Reads ``epics``.  Consumed by
  ``keeper plan render-approve-context`` to pick a target job from the
  epic's embedded ``jobs`` / ``tasks[].jobs`` arrays.
- ``get_job(job_id)`` — one job row as ``dict`` (real columns:
  ``job_id`` / ``transcript_path`` / ``cwd`` / ``state``) or ``None``
  when the row is absent.  Reads ``jobs``.  Consumed by ``keeper plan
  render-approve-context`` to look up the target session's transcript
  path + cwd for the final-message read.

The import graph is stdlib-only (``sqlite3``, ``json``, ``os``,
``pathlib``) so this module adds no cold-start weight.
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

# keeper schema versions this reader understands.  keeper tracks its schema in
# a ``meta`` key/value row — ``SELECT value FROM meta WHERE key='schema_version'``
# — NOT ``PRAGMA user_version`` (which keeper leaves at 0).  The
# ``file_attributions`` shape this reader depends on landed in
# v31 (fn-633) — dirtiness is now verified via a live ``git status`` rather
# than the cached ``git_status`` projection, so this reader no longer reads
# that table; v32 (fn-634 ``default_visible``) is additive and doesn't touch
# it; v33 (fn-639 ``profiles``) is additive and doesn't touch it; v34
# (fn-637 ``resolved_epic_deps`` on epics) is additive and doesn't touch it;
# v35 (fn-642 ``usage``+``profiles`` rate-limit colocation) is additive and
# touches only ``usage`` / ``profiles`` (keeper-py reads neither); v36 (fn-642
# ``jobs.profile_name``) is an additive nullable column on ``jobs`` and doesn't
# touch the file-attribution shape; v37 (fn-643 ``dead_letters`` operational
# sidecar table + index) is additive and touches neither; v38 (fn-645 usage
# envelope status / subscription / error axes) adds nullable columns to
# ``usage`` only (keeper-py reads neither ``usage`` nor ``profiles``); v39
# (fn-648 git-rm/git-mv deletion attribution) bumps for the backfill +
# cursor-rewind that re-derives ``events.bash_mutation_kind`` /
# ``bash_mutation_targets`` over historical rows and re-folds the projections
# — no shape change to the file-attribution-relevant tables keeper-py reads;
# v40 (fn-652 jobs.name_history) adds a NOT NULL DEFAULT '[]' JSON-array
# column on ``jobs`` carrying the ordered distinct titles a session has
# carried — keeper-py does not read ``jobs.name_history`` (the consumer is
# claudectl via a forthcoming ``get_session_name_history()``), so the bump
# is whitelist-only with no reader logic change; v41 (fn-651 usage lift
# time + freshness) adds two nullable columns to ``usage`` only
# (``rate_limit_lifts_at TEXT`` + ``last_usage_fold_at REAL``) — keeper-py
# does not read ``usage``, so the bump is whitelist-only with no reader
# logic change; v42 (fn-662 ``''↔'default'`` directional mapping) is a
# fold-output change (the v35 rate-limit fan-out now colocates the
# default-profile annotation onto ``usage.default`` via a shared pure
# helper, fixing an invisible default-account rate limit) gated on a
# rewind-and-redrain — no shape change to any table keeper-py reads (it
# reads neither ``usage`` nor ``profiles``), so the bump is whitelist-only
# with no reader logic change; v43 (fn-661 server-side autopilot reconciler
# substrate) adds a new ``dispatch_failures`` projection table carrying
# one row per sticky ``(verb, id)`` dispatch failure — keeper-py does not
# read ``dispatch_failures`` (the reader is the thin ``keeper autopilot``
# viewer, fed via the UDS subscribe wire), so the bump is whitelist-only
# with no reader logic change; v44 (fn-664 content-aware discharge
# substrate) adds an additive nullable ``file_attributions.worktree_oid``
# column carrying the filter-correct git blob oid of each dirty file's
# worktree bytes (frozen into the ``GitSnapshot`` event payload by the
# producer's ``git hash-object --stdin-paths`` batch) — keeper-py reads
# ``file_attributions`` only for the ``session_id`` / ``file_path`` /
# ``last_mutation_at`` / ``last_commit_at`` tuple and does not project
# ``worktree_oid``, so the bump is whitelist-only with no reader logic
# change; v45 (fn-664.2 content-aware discharge gate) adds the additive
# nullable ``file_attributions.worktree_mode`` column pairing with
# ``worktree_oid`` on the discharge gate (a chmod-only dirty file with
# equal blob oid but differing mode stays attributed) — keeper-py does
# not project ``worktree_mode`` for the same reason as ``worktree_oid``,
# so the bump is whitelist-only with no reader logic change; v46 (fn-666
# planctl-file attribution) widens the ``file_attributions.source`` CHECK
# enum to include ``'planctl'`` (a row-preserving table rebuild) and
# adds the additive nullable ``events.planctl_files TEXT`` column lifted
# from the envelope's ``files`` array by ``extractPlanctlInvocation`` —
# the reducer's planctl_op fold mints a ``file_attributions`` row for
# every named path so ``.planctl`` JSONs + specs no longer orphan (the
# minted ``source`` value is ``'plan'`` as of v75; see below).
# keeper-py reads ``file_attributions`` only for the
# ``session_id`` / ``file_path`` / ``last_mutation_at`` /
# ``last_commit_at`` tuple — it never reads ``source`` or
# ``planctl_files`` — so the bump is whitelist-only with no reader
# logic change; v47 (fn-667 persist autopilot control state) adds a new
# ``autopilot_state`` singleton projection table carrying the autopilot
# worker's paused/playing flag plus a new ``AutopilotPaused`` synthetic
# event — keeper-py reads neither the new table nor the event (the
# reader is the thin ``keeper autopilot`` viewer, fed via the UDS
# subscribe wire), so the bump is whitelist-only with no reader logic
# change.
# Bump this set when a keeper schema change alters those tables.
#
# ``get_epic`` / ``get_job`` (fn-627) consume columns that pre-date the
# supported range: ``jobs.transcript_path`` / ``jobs.cwd`` / ``jobs.state``
# are first-class columns in ``CREATE_JOBS`` (no version gate), ``jobs.plan_verb``
# landed in v10 (well below v31), and ``epics.tasks`` / ``epics.jobs`` are
# JSON-TEXT cells whose embedded shapes (``EmbeddedJob.created_at`` etc.)
# are stable across the whole v31-v49 window — so the new readers add no
# tighter version dependency than the existing scaffold.
#
# v49 (fn-670 T2) is a whitelist-only bump: the new
# ``last_commit_for_task_at`` field rides FREE inside the opaque
# ``epics.tasks[].jobs[]`` JSON-TEXT cell, so keeper-py reads the field
# pass-through without a SQL change. The bump is still listed here
# because keeper-py is a hard whitelist (not a floor/ceiling), and a
# v49 daemon would fail every ``commit-work`` on the host until this
# set was updated. ``test/schema-version.test.ts`` enforces.
#
# v50 (fn-678 epic, T1) is a whitelist-only bump: adds the new
# ``pending_dispatches`` reducer projection table (the durable substrate
# that replaces fn-674's live tab-name probe for launch-window
# double-dispatch suppression). keeper-py reads neither this table nor
# the new ``Dispatched`` / ``DispatchExpired`` synthetic events
# (autopilot surface, not the attribution surface keeper-py serves), so
# the bump is whitelist-only with no reader logic change.
#
# v51 (fn-682 epic, T1) is a whitelist-only bump: adds the new
# ``jobs.monitors`` JSON-array projection column (live per-session
# background-shell snapshot with three-way provenance —
# ``monitor`` / ``bash-bg`` / ``ambient``) plus the sparse
# ``events.background_task_id`` deriver column + its partial index that
# feeds the reducer's in-fold provenance scan. keeper-py reads neither
# ``jobs.monitors`` nor ``events.background_task_id`` (attribution
# surface only — the monitors projection serves the ``keeper jobs``
# viewer), so the bump is whitelist-only with no reader logic change.
#
# v52 (fn-686 epic, T1) is a whitelist-only bump: adds the paired
# ``jobs.last_permission_prompt_at`` / ``jobs.last_permission_prompt_kind``
# projection columns that surface "session blocked on a Claude Code
# permission dialog or MCP elicitation prompt" via the board
# ``[awaiting:permission]`` / ``[awaiting:elicitation]`` pill. keeper-py
# reads neither column (attribution surface only — the pill renders out
# of the ``keeper board`` viewer's projection read), so the bump is
# whitelist-only with no reader logic change.
#
# v53 (fn-688 epic, T1) is a whitelist-only bump: adds the new
# ``epic_tombstones`` projection table that guards every epic-shell-
# INSERT site against the deleted-epic resurrection bug (a later
# job-side fold whose ``plan_ref`` still points at the now-gone epic
# re-shells the row with NULL scalars, rendering as a headerless
# "ghost" block at the top of ``keeper board``). keeper-py reads
# neither ``epic_tombstones`` nor any of the guarded shell-INSERT
# code paths (attribution surface only — the board renderer is the
# only consumer affected by the ghost-row fix), so the bump is
# whitelist-only with no reader logic change.
#
# v54 (fn-695 epic, T3) is a whitelist-only bump: the reducer's
# ``syncPlanctlLinks`` now derives the creator/refiner edges
# (``epics.job_links`` / ``jobs.epic_links``) from the UNION of the
# legacy ``events.planctl_op`` stdout-scrape rows and durable commit-
# trailer facts (``Planctl-Op`` / ``Planctl-Target`` / ``Session-Id``)
# lifted off ``Commit`` events, so the edge survives any stdout
# mangling / client+server reboot. The union rides FREE inside the
# existing JSON-TEXT edge cells — no new column, no schema shape
# change. keeper-py reads neither the edge cells nor the commit-
# trailer payload (attribution surface only — the board renderer is
# the only consumer), so the bump is whitelist-only with no reader
# logic change.
#
# v55 (fn-710 epic, T2) is a whitelist-only bump: the two dead
# ``jobs.backend_exec_{tab_id,tab_name}`` columns are dropped via a
# forward-only ``dropColumnIfPresent`` migration (their sole writer,
# the ``BackendExecSnapshot`` fold, was reaped in T1). keeper-py read
# neither column, so the bump is whitelist-only with no reader logic
# change.
#
# v56 (fn-712 epic) is a whitelist-only bump: the ``epics.default_visible``
# VIRTUAL generated column is rewritten (drop + re-add) to add a
# ``status IS NOT NULL`` "epic is materialized" guard so a freshly-scaffolded
# NULL-status shell row is hidden from the board until its EpicSnapshot folds.
# keeper-py reads neither the column nor the predicate (attribution surface
# only), so the bump is whitelist-only with no reader logic change.
#
# v57 (fn-717.1 epic) is a whitelist-only bump: the ``event_blobs(event_id,
# data)`` cold-blob relocation side table is added (empty in .1 — the
# compaction relocator lands in .2). Reducer blob reads resolve via
# ``COALESCE(events.data, event_blobs.data)``. keeper-py reads neither
# ``events.data`` nor ``event_blobs`` (attribution surface only), so the bump
# is whitelist-only with no reader logic change.
#
# v58 (fn-717.2) is also whitelist-only: it relaxes ``events.data`` from
# NOT NULL to nullable (via a one-time stop-the-world table rebuild) so the
# daemon-side compaction relocator can NULL the hot column after moving a cold
# blob into ``event_blobs``. keeper-py still never reads ``events.data``, so no
# reader logic changes — only the version whitelist gains 58.
#
# v59 (fn-719 task 1) is also whitelist-only: it carries a provenance-filtered
# ``has_live_worker_monitor`` occupancy fact onto the embedded
# ``epics.tasks[].jobs[]`` element (riding FREE inside the opaque JSON-TEXT
# ``tasks`` cell — no new real column). keeper-py reads neither
# ``jobs.monitors`` nor the embedded occupancy fact; readiness + the autopilot
# reconciler are the only consumers — so no reader logic changes, only the
# version whitelist gains 59.
#
# v61 (fn-736 task .1) is also whitelist-only: it adds the
# ``event_ingest_offsets`` table — the NDJSON→events ingest cursor for the
# lock-free events path. keeper-py reads neither that table nor the per-pid
# NDJSON files (the daemon's ingester owns both, UPSTREAM of the fold), so no
# reader logic changes — only the version whitelist gains 61.
#
# v62 (fn-751 task .1) is also whitelist-only: it adds a NOT NULL
# ``autopilot_state.mode TEXT DEFAULT 'yolo'`` column (the explicit autopilot
# mode enum) and a new ``armed_epics`` per-epic armed presence table. keeper-py
# reads neither ``autopilot_state`` nor ``armed_epics`` (the autopilot
# reconciler + the ``keeper autopilot``/board viewers are the only consumers),
# so no reader logic changes — only the version whitelist gains 62.
#
# v63 (fn-756 task .2) is also whitelist-only: it drops the dead
# ``epics.approval`` column and rewrites the ``default_visible`` generated
# column to drop its ``approval`` branch (``CASE WHEN status IS NOT NULL AND
# status='open' THEN 1 ELSE 0 END``), now that keeper completes work on
# worker/closer-done alone with no approval gate. keeper-py reads neither the
# column nor the predicate, so no reader logic changes — only the version
# whitelist gains 63.
#
# v64 (fn-781 task .1) is also whitelist-only: it adds a new empty ``builds``
# reducer projection table (the ``keeper builds`` buildbot dashboard surface,
# fed by synthetic ``BuildSnapshot`` / ``BuildDeleted`` events). keeper-py reads
# no ``builds`` column (the TUI subscribes over the socket), so no reader logic
# changes — only the version whitelist gains 64.
#
# v65 (fn-784 task .1) is also whitelist-only: it adds the folded
# ``jobs.active_since`` REAL column (Unix-seconds stamped on the rising edge
# into ``working``, the recency key for the unified ``keeper dash`` AGENTS
# timeline). keeper-py reads no ``active_since`` column (the TUI subscribes over
# the socket), so no reader logic changes — only the version whitelist gains 65.
#
# v66 (fn-787 task .2) is also whitelist-only: it adds the session-anchored
# partial index ``idx_events_pretooluse_agent_session`` so the SubagentStart
# fold's pending-PreToolUse bridge seeks one session instead of every PreToolUse
# row. An index touches no column, so no reader logic changes — only the version
# whitelist gains 66.
#
# v67 (fn-807 task .2) adds the ``commit_trailer_facts`` reducer projection so
# the commit-trailer channel of ``syncPlanctlLinks`` reads an indexed table
# instead of re-scanning every ``Commit`` blob per swept session. keeper-py reads
# no ``commit_trailer_facts`` row (the TUI subscribes over the socket), so no
# reader logic changes — only the version whitelist gains 67.
#
# v68 (fn-813 task .1) adds the ``scheduled_tasks`` reducer projection folding
# the ``CronCreate`` / ``CronDelete`` PostToolUse pair into a per-job cron side
# table. keeper-py reads no ``scheduled_tasks`` row (the TUI subscribes over the
# socket), so no reader logic changes — only the version whitelist gains 68.
#
# v70 (fn-817 task .1) adds the producer-stamped ``jobs.close_kind`` TEXT column
# recording WHY a session died (``server_gone`` / ``pid_died`` /
# ``window_gone_server_alive`` / ``unknown``), the per-row signal the DB-derived
# crash-restore set reads instead of a frozen restore.json snapshot. keeper-py
# reads no ``close_kind`` column (the TUI subscribes over the socket), so no
# reader logic changes — only the version whitelist gains 70.
#
# v71 (fn-817 task .2) adds the nullable ``jobs.window_index`` INTEGER column —
# the live tmux ``#{window_index}`` (a window's left-to-right VISUAL position)
# the restore-worker probes per pulse and folds via a change-gated
# ``WindowIndexSnapshot`` event, so the DB-only crash-restore derivation replays
# windows in original visual order without reading restore.json. keeper-py reads
# no ``window_index`` column (the TUI subscribes over the socket), so no reader
# logic changes — only the version whitelist gains 71.
#
# v72 (fn-826 task .1) widens the ``file_attributions.source`` CHECK to accept the
# renamed ``'plan'`` alongside legacy ``'planctl'`` (a row-preserving TABLE REBUILD;
# no row's ``source`` changes, no cursor rewind, re-fold byte-identical). The
# cascade-safety keystone: the fold now tolerates both names so a later producer
# flip to ``source='plan'`` can't be rejected once the daemon is bounced. keeper-py
# reads no ``file_attributions`` rows (the TUI subscribes over the socket), so no
# reader logic changes — only the version whitelist gains 72.
#
# v73 (fn-836 task .2) adds the nullable ``events.mutation_path`` TEXT column —
# the git-attribution fold's lone cross-event field (``data.tool_input.file_path``)
# promoted to a column so the fold reads it instead of parsing the JSON body
# (hook-derived forward + ingester-recomputed for pre-deriver lines; NULL on every
# non-Write/Edit/MultiEdit/NotebookEdit row). Purely additive + online (instant ADD
# COLUMN, no rebuild, no cursor rewind, re-fold byte-identical — the expression
# index + COALESCE dual-read stay until the .3 attribution flip). keeper-py reads no
# ``mutation_path`` column (attribution computes its own dirty set), so no reader
# logic changes — only the version whitelist gains 73.
#
# v74 (fn-836 task .4) is the DESTRUCTIVE shed: the migration restores every
# keep-set body back inline and DROPs the ``event_blobs`` side table at its tail
# (shed-class PostToolUse mutation bodies stay NULL — their file_path lives in
# ``mutation_path`` now). keeper-py never read ``event_blobs`` (it computes its own
# dirty set), so no reader logic changes — only the version whitelist gains 74.
#
# v75 (fn-831 task .1) completes the planctl→plan producer flip: the planctl_op
# fold now mints ``source='plan'`` and the migration rewrites every stored
# ``source='planctl'`` ``file_attributions`` row to ``'plan'`` (in-transaction with
# the version stamp, no cursor rewind, re-fold byte-identical). keeper-py reads no
# ``file_attributions.source`` (the TUI subscribes over the socket), so no reader
# logic changes — only the version whitelist gains 75.
#
# v76 (fn-846 task .1) adds the never-bound dispatch circuit breaker: a new
# ``dispatch_never_bound`` reducer projection (per-``(verb, id)`` consecutive-
# ``DispatchExpired``-without-bind counter) whose fold mints a sticky
# ``dispatch_failures(reason='never-bound')`` at K=3, suppressed by the existing
# ``failedKeys`` arm and cleared by ``keeper autopilot retry``. New table only, no
# cursor rewind, re-fold byte-identical. keeper-py reads neither the new table nor
# ``dispatch_failures`` (the TUI subscribes over the socket), so no reader logic
# changes — only the version whitelist gains 76.
#
# v77 (fn-856 task .1) ungates the plan-link classifier from the ``/plan:plan``
# time-window model: every epic-mutating op now links as ``creator`` / ``refiner``
# regardless of timing (only the read-only gate survives), repopulating
# ``epics.job_links`` + ``created_by_closer_of`` for the closers, pre-first-opener
# scaffolds, and ``/plan:defer`` / direct-CLI edits the window gate silently
# dropped. Because the fold output changed, the migration REWINDS the cursor and
# wipes the canonical projection list (same set as v42) so the corrected derive
# repopulates; the classifier's ``(ts, event_id)`` total-order sort keeps a
# from-scratch re-fold byte-identical. keeper-py reads ``jobs`` / ``epics`` over
# the socket, not these projection internals, so no reader logic changes — only
# the version whitelist gains 77.
#
# v79 (fn-868 task .1) makes the git surface a LIVE-ONLY projection: a new
# ``git_projection_state`` control singleton holds a skip-floor + ``seed_required``
# flag, the migration raises the floor to ``max(events.id)`` so historical git
# folds no-op, and a boot-seed producer re-derives the git surface. keeper-py
# stopped reading the git tables, so again only the version whitelist gains 79.
#
# v80 (fn-881 task .1) excludes the worker's ``done`` op and the closer's
# ``close`` op from the plan-link classifier so ``refiner`` means only genuine
# plan-shaping edits. Because the fold output changed, the migration mirrors the
# v77 rewind/wipe block (cursor-0 rewind + canonical projection wipe) but raises
# the git skip-floor instead of resetting it to 0 (the v79 shape, avoiding a
# historical git-fold replay). keeper-py reads ``jobs`` / ``epics`` over the
# socket, not these projection internals, so only the version whitelist gains 80.
#
# v81 (fn-888 task .2) converges ``epics.job_links`` under the new cheap
# ``syncPlanLinks`` fold: task .1 swapped the O(touched_epics x swept_sessions)
# per-epic session-sweep for an idempotent per-session replace-by-key merge whose
# per-event cost is independent of board size. The migration mirrors the v80
# rewind/wipe block (cursor-0 rewind + canonical projection wipe, ``commit_trailer_facts``
# preserved, git skip-floor RAISED not reset) so the re-fold converges every epic under
# the fast logic and self-validates (the ~15-min replay now runs in ~1-2 min).
# keeper-py reads ``jobs`` / ``epics`` over the socket, not these internals, so only the
# version whitelist gains 81.
#
# v87 (fn-946 task .1) adds the ``handoffs`` reducer projection — the durable
# ``keeper handoff`` enqueue + dispatcher transactional-outbox record. keeper-py
# never reads this table, so only the version whitelist gains 87.
#
# v89 (fn-952 task .2) adds the ``tmux_client_focus`` LIVE-ONLY singleton — the
# current tmux client's focused session/window/pane, fed by keeperd's persistent
# ``tmux -C`` control worker. keeper-py never reads this table, so only the
# version whitelist gains 89.
#
# v90 (fn-954 task .1) adds the ``autopilot_state.max_concurrent_per_root``
# config column — the runtime-settable per-root dispatch concurrency count.
# keeper-py never reads this column, so only the version whitelist gains 90.
#
# v91 (fn-959 task .1) adds the ``autopilot_state.worktree_mode`` config column —
# the runtime-settable durable toggle for worktree-shaped autopilot dispatch.
# keeper-py never reads this column, so only the version whitelist gains 91.
# v93 adds codex-spark usage quota columns; keeper-py never reads them, so only
# the version whitelist gains 93.
# v94 (fn-997 task .1) adds the durable per-job ``events.worktree`` /
# ``jobs.worktree`` lane-branch marker; keeper-py never reads them, so only the
# version whitelist gains 94.
# v95 (fn-1000 task .1) adds the nullable ``usage.error_kind`` failure
# classification column; keeper-py never reads ``usage``, so only the version
# whitelist gains 95.
# v96 (fn-1003 task .2) adds the nullable ``handoffs.target_dir`` column — the
# resolved absolute directory a ``keeper handoff --dir`` launches the handoff-ee
# in; keeper-py never reads ``handoffs``, so only the version whitelist gains 96.
# v98 (fn-1009 task .1) adds the nullable ``dispatch_failures.merge_escalated_at``
# once-marker for the daemon merge-escalation sweep; keeper-py never reads
# ``dispatch_failures``, so only the version whitelist gains 98.
# v100 (fn-1024 task .1) adds the six nullable per-session telemetry columns to
# ``jobs`` (current model / effort / context-window usage from the statusLine
# payload); keeper-py never reads them, so only the version whitelist gains 100.
# v101 (fn-1034 task .1) adds the nullable ``autopilot_state.worktree_multi_repo``
# rollout flag (multi-repo worktree epics); keeper-py never reads
# ``autopilot_state``, so only the version whitelist gains 101.
# v102 (fn-1061 task .1) adds the durable ``dispatch_mint_gate`` producer table
# (the one-logical-dispatch-one-row rate-limit gate); keeper-py never reads it, so
# only the version whitelist gains 102.
# v103 (fn-1075 task .2) adds the nullable ``jobs.kill_reason`` column; keeper-py
# never reads it, so only the version whitelist gains 103.
# v104 (fn-1083 task .2) adds the nullable ``epics.question`` column (the
# epic-level parked-closer question); the fixed epics SELECT list below names
# only ``epic_id, project_dir, tasks, jobs``, so keeper-py never reads the new
# column and only the version whitelist gains 104.
# v105 (fn-1086 task .1) adds the ``dispatch_instant_death`` reducer projection
# table (the instant-death circuit breaker's counter); keeper-py never reads it,
# so only the version whitelist gains 105.
# v106 (fn-1088 task .1) adds the nullable ``dispatch_failures.resolver_dispatched_at``
# once-marker (the merge-resolver-worker dispatch latch, sibling of
# ``merge_escalated_at``); keeper-py never reads ``dispatch_failures``, so only the
# version whitelist gains 106.
# v107 (fn-1102 task .1) adds the ``events.tmux_generation_id`` VIRTUAL generated
# column + its partial index (the tab-restore generation-summary walk's indexed
# key); keeper-py never reads it, so only the version whitelist gains 107.
# v108 (fn-1107 task .1) adds the nullable ``jobs.dispatch_origin`` TEXT column (the
# autopilot-vs-manual provenance discriminator the autoclose worker scopes on);
# keeper-py never reads the new column, so only the version whitelist gains 108.
# v109 (fn-1103 task .3) adds the nullable ``harness`` + ``resume_target`` TEXT
# columns to BOTH the events and jobs surfaces (multi-harness agent maturity);
# keeper-py reads neither column, so only the version whitelist gains 109.
# v110 (fn-1129 task .1) adds the nullable ``human_notified_at`` once-marker to
# BOTH ``dispatch_failures`` and ``block_escalations`` (the escalation-session
# decline/death human-notify latch); keeper-py reads neither table, so only the
# version whitelist gains 110.
# v111 (fn-1131 task .1) adds the nullable ``adopted`` INTEGER column to BOTH the
# events and jobs surfaces (the harness-session adoption marker) and the
# ``autopilot_state.codex_adoption`` INTEGER knob; keeper-py reads none of the
# three, so only the version whitelist gains 111.
# v112 (fn-1151 task .2) appends the nullable ``epics.selection_review`` TEXT
# column (the epic-level close-time selection-review record); the fixed epics
# SELECT names only ``epic_id, project_dir, tasks, jobs``, so only the version
# whitelist gains 112.
SUPPORTED_SCHEMA_VERSIONS = frozenset(
    {
        31,
        32,
        33,
        34,
        35,
        36,
        37,
        38,
        39,
        40,
        41,
        42,
        43,
        44,
        45,
        46,
        47,
        48,
        49,
        50,
        51,
        52,
        53,
        54,
        55,
        56,
        57,
        58,
        59,
        60,
        61,
        62,
        63,
        64,
        65,
        66,
        67,
        68,
        69,
        70,
        71,
        72,
        73,
        74,
        75,
        76,
        77,
        78,
        79,
        80,
        81,
        82,
        83,
        84,
        85,
        86,
        87,
        88,
        89,
        90,
        91,
        92,
        93,
        94,
        95,
        96,
        97,
        98,
        99,
        100,
        101,
        102,
        103,
        104,
        105,
        106,
        107,
        108,
        109,
        110,
        111,
        112,
    }
)


class KeeperError(Exception):
    """Base class for keeper-py failures."""


class KeeperDBMissing(KeeperError):
    """``keeper.db`` does not exist — the daemon never ran on this host."""


class KeeperSchemaError(KeeperError):
    """``keeper.db`` schema version is outside the supported set.

    Raised loud rather than returning wrong data: a schema the reader does
    not understand may have moved columns the attribution query depends on.
    """


def _resolve_db_path() -> Path:
    """Resolve ``keeper.db`` the same way keeper's ``resolveDbPath`` does.

    ``KEEPER_DB`` env var wins (tests, inspect tooling); otherwise the
    ``~/.local/state/keeper/keeper.db`` default.  Kept byte-identical to
    ``src/db.ts`` so the reader and the daemon never disagree on which file
    is canonical.
    """
    override = os.environ.get("KEEPER_DB")
    if override:
        return Path(override)
    return Path.home() / ".local" / "state" / "keeper" / "keeper.db"


def _open_readonly(path: Path) -> sqlite3.Connection:
    """Open *path* read-only with the consumer pragmas keeper sanctions.

    ``mode=ro`` fails fast if the file is absent and forbids writes;
    ``query_only`` is engine-level defense-in-depth; ``busy_timeout`` lets a
    reader wait out a WAL checkpoint instead of erroring with SQLITE_BUSY.
    We never touch ``journal_mode`` (the producer owns it) and never use
    ``immutable=1`` / ``nolock=1`` (keeper writes WAL frames live).
    """
    if not path.exists():
        raise KeeperDBMissing(f"keeper DB not found at {path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def _check_schema(conn: sqlite3.Connection) -> None:
    """Raise ``KeeperSchemaError`` unless the keeper schema is supported.

    keeper stores its version as a ``meta`` key/value row (``value`` is TEXT),
    read the same way ``src/db.ts`` reads it.
    """
    try:
        row = conn.execute(
            "SELECT value FROM meta WHERE key = 'schema_version'"
        ).fetchone()
    except sqlite3.Error as exc:
        raise KeeperSchemaError(f"keeper DB has no readable meta row: {exc}") from exc
    if row is None:
        raise KeeperSchemaError("keeper DB has no meta schema_version row")
    try:
        version = int(row[0])
    except (TypeError, ValueError) as exc:
        raise KeeperSchemaError(
            f"keeper schema_version is not an integer: {row[0]!r}"
        ) from exc
    if version not in SUPPORTED_SCHEMA_VERSIONS:
        raise KeeperSchemaError(
            f"keeper DB schema v{version} is not supported by this keeper-py "
            f"(supports {sorted(SUPPORTED_SCHEMA_VERSIONS)}); upgrade keeper-py"
        )


def get_session_titles() -> dict[str, str]:
    """Return ``{session_id: title}`` for every job that has a title.

    Reads keeper's ``jobs`` projection (``job_id`` is the session id in v1;
    ``title`` is the human-readable session name, seeded at SessionStart and
    refined by prompt/transcript per the reducer's ``title_source``
    precedence).  Jobs with a NULL ``title`` are omitted, mirroring the old
    hooks-tracker ``WHERE name IS NOT NULL`` filter.

    Raises ``KeeperDBMissing`` / ``KeeperSchemaError`` like the other readers
    here — no silent fallback.
    """
    path = _resolve_db_path()
    conn = _open_readonly(path)
    try:
        _check_schema(conn)
        return {
            job_id: title
            for job_id, title in conn.execute(
                "SELECT job_id, title FROM jobs WHERE title IS NOT NULL"
            )
        }
    finally:
        conn.close()


def get_session_name_history() -> dict[str, list[str]]:
    """Return ``{session_id: [title, ...]}`` for every job's name history.

    Reads keeper's ``jobs.name_history`` column (schema v40, fn-652): a JSON
    array of the distinct titles a session has carried, oldest→newest, capped
    at the most-recent 20.  Used by claudectl to resolve a session by any name
    it ever had (retiring the old hooks-tracker ``load_all_session_names``).

    A malformed or empty ``name_history`` cell folds to ``[]`` for that job
    (defensive — never raise on a single bad row, mirroring
    ``_dirty_paths_by_repo``).  Every job row is included, even ones whose
    history is empty, so callers can distinguish "no history" from "no such
    session".

    Raises ``KeeperDBMissing`` / ``KeeperSchemaError`` like the other readers
    here — no silent fallback.
    """
    path = _resolve_db_path()
    conn = _open_readonly(path)
    try:
        _check_schema(conn)
        out: dict[str, list[str]] = {}
        for job_id, name_history in conn.execute(
            "SELECT job_id, name_history FROM jobs"
        ):
            history: list[str] = []
            try:
                parsed = json.loads(name_history)
                if isinstance(parsed, list):
                    history = [n for n in parsed if isinstance(n, str)]
            except (ValueError, TypeError):
                history = []
            out[job_id] = history
        return out
    finally:
        conn.close()


def get_session_for_pid(pid: int) -> str | None:
    """Return the latest session id whose ``jobs.pid`` equals *pid*, or ``None``.

    Reads keeper's ``jobs`` projection.  ``ORDER BY updated_at DESC LIMIT 1``
    picks the freshest row for *pid* — pid reuse is real (the OS recycles
    pids), so a long-running consumer can match a recycled pid's newer
    unrelated job.  Callers that need authoritative identity should prefer the
    ``CLAUDE_CODE_SESSION_ID`` env var and treat this lookup as best-effort
    (the documented contract in ``cli_common.session_context``).

    The ``idx_jobs_pid`` covering index added in fn-615.1 keeps the lookup
    O(log n) even as ``jobs`` grows.

    Raises ``KeeperDBMissing`` / ``KeeperSchemaError`` like the other readers
    here — no silent fallback.
    """
    path = _resolve_db_path()
    conn = _open_readonly(path)
    try:
        _check_schema(conn)
        row = conn.execute(
            "SELECT job_id FROM jobs WHERE pid = ? ORDER BY updated_at DESC LIMIT 1",
            (pid,),
        ).fetchone()
        return row[0] if row is not None else None
    finally:
        conn.close()


def get_session_identity_for_pid(pid: int) -> dict | None:
    """Return the live identity of the session owning *pid*, or ``None``.

    Shape::

        {"session_id": "<job_id>",
         "title": "<current name>" | None,    # NULL title -> None
         "name_history": ["<oldest>", ..., "<newest>"]}

    Purpose-built single-read seam for the Agent Bus, which keys its channels by the
    Claude harness pid and needs the *live* (post-rename) session title plus
    the full name history together — replacing the frozen launch-argv name
    that went stale on every rename.  Composes what ``get_session_for_pid`` /
    ``get_session_titles`` / ``get_session_name_history`` each expose, but in
    one ``jobs`` read keyed by pid so callers don't open the db three times.

    ``ORDER BY updated_at DESC LIMIT 1`` mirrors ``get_session_for_pid`` — pid
    reuse is real (the OS recycles pids), so the freshest row for *pid* wins
    and callers treat this as best-effort correlation, not authoritative
    identity.  ``name_history`` decodes DEFENSIVELY (malformed / non-list cell
    folds to ``[]``), mirroring ``get_session_name_history``.

    Raises ``KeeperDBMissing`` / ``KeeperSchemaError`` like the other readers
    here — no silent fallback.
    """
    path = _resolve_db_path()
    conn = _open_readonly(path)
    try:
        _check_schema(conn)
        row = conn.execute(
            "SELECT job_id, title, name_history FROM jobs "
            "WHERE pid = ? ORDER BY updated_at DESC LIMIT 1",
            (pid,),
        ).fetchone()
        if row is None:
            return None
        job_id, title, name_history = row
        return {
            "session_id": job_id,
            "title": title if title else None,
            "name_history": [
                n for n in _decode_json_list(name_history) if isinstance(n, str)
            ],
        }
    finally:
        conn.close()


def _decode_json_list(cell: object) -> list:
    """Decode a JSON-TEXT cell defensively to a ``list``.

    Mirrors the ``Array.isArray(x) ? x : []`` defense the TS renderer relies
    on and the ``_dirty_paths_by_repo`` malformed-cell handler: a parse error,
    a non-string cell, or a non-list payload all fold to ``[]`` rather than
    raising — so a single bad row never breaks the reader.
    """
    if not isinstance(cell, (str, bytes, bytearray)):
        return []
    try:
        parsed = json.loads(cell)
    except (ValueError, TypeError):
        return []
    return parsed if isinstance(parsed, list) else []


def get_epic(epic_id: str) -> dict | None:
    """Return one epic row as a ``dict``, or ``None`` when no row matches.

    Shape::

        {
          "epic_id": "<id>",
          "project_dir": "<abs path>" | None,
          "tasks": [<embedded task dict>, ...],   # decoded from JSON-TEXT
          "jobs":  [<embedded job dict>, ...],    # decoded from JSON-TEXT
        }

    Reads keeper's ``epics`` projection.  The ``tasks`` / ``jobs`` columns
    are JSON-TEXT (``NOT NULL DEFAULT '[]'``) and are decoded DEFENSIVELY
    via :func:`_decode_json_list` — a malformed cell folds to ``[]``,
    mirroring the TS renderer's ``Array.isArray(x) ? x : []`` defense.
    Embedded items inside the arrays (e.g. ``EmbeddedJob`` fields like
    ``created_at`` the downstream freshest-pick relies on) ride opaque —
    the reader does not validate their inner shape.

    Consumed by ``keeper plan render-approve-context`` to walk an epic's
    embedded ``jobs`` / ``tasks[].jobs`` arrays when picking a target job
    for the ``/plan:approve`` evidence read.

    Raises ``KeeperDBMissing`` / ``KeeperSchemaError`` like the other
    readers here — no silent fallback.
    """
    path = _resolve_db_path()
    conn = _open_readonly(path)
    try:
        _check_schema(conn)
        row = conn.execute(
            "SELECT epic_id, project_dir, tasks, jobs FROM epics WHERE epic_id = ?",
            (epic_id,),
        ).fetchone()
        if row is None:
            return None
        epic_id_, project_dir, tasks_cell, jobs_cell = row
        return {
            "epic_id": epic_id_,
            "project_dir": project_dir,
            "tasks": _decode_json_list(tasks_cell),
            "jobs": _decode_json_list(jobs_cell),
        }
    finally:
        conn.close()


def get_job(job_id: str) -> dict | None:
    """Return one job row as a ``dict``, or ``None`` when no row matches.

    Shape::

        {
          "job_id": "<id>",
          "transcript_path": "<abs path>" | None,
          "cwd": "<abs path>" | None,
          "state": "<lifecycle state>",
        }

    Reads keeper's ``jobs`` projection.  All four columns are real columns
    on ``CREATE_JOBS`` (no JSON decode); ``transcript_path`` / ``cwd`` are
    nullable, ``state`` is ``NOT NULL DEFAULT 'stopped'``.

    Consumed by ``keeper plan render-approve-context`` to resolve the target
    session's transcript file (read live, fresh) and project working dir
    for the ``/plan:approve`` final-message extract.

    Raises ``KeeperDBMissing`` / ``KeeperSchemaError`` like the other
    readers here — no silent fallback.
    """
    path = _resolve_db_path()
    conn = _open_readonly(path)
    try:
        _check_schema(conn)
        row = conn.execute(
            "SELECT job_id, transcript_path, cwd, state FROM jobs WHERE job_id = ?",
            (job_id,),
        ).fetchone()
        if row is None:
            return None
        job_id_, transcript_path, cwd, state = row
        return {
            "job_id": job_id_,
            "transcript_path": transcript_path,
            "cwd": cwd,
            "state": state,
        }
    finally:
        conn.close()


def get_latest_session() -> dict | None:
    """Return the most-recently-updated job, or ``None`` when no jobs exist.

    Shape (matches the ``cli_common.session_context.show_context`` schema)::

        {"session-id": "<job_id>", "cwd": "<cwd or None>",
         "session-name": "<title>"}  # session-name omitted when title is NULL

    Reads keeper's ``jobs`` projection.  ``ORDER BY updated_at DESC LIMIT 1``
    selects the freshest job — the reducer stamps ``updated_at`` on
    SessionStart / resume / UserPromptSubmit and every projection-touching
    fold, so "latest by updated_at" tracks the currently-active session.

    Raises ``KeeperDBMissing`` / ``KeeperSchemaError`` like the other readers
    here — no silent fallback.
    """
    path = _resolve_db_path()
    conn = _open_readonly(path)
    try:
        _check_schema(conn)
        row = conn.execute(
            "SELECT job_id, cwd, title FROM jobs ORDER BY updated_at DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        job_id, cwd, title = row
        out: dict = {"session-id": job_id, "cwd": cwd}
        if title is not None:
            out["session-name"] = title
        return out
    finally:
        conn.close()
