# CONTEXT — keeper ubiquitous language

keeper's terms of art, grouped by bounded context. Each entry is a role-and-behavior
definition plus an `Avoid:` line naming rejected synonyms — concepts only, never files,
code, or history (decisions live in `docs/adr/`, provenance in commit messages).

## Event-sourcing core

- **Event**: An immutable, totally-ordered record of something that happened, and the only source of truth keeper derives state from. Avoid: message, log entry, mutation.
- **Synthetic event**: An event keeper mints itself to record a mutation, so every state change round-trips through the same append-only stream a real event would. Avoid: command, direct write, side effect.
- **Projection**: A read-optimized view keeper derives purely by folding the event stream; it is disposable and rebuildable, never a source of truth. Avoid: cache, materialized view, table of record.
- **Fold**: The pure step that applies one event to a projection and advances the cursor in the same transaction. Avoid: ingest, handler, apply-and-save.
- **Reducer**: The component that folds events into projections and owns the sole write path to them. Avoid: processor, service, controller.
- **Cursor**: The last event id a reducer has folded, marking how far a projection has caught up. Avoid: pointer, offset, watermark.
- **Re-fold**: Rebuilding a projection by replaying every event, which stays deterministic only because a fold never reads wall-clock, environment, or the filesystem. Avoid: rebuild, replay-repair, reprocess.
- **Dead letter**: An event the reducer could not fold, parked for inspection and later replay instead of crashing the fold. Avoid: error queue, poison message, reject.
- **Live-only projection**: A projection derived from the live world rather than replayed events, so it is refreshed in place and never wiped by a rewind. Avoid: snapshot, ephemeral view, scratch state.

## Plan board

- **Board**: The read-only plan state — epics, tasks, and their readiness — that an agent orients on before acting. Avoid: backlog, kanban, queue.
- **Epic**: A tracked unit of work holding a spec and an ordered set of dependent tasks. Avoid: project, story, milestone.
- **Task**: One acceptance-bounded slice of an epic that a single worker implements end-to-end. Avoid: subtask, issue, chore.
- **Plan**: The durable spec-and-dependency graph for an epic, authored interactively and consumed read-only, never mutated by the reducer. Avoid: roadmap, schedule, spec sheet.
- **Brief**: The self-contained context packet a worker receives for its task, carrying the spec and glossary out-of-band instead of inlined prose. Avoid: prompt, ticket body, handoff note.
- **Readiness**: The gate deciding whether a task may dispatch, recomputed each cycle from its dependencies and validation state. Avoid: status, priority, availability.
- **Arm**: To flip an epic or task from not-ready to dispatchable by stamping it validated. Avoid: enable, approve, unlock.
- **Ghost**: A not-yet-validated epic or task that renders dashed and blocks dispatch until it is armed. Avoid: draft, stub, placeholder.
- **Tier**: The capability class assigned to a task that selects which model and worker cell runs it. Avoid: level, rank, weight.
- **Worker cell**: The one `{model × tier}` `work` plugin a task's launcher selects at launch; a native cell runs its model in-session, a wrapped cell delegates to the model's serving provider. Avoid: variant, flavor, profile.
- **Provider**: A harness's entry in the host matrix config, tying it to the models it can serve and optionally aliasing each to its provider-native id. Avoid: vendor, backend, platform.
- **Pecking order**: The provider list order in the host matrix config, cost-ascending, deciding at run time which provider serves a wrapped cell. Avoid: priority list, fallback chain, ranking.
- **Wrapped cell**: A worker cell whose model claude does not serve natively; its worker is a claude wrapper that delegates implementation to the model's provider and owns the keeper close-out. Avoid: foreign cell, proxy worker, delegated task.
- **Wrapper driver**: The fixed claude model-and-effort every wrapped cell's wrapper runs at, set in the host matrix config. Avoid: chaperone, host model.
- **Baseline**: The daemon-computed suite result at a commit sha that a worker consults to attribute a test failure as pre-existing or self-inflicted. Avoid: cache, snapshot, golden.

## Autopilot and dispatch

