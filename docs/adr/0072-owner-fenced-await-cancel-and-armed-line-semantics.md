# 0072 — Owner-fenced durable-await cancel and armed-line semantics

Status: Accepted (provisional number; renumber at fan-in)

## Context

ADR 0054 adopted the durable-awaits contract including a `request_await`
`op:'cancel'` payload variant, and the handler and fold for it exist — but no CLI
verb exposes it, and nothing fences who may cancel: the fold retires any waiting
row by id. A waiting durable await therefore cannot be retired early in practice,
and once it can be, an unfenced cancel would let any session casually retire
another session's await. Keeper is a single-user local daemon, so the fence
guards against accidental cross-session interference, not local malice.
Separately, `keeper await --no-armed-line` suppresses the armed line by returning
before the armed state latches, so `--require-transition`'s edge suppression
never engages: a condition already met at arm time fires immediately — a false
automation fire — and the JSON envelope reports `armed:false` for a session that
did arm.

## Decision

- **Cancel rides the existing surface.** `keeper await cancel <await-id>` sends
  `request_await` `op:'cancel'`. The RPC allowlist does not grow; the fold-owned
  `awaits` projection is never hand-mutated.
- **Authority is the arming session, enforced producer-side.** Main's bridge
  reads the target row's committed arming-session identity before appending the
  cancel event: the caller's resolved session must equal it, or the request
  carries an explicit, audited operator override (`--force`, stamped into the
  event payload as the acting identity). A mismatch, an absent row, or an
  already-terminal row all return one uniform not-cancellable refusal — the
  cancel path is not an existence oracle. Omitted or malformed identity data
  grants no authority.
- **The fold stays owner-blind.** Enforcement lives entirely at the producer;
  the fold keeps its status-guarded compare-and-set (`waiting → cancelled`).
  Every cancel event in the log was authorized at append time by the single
  writer, historical tokenless cancel events replay identically, and re-fold
  determinism needs no legacy branch.
- **Cancel-vs-fire resolves at the event order, and fire must be fenced.** The
  await worker's follow-up fire is valid only if the row is durably `waiting`
  within the transaction that records the fire; a cancel that folds first
  suppresses the fire, a fire that folds first makes a later cancel an
  idempotent no-op. Re-cancelling a cancelled row is a no-op success.
- **`armed` means lifecycle truth.** The armed state latches on arm regardless
  of `--no-armed-line`; the flag governs only whether the initial armed line is
  printed, and the printed line's shape is unchanged. Consequences accepted as
  fixes: `--require-transition` edge suppression works under the flag, the JSON
  envelope's `armed` reports truthfully, the reconnect-blip swallow and progress
  logging engage exactly as they do without the flag.

## Consequences

Amends ADR 0054: its abstract cancel-variant line now resolves to this owner
fencing. The await skill doc gains the cancel verb and a consolidated armed-line
description. The previously mooted durable-await notify mode is not built —
native Monitors cover that need; nothing in-repo referenced it. The combined
`--no-armed-line` + `--require-transition` regression test is the acceptance
gate for the latch change.
