# CONTEXT — keeper ubiquitous language

keeper's terms of art, grouped by bounded context. Each entry is a role-and-behavior definition plus an `Avoid:` line naming rejected synonyms — concepts only, never files, code, or history (decisions live in `docs/adr/`, provenance in commit messages).

## Event-sourcing core
- **Event**: An immutable, totally-ordered record of something that happened, and the only source of truth keeper derives state from. Avoid: message, log entry, mutation.
- **Synthetic event**: An event keeper mints itself to record a mutation, so every state change round-trips through the same append-only stream a real event would. Avoid: command, direct write, side effect.
- **Projection**: A read-optimized view keeper derives purely by folding the event stream; it is disposable and rebuildable, never a source of truth. Avoid: cache, materialized view, table of record.
- **Fold**: The pure step that applies one event to a projection and advances the cursor in the same transaction. Avoid: ingest, handler, apply-and-save.
- **Reducer**: The component that folds events into projections and owns the sole write path to them. Avoid: processor, service, controller.
- **Cursor**: The last event id a reducer has folded, marking how far a projection has caught up; a stream position, distinct from the per-row lifecycle stamp. Avoid: pointer, offset, watermark.
- **Lifecycle stamp**: The per-job event-time high-water mark that lifecycle state transitions may not regress behind, so a stale out-of-order event annotates but never resurrects state. Avoid: watermark, cursor, last-seen.
- **Re-fold**: Rebuilding a projection by replaying every event, which stays deterministic only because a fold never reads wall-clock, environment, or the filesystem. Avoid: rebuild, replay-repair, reprocess.
- **Dead letter**: An event the reducer could not fold, parked for inspection and later replay instead of crashing the fold. Avoid: error queue, poison message, reject.
- **Live-only projection**: A projection derived from the live world rather than replayed events, so it is refreshed in place and never wiped by a rewind. Avoid: snapshot, ephemeral view, scratch state.
- **Migration ladder**: The ordered array of explicit-version `{version, kind, apply}` step entries `migrate()` applies in order, with `SCHEMA_VERSION` derived as the tail entry's version rather than hand-typed. Avoid: registry (that word belongs to Usage-model registry), migration list, schema chain.
- **Additive-idempotent step**: A migration ladder step whose `kind` only adds structure and converges safely on repeated application, the one class a merge-time renumber may resolve mechanically without a human. Avoid: safe migration, non-destructive step, idempotent guard.
- **Schema singleton**: The property that keeper's schema is one lane-at-a-time resource, so two concurrent schema edits are meant to collide at merge rather than compose silently. Avoid: shared resource, lock file, mutex.

