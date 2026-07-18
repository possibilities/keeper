# 84. Producer-owned launch contract and parked launches

## Status

Accepted. Extends ADRs 0047 and 0063 and relates to ADR 0079's rule that route uncertainty blocks process creation rather than falling back.

## Context

A worker-cell path can be syntactically valid and its compiler-owned manifest can be fresh while the joint launch is impossible. Provider-equivalence translation decides an effective `{model, tier}`, the host matrix classifies that model as native or wrapped, and the pure reconciler provisionally emits a wrapped marker. Those facts previously reached the launch boundary independently. A Provider constraint could therefore select a cell whose available route belonged to the other driver class, allowing a doomed worker to start and park behind its own wrapped-worker guard.

The pure reconciler must remain deterministic and filesystem-free. Manifest existence, compiler-cohort freshness, live route inventory, and process creation are producer concerns. A launched process can also stop making progress before SessionStart binds it to the pending Dispatch attempt. Re-serving that unbound attempt without a visible state hides the only useful inspection surface: its Tmux window.

The durable `worker_provider` setting is a constraint, not a preference or fallback order. “Pin” already names static Agent frontmatter and is rejected for other effective-policy concepts in the glossary, so using it here obscures both scope and failure semantics.

## Decision

The reconciler continues to compose the effective cell and provisional wrapped marker from its injected snapshot. It also carries an admission contract containing the active Provider constraint, effective cell, rendered driver, launchable route class, and marker. It performs no launchability side effect and does not repair the contract.

Immediately before any launch side effect, the autopilot producer re-runs the launcher-owned worker-cell resolution seam. Its ordered admission checks are:

1. matrix and provider-equivalence translation are valid;
2. the effective cell belongs to the matrix;
3. an active Provider constraint agrees with the cell driver (`claude` requires native; `gpt` requires wrapped), the roster-first route exists and has that driver, and the wrapped marker exactly matches wrapped cells while remaining absent for native cells;
4. the exact selected manifest exists and belongs to a fresh compiler-owned cohort; and
5. no preloaded `work` plugin shadows it.

A joint-route failure returns the closed `provider-unlaunchable` machine kind. The producer's exhaustive switch mints the sticky `worker-provider-cell-unlaunchable` DispatchFailed reason naming the Provider constraint and effective cell. A constrained missing or stale manifest likewise names that pair. No launch side effect occurs, siblings remain dispatchable, and only explicit dispatch retry re-arms the failed key after configuration or artifacts are repaired. The pure layer's marker remains provisional: only producer admission authorizes emitting it into a process.

A Parked launch is distinct from a parked Dispatch claim. It is a fired Dispatch attempt whose pending row remains unbound to a Harness session past the launch grace. The launch stays fenced and its Tmux window remains open for inspection. The producer surfaces one self-clearing distress that names that window, suppresses blind re-serve while the condition holds, and clears the distress if a late SessionStart binds the attempt. The timeout proves only absence of binding, never the cause; it does not authorize killing the window or bypassing workspace trust.

## Alternatives considered

- **Validate in the pure reconciler.** Rejected because manifest, route, and launch evidence are producer observations; importing them into the fold would violate replay determinism.
- **Trust the wrapped marker.** Rejected because the marker is derived from the same potentially inconsistent snapshot facts and cannot create a provider route.
- **Let the worker fail after spawn.** Rejected because it consumes a slot, creates a guarded session that may be unable to edit, and hides an admission error as worker behavior.
- **Treat `worker_provider` as a preference.** Rejected because fallback can silently run the wrong provider family; the policy is fail-closed.
- **Classify an unbound timeout as a crash and close its window.** Rejected because no-output and no-bind evidence cannot identify an interactive prompt, account gate, slow boot, or dead process safely.

## Consequences

- Provider-constrained work starts only when constraint, effective cell, driver, route, marker, and exact manifest form one launchable contract.
- Host-matrix route classification becomes explicit producer snapshot data rather than an inference from a generated path.
- Existing native, wrapped, translated, same-family, and unconstrained cells retain their launch behavior when their contracts are coherent.
- Operator diagnostics use **Provider constraint** for runtime family policy and reserve **Agent pin** for static frontmatter pairs.
- Parked-launch distress is observational and self-clearing; it improves visibility without weakening Dispatch fencing, workspace trust, or Tmux cleanup authorization.
