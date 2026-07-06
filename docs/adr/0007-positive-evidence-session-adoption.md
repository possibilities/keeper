# Positive-evidence harness-session adoption

## Status

Accepted

## Context

Every non-claude tracking mechanism keys on a `jobs` row, and that row exists only
when the `keeper agent` launcher minted a birth record. A hand-started hermes or
codex session therefore stayed invisible: no birth record, no job, no board pill,
no restore. The two harnesses fail this differently. hermes is a PUSH modality —
its persistently-seeded shell shim already fires for a hand-started session, so the
only missing piece is identity when `KEEPER_JOB_ID` is unset. codex is a PULL
modality — it leaves rollout artifacts on disk with no keeper env and no tmux pane
(coordless by design), so adoption must be discovered from the artifact. pi is
neither: its extension is ephemeral per launch and leaves no durable artifact.

The hazard is false adoption. A rollout with an unknown owner must not be guessed
into a keeper job, and a launcher-owned session must never be re-adopted. A
tempting shortcut — deriving "adopted" from a harness+id-equality signature rather
than storing it — false-positives: a launcher-started pi job pins the native id as
BOTH its job id and its resume target, so the signature matches every launched pi.

## Decision

Adoption is an EXPLICIT, harness-agnostic marker (`jobs.adopted`), folded set-once
off the `SessionStart` event and never derived. The claude hook and every launcher
birth bind it null, so a launcher-owned session is never marked.

- **hermes (push):** the shim self-seeds its identity from the native session id
  when — and only when — `KEEPER_JOB_ID` is absent, minting an adopted job with
  full pane coordinates that restores like a launched one. On by default on the
  human's own machine, with a local fail-open opt-out.
- **codex (pull):** a knob-gated (default OFF) scan adopts ONLY a rollout that is
  the sole unambiguous candidate for its cwd AND whose originator is strictly
  absent/empty ("keeper never owned this"). A present-but-unmatched originator, or
  an ambiguous cwd, is skipped — no stale-originator recovery. The adopted job is
  coordless and timestamped from the rollout's own session-start (event time,
  never mtime or fold-time wall-clock).
- **pi:** adoption is deliberately not built — revisit only if pi grows a
  persistent install and a durable artifact.

The native id is the job id, so a re-mint folds as a resume without clobbering the
marker, and discovery never adopts a launcher-owned session. Restore reports an
adopted coordless session it cannot auto-restore as a surfaced count, never a
silent drop.

## Consequences

- Hand-started hermes and codex sessions become tracked, adopted-marked jobs; the
  board and restore can treat an adopted session distinctly from a launched one.
- The codex path stays refuse-to-guess even while running unattended: gated OFF,
  positive-evidence only, and blind to ambiguous or already-owned rollouts.
- A coordless adopted session (codex by design, or a hermes self-seed keeper never
  resolved coords for) is surfaced by the retrospective restore deriver as a
  distinct count; the topology-anchored path, being pane-based, carries that count
  only through its killed-cohort fallback.
- The marker is a stored column, not a derived signature, so a launcher-started pi
  job can never be mistaken for an adopted one.