- **Autopilot**: The server-side loop that reconciles the board against running work, dispatching ready tasks and closing finished epics without a human. Avoid: scheduler, cron, orchestrator.
- **Reconciler**: The level-triggered core of autopilot that re-derives what should be running from current state each cycle. Avoid: dispatcher, poller, event loop.
- **Dispatch**: To fire one worker at a task or a close, whether by autopilot or by hand. Avoid: launch, spawn, enqueue.
- **Reaper**: A background sweep that reclaims stuck, stale, or dead work so the board keeps moving. Avoid: cleanup job, garbage collector, timeout.
- **Drain**: Folding a backlog of pending events to completion in bounded batches. Avoid: flush, catch-up, backfill.
- **Sticky**: A dispatch failure that stays parked and visible until an operator retries it, rather than clearing itself. Avoid: transient error, flake, warning.
- **Needs-human**: The family of board signals requiring operator attention — dead letters, block escalations, parked questions, and stuck dispatches, with finalize-non-ff and the instant-death wall as subsets of stuck dispatches that never double-count into the total, plus display-only members like the selection review that never count toward the jam total at all. Avoid: alert queue, error state, attention list.
- **Operator jam**: A dispatch failure whose reason class cannot self-clear, leaving the board wedged until an operator acts; alarm surfaces fire on the jam class, while the broad sticky count stays a status display. Avoid: stuck row, hard failure, blockage.
- **Parked question**: A question a worker left on its epic awaiting a human answer, surfaced as a needs-human signal until it is answered. Avoid: blocker, prompt, open ask.
- **Selection review**: The clearable, display-only needs-human record a close-time audit leaves when a completed task's worker cell graded underpowered or overpowered (a right-sized verdict stays silent); it outlives the epic's close and never blocks dispatch or close. Avoid: selection score, rating, quality audit.
- **Instant-death wall**: The needs-human threshold reached when enough dispatch keys trip the instant-death breaker at once that the failures read as an account or quota wall rather than isolated crashes. Avoid: crash wall, breaker count, death spiral.
- **Distress row**: The single sticky signal keeper mints when it is crash-looping, cleared only once the boot rate recovers. Avoid: alert, log line, exception.
- **Escalation dispatch**: The autopilot response to a stuck task or merge that fires a purpose-built session carrying an assembled incident brief, rather than waking the work's original creator. Bounded by a global concurrent-session cap and per-epic serialization; the human is paged exactly once, only when a session declines or dies. Avoid: creator-wake, planner-notify, page.
- **Unblock session**: The `unblock::<task>` escalation session autopilot dispatches for a blocked task whose category is escalatable, loading the brief to resolve the block without the creator's context. Distinct from the `keeper plan unblock` board verb (which flips a task `blocked → todo`): the session is the escalation actor, the verb is one action it may take. Avoid: unblock verb, resume, re-dispatch.
- **Deconflict session**: The `deconflict::<epic>` escalation session autopilot dispatches once the tier-1 Resolver declines a merge conflict, loading the context the mechanical resolver lacked to settle a conflict that needs judgment. Avoid: resolver, merger, second-pass resolver.
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
- **Originator**: The ownership signal on a codex rollout marking it keeper-launched; strictly absent or empty means keeper never owned it, so a sole unambiguous rollout becomes adoptable. Avoid: owner tag, launch marker, origin flag.

## Panels and presets

- **Preset**: A named harness-and-model combination in the agent catalog that launches and pairs consistently wherever it is referenced. Avoid: profile, config, model alias.
- **Panel**: A named, ordered selection of presets convened to answer one question in parallel, each member blind to the others, with a judge fusing the answers. Avoid: ensemble, quorum, committee.
- **Panel strength**: A panel's capacity for independent cross-checking, read from its member count and harness diversity; a stronger panel costs proportionally more and runs as slow as its slowest member. Avoid: level, size, tier.
- **Default panel**: The panel the config's top-level `default` pointer names, used whenever no panel is chosen; the reserved word `default` always resolves to it and is never a panel's own name. Avoid: fallback panel, primary panel, default level.
