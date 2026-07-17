# 0078 — Cooperative claim release

Status: Accepted (provisional number; renumber at fan-in). Extends
[ADR 0063](0063-commit-work-explicit-adoption-and-atomic-publication.md) and
[ADR 0068](0068-commit-work-vacated-claims-and-honest-drift.md); amends
neither's core — the read-side-only stance holds.

## Context

A live foreign Exclusive file claim gives a blocked peer exactly two outs:
wait for the claimant to land, or make the claimant terminal. Two live
sessions contending over the same paths therefore rationally converge on one
killing the other — observed in production, resolved only by killing a
process so its claims vacated. The system needs a cooperative third out that
never touches the peer's process.

Distributed-lock practice pins the constraints: the authoritative outcome of
a release request must not live with the requester (a merely-slow holder
would split-brain an impatient one); partial release is safe only when the
holder's in-flight work no longer depends on the released paths — which only
the holder can judge; and expiry-driven forfeiture requires fencing a
non-consenting holder, the risky half of the protocol.

## Decision

- **The claimant's durable release record is the sole authority.** A new
  claimant-side verb voluntarily releases NAMED paths: it writes one
  size-bounded, identity-proven release record (sole writer: the releasing
  session, with the same pid+start-time ancestry proof commit-work's
  authority check uses). The commit-work classifier reads a valid record as
  a voluntary terminal-witness for exactly those paths — a live sibling of
  the vacated-claim gone-witness, layered per-path over the session-granular
  classification. No new RPC surface, no schema step, no daemon write.
- **Release is self-fencing.** The releasing session's own subsequent
  commit-work subtracts its released paths from its owned set — a consenting
  holder is fenced by its own record, so it cannot later win a publication
  race on a path it gave away.
- **The notice is advisory, never load-bearing.** The refusal envelope's
  typed request-release pointer instructs the blocked peer to send a
  bounded request over the existing bus rail (send-only — it never joins the
  registry) naming the contended paths. Delivery and acknowledgment are
  best-effort: an inbox-less, busy, or dead claimant cannot deadlock the
  requester.
- **Grace-timeout escalation rides the existing block-escalation ladder.**
  After the grace window the requester re-runs commit-work; a still-live
  conflict is stamped BLOCKED with the request evidence, and the existing
  escalation ladder — resolver, then page-once — carries it to the operator.
  No new paging machinery, no daemon sweep.
- **Declines are durable and honored.** A recorded decline is a terminal
  answer for that request; the requester backs off under an attempt budget
  rather than re-asking in a loop.
- **Auto-forfeiture is deliberately out.** Expiry never retires a live
  claimant's claim in this design; that half — forfeiture plus fencing a
  non-consenting holder — is a separate future decision with its own record.
  Never-signal-a-live-peer stays structural by absence (no kill rail is
  exposed; the terminate verb refuses working sessions) and is stated where
  agents read commit-work guidance.