## Plan board
- **Board**: The read-only plan state — epics, tasks, and their readiness — that an agent orients on before acting. Avoid: backlog, kanban, queue.
- **Epic**: A tracked unit of work holding a spec and an ordered set of dependent tasks. Avoid: project, story, milestone.
- **Task**: One acceptance-bounded slice of an epic that a single worker implements end-to-end. Avoid: subtask, issue, chore.
- **Plan**: The durable spec-and-dependency graph for an epic, authored interactively and consumed read-only, never mutated by the reducer. Avoid: roadmap, schedule, spec sheet.
- **Id ledger**: The host-local append-only record of every plan number a project has handed out, consulted at mint alongside the directory scan so destroying a minted file can never free its number. Avoid: high-water mark, watermark, counter.
- **Brief**: The self-contained context packet a worker receives for its task, carrying the spec and glossary out-of-band instead of inlined prose. Avoid: prompt, ticket body, handoff note.
- **Readiness**: The gate deciding whether a task may dispatch, recomputed each cycle from its dependencies and validation state. Avoid: status, priority, availability.
- **Arm**: To flip an epic or task from not-ready to dispatchable by stamping it validated. Avoid: enable, approve, unlock.
- **Ghost**: A not-yet-validated epic or task that renders dashed and blocks dispatch until it is armed. Avoid: draft, stub, placeholder.
- **Tier**: The capability class assigned to a task that selects which model and worker cell runs it. Avoid: level, rank, weight.
- **Worker cell**: The one `{model × tier}` `work` plugin a task's launcher selects at launch; a native cell runs its model in-session, a wrapped cell delegates to the model's serving provider. Avoid: variant, flavor, profile.
- **Capability model**: The model-axis value a task carries, a capability token derived from a Provider's launch id (the segment after its last `/`, the whole id when slash-free); native when the claude provider serves it, wrapped otherwise. Avoid: harness model, backend model, model alias.
- **Launch id**: A Provider's model entry, the string a harness CLI receives verbatim — a bare scalar or an `{id, efforts}` form carrying a per-model effort-list override — from which the Capability model derives by basename. Avoid: alias target, model alias, native alias.
- **Provider**: A harness's entry in the host matrix config, tying it to the launch ids it serves. Avoid: vendor, backend, platform.
- **Pecking order**: The provider list order in the host matrix config, cost-ascending, deciding at run time which provider serves a wrapped cell; the same derived capability served by more than one provider is one axis value, owned by the first provider in the order, with every other entry recorded as a shadow — tracked in the parsed matrix, not yet surfaced on any reading path. Avoid: priority list, fallback chain, ranking.
- **Worker-cell eligibility list**: The host matrix's `subagent_models` list, the explicit capability tokens eligible to render and select as worker cells; a roster capability absent from it still enumerates as a launch triple but never joins the cell set — the sole per-capability launch-only mechanism. Avoid: model roster, capability list, launch-only provider.
- **Cell-template inventory**: The host matrix's `subagent_templates` list, the explicit template paths the renderer fans out over the Worker-cell eligibility list × efforts into rendered worker cells. Avoid: template list, frontmatter marker, self-declared template.
- **Wrapped cell**: A worker cell whose model claude does not serve natively; its worker is a claude wrapper that delegates implementation to the model's provider and owns the keeper close-out. Avoid: foreign cell, proxy worker, delegated task.
- **Wrapper driver**: The fixed claude model-and-effort every wrapped cell's wrapper runs at, set in the host matrix config. Avoid: chaperone, host model.
- **Baseline**: The daemon-computed suite result at a commit sha that a worker consults to attribute a test failure as pre-existing or self-inflicted. Avoid: cache, snapshot, golden.
- **Audit depth**: The lean, standard, or deep band a close audit runs at, derived from plan signals through the audit policy. Avoid: review level, thoroughness, rigor.
- **Audited task**: A task whose selected tier is policy-flagged for review, parking AUDIT_READY instead of stamping done until its audit clears. Avoid: keystone task, gated task, flagged task.
- **Audit gate**: The block-machinery hold between a worker finishing and its done-stamp, where the task-scoped audit decides resume or escalation. Avoid: review gate, done gate, checkpoint.
- **Blocking follow-up**: A follow-up epic the close audit requires to complete before its source epic may stamp done; the source stays open, holding every epic that depends on it. Avoid: gating epic, close blocker.

