# 0054 — Terminal repairs, the dead-writer dirt sweep, and durable awaits

## Status

Accepted (provisional number; fan-in renumber per ADR 0020/0022 applies). Extends
[ADR 0049](0049-shared-checkout-jam-promotion-and-repair-retry.md) (repair retry discipline) and
[ADR 0053](0053-lane-dirt-backup-and-bounded-teardown.md) (the lane dirt spool); adopts the
durable-awaits design proposal as the awaits specification.

## Context

A repair session deferred its fix and simply stopped — no terminal verdict, so the page-once
machinery never engaged; its diagnosis lived only in the dead session's transcript while the
sticky said `shared-base-broken:<fingerprint>`; and the staged state that had blocked it belonged
to sessions that were already dead, jamming the shared checkout for ninety minutes until an
operator backed it up and reset by hand. Separately, daemon reloads require hand-run `launchctl`
incantations, and `keeper await` waits are in-process latches that die with the client, losing
their follow-up actions without a trace.

## Decision

- **A repair must end terminal.** The repair escalation sweep treats a repair session that is
  stopped or dead without a recorded terminal outcome, past an injectable grace anchored on the
  existing dispatch marker, as DECLINED: the human is paged once and the row re-arms only via the
  retry wire. The existing died/declined verdict split is unchanged; the grace gate lives in the
  repair sweep producer, never in the shared escalation classifier, so unblock/deconflict
  semantics are untouched. No new column.
- **Diagnosis by reference, digest on the row.** The SHARED_BASE_BROKEN escalation carries a
  bounded failing-tests digest (the bounded-join shape used by the merge gate) sourced from the
  baseline red leaf, plus that leaf's derived key — the already-durable baseline store is the
  diagnosis leaf; no new writer, no new retention class, no schema change. A rotated leaf leaves
  the digest on the row as the surviving summary.
- **The dead-writer sweep cleans a shared checkout only on proof.** Writers of shared-checkout
  dirt are enumerable as the sessions whose recorded cwd is that checkout. A producer sweep may
  back the dirt up to the lane dirt spool (a backup-then-CLEAN sibling of the lane primitive —
  the checkout is kept) and reset+clean it (never ignored files) ONLY when: no cwd-matched
  session is working, every one is grace-stale, liveness probes (pid + start-time) find no live
  writer, and no merge is in progress. Anything less pages once. The sweep never mints or clears
  the dirty row itself — a successful clean lets the existing tracker's positive-evidence
  level-clear observe the clean tree next cycle. A failed backup never cleans.
- **`keeper daemon restart` is a CLI verb, not an RPC.** It kickstarts the LaunchAgent from its
  existing definition and polls the boot-status readiness signal (socket answering AND caught up)
  with a bounded, jittered wait — surfacing a throttled respawn distinctly from a slow boot, and
  documenting that plist changes need bootstrap, not kickstart. It never touches the DB.
- **Durable awaits follow the handoff template exactly**: an `awaits` deterministic-replayed
  projection (present in every rewind reset), ONE new mutating RPC — the eighth — whose payload
  also carries the cancel variant, a synthetic event and null-safe fold, and a leased await-worker
  copying the handoff worker's claim/ack/breaker discipline. Semantics are at-least-once intent
  with idempotent follow-up: the lease covers only the firing phase, a waiting row is unclaimed
  and may wait forever by design (timeout optional). Only server-evaluable condition kinds are
  accepted — session-local conditions are rejected loud at the trust boundary. The follow-up
  always launches as a fresh session via the worker's launch transport; the arming session is
  expected to be gone. The display-only `finalize_pending` count joins the needs-human envelope's
  never-jam-counted members.

## Consequences

A silent repair now pages within one grace instead of never; its digest makes the sticky
actionable without transcript archaeology. The dead-writer sweep converts the dirty/desync
paging jams into self-healing states while keeping every ambiguous case human-owned. The RPC
allowlist grows to eight and the guardrail docs move in the same change. Durable awaits add one
schema step (renumbered at merge per ADR 0020) and one worker; in-process awaits remain for
session-scoped conditions the durable form rejects.
