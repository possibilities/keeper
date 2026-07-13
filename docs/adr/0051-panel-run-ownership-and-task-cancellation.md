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
- **The run owns its full tree.** The durable run records every member attempt, wrapper PID and start time, process-group identity, Run-control artifact, judge Task invocation, cancellation reason, and Panel cleanup status. Each attempt pre-registers its panel-owned control location before launch; the launcher publishes the exact socket-qualified Tmux teardown identity there before capture begins. A launch whose control cannot become durable tears down immediately and fails rather than admitting unowned work. Partial launch registers each child before another launch can proceed, so cancellation cannot miss already-created work.
- **Task stays harness-neutral.** The judge remains exactly one foreground `Task(subagent_type, description, prompt)` invocation. Shared skills and agents carry no Pi-specific lifecycle fields. Claude supplies its native Task semantics; Pi's plugin strictly resolves the named agent, creates an internal hierarchical ownership scope, and maps cancellation and final-result behavior onto the same contract.
- **Cancellation is transitive and settling.** Caller abort, explicit panel cancellation, request timeout, and terminating signals tombstone the run before signalling children. The tombstone freezes member registration; cancellation then consumes every attempt's Run-control artifact before terminating its wrapper, recursively stops the judge, and verifies every exact Tmux window absent. Result-bearing attempts remain cleanup obligations. Repeated cancellation shares one idempotent cleanup operation, and an exact already-absent resource is convergence rather than failure.
- **Outcome and cleanup are orthogonal.** The result/cancellation outcome is monotonic; Panel cleanup status independently moves through `pending`, `failed`, and `settled`. A bounded foreground cancellation returns `cleanup_failed` with exact `member#attempt` diagnostics while cleanup is not settled, then reports the durable cancelled outcome once every owned resource is positively absent.
- **Cleanup reconciles automatically.** The panel maintenance worker retries pending and failed exact teardown across initiating-process exit and daemon restart. Unsettled Run-control artifacts are protected from age/count garbage collection until absence is proven. Missing, malformed, ownership-mismatched, or legacy controls fail closed and remain operator-visible; cleanup never reconstructs a target from a title, PID, window index, or current session.
- **Crash recovery is not cancellation.** Unexpected supervisor loss leaves the run recoverable from its durable identity. Explicit cancellation is monotonic and forbids later `start` or `resume` from launching work.
- **Publication follows cleanup.** Result files may land before teardown so answers survive cleanup failure, but the Panel run does not publish outward success until every owned resource is settled. An unconfirmed teardown reports `cleanup_failed` and retains exact unresolved identities for automatic reconciliation; it never masquerades as success.
- **Tracked Pi launches carry Tmux birth-session provenance.** Every keeper-launched tracked Pi process with an explicit Tmux session receives that exact session carrier through the shared launch boundary; launches without an explicit session remain unstamped. The immutable birth fact is corroborated against live topology before daemon autoclose acts and is never backfilled into older jobs. Panel autoclose remains a fallback, not cancellation's proof of success.
- **Testing precedes live inference.** Fast tests use injected clocks, spawners, signals, Task controllers, process identities, and tmux targets to prove cardinality, cancellation races, partial launch, missing controls, result-before-teardown, failed quorum, output failure, exact teardown reconciliation, and Pi provenance without subprocesses or tmux. A bounded real smoke is permitted only after the fake regression gate passes and must prove exact member count, explicit abort, settled cleanup, and zero surviving processes and Tmux windows.

## Alternatives considered

- **Rely on runner instructions and stable slug wording.** Rejected because model reasoning can recurse, retry under a new slug, or omit cleanup.
- **Launch the judge through `keeper agent run`.** Rejected because a harness process launch is not the typed Task contract and does not preserve static-agent policy or hierarchical cancellation.
- **Add Pi ownership fields to the shared Task schema or runner prompt.** Rejected because adapter identities belong at the harness boundary and would split one orchestration contract into harness-specific variants.
- **Treat every supervisor loss as cancellation.** Rejected because it destroys the durable recovery property and conflates an explicit operator decision with a recoverable crash.
- **Return success once answer files exist and clean up asynchronously.** Rejected because terminal success would no longer prove that paid model work and tmux resources have stopped.

## Consequences

Panel retries address one durable identity rather than deriving fresh slugs. Explicit recovery is visible and bounded, while cancellation is monotonic and inspectable. Operators can identify and stop every child from the run directory without broad process matching.

The Pi compatibility layer carries more lifecycle responsibility: strict named-agent resolution, nested Task ownership, acknowledged cancellation, and durable correlation. Shared Plan prompts remain byte-equivalent across harnesses and continue to express judge ownership only through the generic Task vocabulary.

Panel completion may take through the bounded cleanup grace after answers are available. A cleanup failure is loud, retains forensic state, and remains automatically reconcilable instead of returning a successful answer with live work behind it. Cancellation callers can distinguish the monotonic cancelled outcome from its still-pending resource cleanup, while exact already-gone races converge idempotently.