## Autopilot and dispatch
- **Autopilot**: The server-side loop that reconciles the board against running work, dispatching ready tasks and closing finished epics without a human. Avoid: scheduler, cron, orchestrator.
- **Reconciler**: The level-triggered core of autopilot that re-derives what should be running from current state each cycle. Avoid: dispatcher, poller, event loop.
- **Dispatch**: To fire one worker at a task or a close, whether by autopilot or by hand. Avoid: launch, spawn, enqueue.
- **Reaper**: A background sweep that reclaims stuck, stale, or dead work so the board keeps moving. Avoid: cleanup job, garbage collector, timeout.
- **Phantom-working**: A job row stuck reading working after its session has gone permanently idle, so autoclose, readiness, and dependent dispatches all consume the wrong state. Avoid: zombie job, ghost worker, stale running.
- **Drain**: Folding a backlog of pending events to completion in bounded batches. Avoid: flush, catch-up, backfill.
- **Drained scope**: The axis selecting WHICH work `keeper await drained` requires at rest — `plan` (the default: only Board-work sessions plus open plan rows/pending dispatches count, so the caller's own session and any Adopted job or other external session never hold it), `inflight` (only currently running dispatched work and pending dispatches, ignoring ready-but-undispatched rows), or `board` (the strict prior gate: every session counts, the whole board must be at rest). Avoid: drain mode, wait scope, board scope (that names one value, not the axis).
- **Catching up**: The daemon-reported not-ready window — boot gate un-flipped, fold cursor behind the events head, or git surface unseeded — carried on every boot-status header, during which reads are provisional and viewers gate to a loading indicator; distinct from Drain, the folding mechanism that closes it. Avoid: booting, loading, warming up.
- **Sticky**: A dispatch failure that stays parked and visible until an operator retries it, rather than clearing itself. Avoid: transient error, flake, warning.
- **Needs-human**: The family of board signals requiring operator attention — dead letters, block escalations, parked questions, and stuck dispatches, with finalize-non-ff, the instant-death wall, and homed blocked-work rows as subsets of stuck dispatches that never double-count into the total, plus display-only members like the pinned epic that never count toward the jam total at all. Avoid: alert queue, error state, attention list.
- **Operator jam**: A dispatch failure whose reason class cannot self-clear, leaving the board wedged until an operator acts; alarm surfaces fire on the jam class, while the broad sticky count stays a status display. Avoid: stuck row, hard failure, blockage.
- **Parked question**: A question a worker left on its epic awaiting a human answer, surfaced as a needs-human signal until it is answered. Avoid: blocker, prompt, open ask.
- **Pinned epic**: The full epic block a live close/work dispatch failure keeps rendered on the board after the epic closes — display-only, its lifetime exactly the failure row's. Avoid: sticky epic, ghost epic, zombie row.
- **Selection review**: The committed, per-epic dataset of out-of-band verdicts grading whether each executed worker cell was underpowered, right-sized, or overpowered; a human-invoked skill assembles and grades it after the epic closes, and it is advisory input to model-selector policy, never a live board signal. Avoid: selection score, rating, quality audit.
- **Selector verdict**: The raw JSON cell-set a model-selector subagent returns as its final message — untrusted input the calling skill pipes verbatim to the trusted apply seam, never applied by the selector itself. Avoid: assignment, selection (alone).
- **Selection verdict document**: The staged ordinal-keyed verdict file the apply seam writes under gitignored selection state for close-finalize to consume when a follow-up epic's tasks are born pre-selected. Avoid: verdict file, followup verdict (as a distinct concept).
- **Instant-death wall**: The needs-human threshold reached when enough dispatch keys trip the instant-death breaker at once that the failures read as an account or quota wall rather than isolated crashes. Avoid: crash wall, breaker count, death spiral.
- **Distress row**: The single sticky signal keeper mints when it is crash-looping, cleared only once the boot rate recovers. Avoid: alert, log line, exception.
- **Escalation dispatch**: The autopilot response to a stuck task or merge that fires a purpose-built session carrying an assembled incident brief, rather than waking the work's original creator. Bounded by a global concurrent cap on turn-active occupancy (a stopped-with-idle-backend session does not count as live) and per-epic serialization; the human is paged exactly once, only when a session declines or dies. Avoid: creator-wake, planner-notify, page.
- **Unblock session**: The `unblock::<task>` escalation session autopilot dispatches for a blocked task whose category is escalatable, loading the brief to resolve the block without the creator's context. Distinct from the `keeper plan unblock` board verb (which flips a task `blocked → todo`): the session is the escalation actor, the verb is one action it may take. Avoid: unblock verb, resume, re-dispatch.
- **Deconflict session**: The `deconflict::<epic>` escalation session autopilot dispatches once the tier-1 Resolver declines a merge conflict, loading the context the mechanical resolver lacked to settle a conflict that needs judgment. Avoid: resolver, merger, second-pass resolver.
- **Repair session**: The `repair::<repo>` escalation session autopilot dispatches for a `SHARED_BASE_BROKEN` incident, write-capable and repo-scoped (spanning every epic blocked on that repo's base) rather than epic-scoped like a Deconflict session; it lands a trunk commit in the shared checkout, then fans out unblock across every affected task. Avoid: deconflict session, base fixer, trunk bot.
- **SHARED_BASE_BROKEN**: The baseline-gated blocked category naming a repo's default branch red at HEAD in a healthy environment, independent of the worker's own diff, routed to a Repair session rather than the task's own unblock. Avoid: broken build, base failure, pre-existing failure.
- **Escalation role**: The launch-injected `KEEPER_ESCALATION_ROLE` marker an escalation session carries, which the escalation-guard hook keys its Bash command-family allowlist on — diagnosis-only for unblock/resolve, write-capable for deconflict/repair. Avoid: session type, escalation kind, launch flag.
- **Block instance**: One entering-blocked episode of a task, identified by the event that armed it; an unblock followed by a re-block opens a new instance, and escalation state is scoped per instance, never per task. Avoid: block, blocked state, re-block (as a noun for the same instance).
- **Pill**: A small colored status badge the board and statusline render to show a job's kind or state. Avoid: label, tag, icon.
- **Per-root cap**: The per-repo concurrent-dispatch limit stored as durable intent, applying while worktree mode is on. The effective cap dispatch honors is derived at read time and floors to one whenever worktree mode is off. Avoid: pinned cap; conflating stored with effective.

## Worktree and merge
- **Lane**: A per-task worktree the autopilot derives from the dependency graph each cycle to run tasks in parallel. Avoid: branch, checkout, slot.
- **Worktree mode**: A producer-only autopilot setting that gives each ready task its own isolated checkout instead of sharing one. Avoid: parallel mode, multi-branch, fork mode.
- **Merge-gate**: The check that holds a dependent lane until every upstream it needs has truly merged into the local default branch. Avoid: barrier, dependency wait, lock.
- **Resolver**: The tier-1 autonomous worker autopilot dispatches to settle a mechanically-clear merge conflict, stamping blocked when judgment is needed; a decline hands the conflict off to the context-loaded Deconflict session. Avoid: merger, rebase bot, fixer, deconflict session.
- **Fan-in**: The convergence point where parallel lanes or failures collapse onto one epic-keyed outcome. Avoid: join, merge point, aggregation.
- **Recover pass**: The per-cycle worktree sweep that aborts interrupted merges, merges a done-but-unmerged epic base into the default branch, and prunes orphaned lanes. Avoid: cleanup pass, reconcile, gc.
- **Lane pre-merge**: The guard that vets a dependent task's base lane before its fan-in merges the completed siblings in — restoring a provably-redundant leak to the base's HEAD, deferring a base it cannot safely settle to a self-clearing row, and escalating a persistent wedge to a needs-human distress. Avoid: clean, cleanup, premerge fixup.

## Account routing
- **Capacity observation**: A freshness-bounded report from optional external tools that may inform selection for one new agent process, but is never durable truth. Avoid: usage projection, account state, balance record.
- **Account route**: The account execution path selected independently for one new agent process, including a process resuming or restoring an existing conversation; it never binds that conversation to the account for a later launch. Avoid: profile, pin, affinity, session account.
- **Launch attribution**: The immutable fact of which Account route one process used, retained for explanation and forensics but never consumed to route a later process. Avoid: account affinity, profile name, pin.
- **Launch reservation**: Short-lived, non-exclusive pressure applied during concurrent account selection so new processes do not stampede one route; it conveys no durable ownership. Avoid: lease, lock, affinity.

## Usage scraping
- **Usage-model registry**: The `usage_models` keeper-config map declaring which claude profiles and codex the usage scraper produces envelopes for, keyed by envelope id with an optional display alias per entry; an absent or malformed map idles the producer rather than erroring. Avoid: profile catalog, account list, scrape targets.
- **agentusage**: The frozen on-disk namespace the usage scraper writes and reads — the envelope root, the tmux socket, and the path-filter token that share this name — pinned as a fixed wire/on-disk contract independent of any project directory. Avoid: the agentusage project, external scraper.

## Bus, presence, and session surface
- **Agent Bus**: The local message bus running agents use to talk to each other, joined by subscribing a watch channel. Avoid: pubsub, chat room, socket.
- **Presence**: Being a live participant on the bus by holding an open watch subscription, not merely having sent a message. Avoid: online status, heartbeat, session.
- **Tmux session**: The terminal-multiplexer container workers, viewers, and panels launch into; an unqualified "session" in a launch or dispatch context means this one. Avoid: workspace, window group, terminal.
- **Claude session**: One agent conversation with its own transcript, identified by an immutable session id; jobs and forensics key on it. Avoid: job, chat, conversation.
- **Session title**: The human-renamable display name of a Claude session, distinct from its id; matching by title is a convenience lookup, never an identity. Avoid: session name, label.
- **Sidecar**: The private per-turn docs mirror a session maintains alongside its work, owned by hooks and never the doc body itself. Avoid: backup, shadow copy, cache.
- **Adopted job**: A tracked session a non-launcher path minted — a hand-started hermes self-seed or a claimed codex rollout — rather than the keeper agent launcher, marked so the board pills it distinctly and restore surfaces it. Avoid: orphan, imported session, unmanaged job.
- **Board-work session**: A session keeper itself dispatched — an autopilot `work`/`close` worker or an escalation (unblock/deconflict/resolve/repair) session — as opposed to an Adopted job or any other external session a human or a non-launcher path started. The positive provenance `drained`'s `plan`/`inflight` scopes count on. Avoid: managed session, keeper-owned session, tracked session (that's broader — covers Adopted jobs too).
- **Originator**: The ownership signal on a codex rollout marking it keeper-launched; strictly absent or empty means keeper never owned it, so a sole unambiguous rollout becomes adoptable. Avoid: owner tag, launch marker, origin flag.

## Crash restore
- **Generation**: One tmux server boot — every window and agent observed between a server start and its death, the cohort crash-restore scopes to. One boot carries exactly one keeper-stamped identity, so a probe-format change can never split it in two. Avoid: server epoch, boot id, killed cohort (that is the fallback derivation model, not the concept).
- **Restore**: Relaunching a dead generation's agent tabs so each re-attaches to its exact prior conversation, proven per tab from attach evidence — window creation alone never counts as restored. Avoid: revive (that is the runnable dump-script artifact), resurrect, respawn.
- **Harness resume**: One harness re-attaching to its own persisted session by native id — the per-tab primitive a restore drives. Distinct from the Resume cursor (a fold checkpoint) and from unblocking a task. Avoid: reconnect, reload, restore (that is the whole-generation flow).
- **Resume target**: The harness-native id a harness resume needs — the claude session id, or the stored native id for pi/codex/hermes; empty means not-resumable, and a display title is never a resume key. Avoid: session name, label, job id (identity, not the resume key).
- **Refuse-live**: The resume-time gate that never re-attaches a currently live session — liveness is pid + start-time identity, and a running agent is reached over the bus instead. Avoid: force-resume, live takeover, double-attach.

## Frame stream and supervision
- **Frame**: One rendered snapshot of a viewer's body text, minted only when the rendered content actually changes; the unit the frame stream emits and a sidecar triple records. Avoid: screen, repaint, delta (that is the coarse tail's unit).
- **Resume cursor**: The fold-cursor checkpoint stamped on frames and trailers so a later chunk can anchor where the last one left off; a non-unique checkpoint, never a per-frame id. Avoid: offset, timestamp cursor, seq.
- **Coverage verdict**: The trailer's honest claim about frame completeness — continuous only when one uninterrupted run provably dropped nothing, gap_possible otherwise. Avoid: gapless guarantee, completeness flag.
- **Hyper mode**: The supervision mode that consumes one bounded frame chunk per pass and judges each change as a human proxy — truthful, legible, stable — filing UI defects rather than editing renderers. Avoid: frame mode, firehose mode, vigilant mode.

