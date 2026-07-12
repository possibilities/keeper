# 0051 — Panel run ownership and Task cancellation

## Status

Accepted. Extends ADR 0039's harness-neutral Task facade and ADR 0046's authored panel roster.

## Context

A panel combines two lifecycle systems: detached member processes managed through durable panel state, and a typed judge launched through the harness's foreground `Task(subagent_type, description, prompt)` contract. Prompt discipline cannot enforce launch cardinality, prevent a panel member from recursively convening another panel, or ensure cancellation reaches detached wrappers and tmux windows. A model-derived slug identifies a convenient display path but does not establish request ownership, distinguish transport replay from a later intentional invocation, or bound recovery attempts.

Pi implements the shared Task vocabulary through its plugin facade. Adding Pi-specific identifiers or cancellation verbs to shared agent prompts would make orchestration harness-dependent and leave lifecycle correctness to model behavior. Treating the judge as a plain detached `keeper agent run` would also discard typed-agent resolution, tool restrictions, model/effort policy, and foreground cancellation semantics.

Durable crash recovery and explicit cancellation require different outcomes. A vanished supervisor may be replaced and resume the same run, while a caller-requested cancellation must prevent reconciliation from relaunching work. Cleanup also needs positive process identity: a PID, tmux display name, or wrapper exit alone cannot prove that every owned child is gone.

## Decision

- **Admission owns identity.** Before any member launches, Keeper atomically reserves one opaque Panel request identity, stores an immutable digest of its question, roster, and execution posture, and creates its sole Panel run directory. A later intentional invocation receives a new identity even when its arguments match. Reuse of an existing identity joins that run only when the digest matches; mismatch fails without launching.
- **Launch cardinality is mechanical.** A normal Panel request owns one fan-out round. Reissuing `start` is an idempotent reconcile that reuses the existing run and never mints another slug or fan-out. Recovery of positively dead nonterminal work is an explicit, capped `resume` operation under the same run identity. A panel member cannot admit another panel request.
- **The run owns its full tree.** The durable run records every member attempt, wrapper PID and start time, process-group identity, exact socket-qualified tmux target, judge Task invocation, cancellation reason, and cleanup result. Partial launch registers each child before another launch can proceed, so cancellation cannot miss already-created work.
- **Task stays harness-neutral.** The judge remains exactly one foreground `Task(subagent_type, description, prompt)` invocation. Shared skills and agents carry no Pi-specific lifecycle fields. Claude supplies its native Task semantics; Pi's plugin strictly resolves the named agent, creates an internal hierarchical ownership scope, and maps cancellation and final-result behavior onto the same contract.
- **Cancellation is transitive and settling.** Caller abort, explicit panel cancellation, request timeout, and terminating signals tombstone the run before signalling children. Cancellation recursively stops the judge and every registered member resource, using positive identity checks, bounded graceful termination, forced termination, and exact tmux reaping. Repeated cancellation shares one idempotent cleanup operation. A Task cancellation does not settle until its owned child scopes acknowledge terminality or the bounded cleanup records an exact unresolved identity.
- **Crash recovery is not cancellation.** Unexpected supervisor loss leaves the run recoverable from its durable identity. Explicit cancellation is monotonic and forbids later `start` or `resume` from launching work.
- **Publication follows cleanup.** Result files may land before teardown so answers survive cleanup failure, but the Panel run does not publish outward success until every owned resource is settled. An unconfirmed teardown produces a terminal `cleanup_failed` result containing exact unresolved identities; it never masquerades as success or triggers an automatic retry.
- **Testing precedes live inference.** Fast tests use injected clocks, spawners, signals, Task controllers, process identities, and tmux targets to prove cardinality, cancellation races, partial launch, missing messages, failed quorum, output failure, and teardown escalation without subprocesses or tmux. A bounded real smoke is permitted only after the fake regression gate passes and must prove exact member count, explicit abort, and zero surviving children.

## Alternatives considered

- **Rely on runner instructions and stable slug wording.** Rejected because model reasoning can recurse, retry under a new slug, or omit cleanup.
- **Launch the judge through `keeper agent run`.** Rejected because a harness process launch is not the typed Task contract and does not preserve static-agent policy or hierarchical cancellation.
- **Add Pi ownership fields to the shared Task schema or runner prompt.** Rejected because adapter identities belong at the harness boundary and would split one orchestration contract into harness-specific variants.
- **Treat every supervisor loss as cancellation.** Rejected because it destroys the durable recovery property and conflates an explicit operator decision with a recoverable crash.
- **Return success once answer files exist and clean up asynchronously.** Rejected because terminal success would no longer prove that paid model work and tmux resources have stopped.

## Consequences

Panel retries address one durable identity rather than deriving fresh slugs. Explicit recovery is visible and bounded, while cancellation is monotonic and inspectable. Operators can identify and stop every child from the run directory without broad process matching.

The Pi compatibility layer carries more lifecycle responsibility: strict named-agent resolution, nested Task ownership, acknowledged cancellation, and durable correlation. Shared Plan prompts remain byte-equivalent across harnesses and continue to express judge ownership only through the generic Task vocabulary.

Panel completion may take through the bounded cleanup grace after answers are available. A cleanup failure is loud and retains forensic state instead of returning a successful answer with live work behind it.