## Install and reload
- **Shared-source leaf**: A harness's global-instruction discovery path (e.g. `~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`), re-asserted as a symlink into keeper's one `system/shared/AGENTS.md` source on every launch; healed by deleting the source, never the leaf, and distinct from the repo-root `AGENTS.md -> CLAUDE.md` convention symlink. Avoid: config leaf, stow target, dotfile link.
- **Load surface**: The set of checked-in files the resident daemon process actually loads — what the reload fingerprint hashes and the boundary test encloses via the checked-in **roots manifest** declaring its roots through one seam, so the hashed and enforced boundaries cannot disagree; per-invocation code (CLI, hooks, skills) sits outside it. Avoid: footprint, source tree, codebase, allowlist, path list, fingerprint config.

## Daemon liveness and restart forensics
- **Daemon boot**: One keeperd process lifetime from exec to exit, the unit the restart ledger records under a `boot_id`. Distinct from a Generation (one tmux server boot) — the "boot id" that entry rejects refers to the tmux concept, never to this one. Avoid: generation, instance, run.
- **Served latency**: How long the serve worker takes to answer a real client query, self-reported to main as windowed duration percentiles; never measured by an external probe. Avoid: probe latency, response time, lag (that is event-loop delay).
- **Serve starvation**: The degraded wedge where the serve worker answers trivial probes fast while real first-paint queries queue past the client give-up; detectable only from served latency, invisible to an accept-stall probe. Avoid: accept-stall (reads die entirely there), busy-lag (main-loop starvation), brownout.
- **Single-instance lock**: The kernel flock on the dedicated `keeperd.lock` file main acquires before opening the DB, making a second concurrent daemon impossible rather than merely detectable; the kernel releases it on process death, so a stale lock cannot exist. Avoid: pid file, sock lock (the server worker's separate per-socket lock file), mutex.

## Panels and launch triples
- **Launch triple**: The context-free `<harness>::<model>::<effort>` token naming one launchable configuration — the harness-native model id carried verbatim, the effort translated to the harness's own axis; every well-formed triple is launchable, enumerated by the matrix but never gated by it. A capability absent from the Worker-cell eligibility list still enumerates as a launch triple — launch-only is per-capability, not per-provider. Avoid: preset, virtual preset, profile, model alias.
- **Panel**: A named, ordered selection of launch triples convened to answer one question in parallel, each member blind to the others, with a judge fusing the answers; a duplicated member is a distinct leg. Avoid: ensemble, quorum, committee.
- **Panel strength**: A panel's capacity for independent cross-checking, read from its member count and harness diversity; a stronger panel costs proportionally more and runs as slow as its slowest member. Avoid: level, size, tier.
- **Default panel**: The panel the config's top-level `default` pointer names, used whenever no panel is chosen; the reserved word `default` always resolves to it and is never a panel's own name. Avoid: fallback panel, primary panel, default level.
- **Background agent**: A child a harness session launches without blocking its turn; the parent's transcript records the launch and, when the child finishes, a task-notification that re-invokes the parent. Distinct from a Reaper (keeper's own background sweep) and from a plan Task. Avoid: background task, async subagent, detached child.
- **Settled stop**: A transcript stop marker the capture stack accepts as terminal because the session shows no live background agents at that point; an unsettled stop is deferred, bounded by the stop timeout. Avoid: final stop, quiescence, real stop.
