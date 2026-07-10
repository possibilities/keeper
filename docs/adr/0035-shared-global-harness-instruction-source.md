# 35. One keeper-owned source materializes every harness's global instructions

## Status

Accepted.

## Context

`keeper agent` is the sole launcher of every harness (`claude`, `codex`, `pi`), yet the
shared global-instruction content reached them through three unrelated ownership paths.
Claude's leaf (`~/.claude/CLAUDE.md`) was already keeper-owned and self-healing via the
launch guard's `CANONICAL_STOW_LEAVES` re-assertion. Codex's leaf was owned by a foreign
stow package, free to drift back the moment it re-stows. Pi received no global content at
all — its guard never asserted a leaf for it.

Pi complicates the placement because it exposes two unrelated global-instruction channels
at different altitudes: `SYSTEM.md` **replaces** pi's entire built-in system prompt (a
brain-wipe if used for a shared preamble), while `AGENTS.md`/`CLAUDE.md` are always-on
**context files** concatenated alongside pi's own prompt — the same altitude codex and
claude read their global doc at. Only the context-file channel is a safe target.

Pi's profile-link pass also has an ordering trap: it skips materializing a profile leaf
(`~/.pi-profiles/<name>/AGENTS.md`) whenever the canonical path
(`~/.pi/agent/AGENTS.md`) doesn't yet exist, so the canonical leaf must land before the
profile pass runs or every named-profile link is silently skipped.

Finally, "AGENTS.md" already names two unrelated things in this repo: the checked-in
symlink `AGENTS.md -> CLAUDE.md` that every keeper-family repo carries as its own
repo-root convention, and the new per-harness leaves this ADR introduces at each
harness's global config path. The two live at different scopes (repo-root vs.
harness-home) and have opposite maintenance rules, so the terms need to stay distinct in
conversation and in code comments.

## Decision

- **One keeper-owned source, `system/shared/AGENTS.md`.** Not nested under
  `system/claude/`, which is already a symlink to `CLAUDE.md` — reusing it would produce
  a symlink-to-symlink chain and bury a cross-harness doc inside claude's package. A
  harness-neutral `shared/` home states the ownership honestly.
- **The launch guard's leaf table generalizes from claude-only to per-harness.** Each
  entry is `{source, linkPath, onDivergence}`, re-asserted on every launch: claude's
  `~/.claude/CLAUDE.md`, codex's `$CODEX_HOME/AGENTS.md` (resolved through keeper's own
  `CODEX_HOME` resolver, never forced), pi's canonical `~/.pi/agent/AGENTS.md`, and each
  `~/.pi-profiles/<name>/AGENTS.md`. The canonical pi leaf materializes before the
  profile-link pass to close the ordering trap; `SYSTEM.md` is removed from pi's
  shared-path list so it can never be treated as a leaf.
- **Divergence policy splits by who else writes the leaf.** Claude's tool itself rewrites
  `CLAUDE.md` via an atomic-rename settings clobber, so an identical-content repair is
  safe and a divergent one is a genuine conflict worth a hard error — claude keeps its
  existing hard-error-on-divergence behavior. Codex and pi never write their own
  `AGENTS.md`, so any divergence there is always a deliberate human edit: those leaves
  warn and respect the divergent file rather than aborting the launch.
- **Codex's arthack-owned source is deleted, not forwarded.** A thin forwarder stub would
  itself drift or be re-stowed; deleting the source is what stops stow from re-owning the
  path. The next post-deploy `keeper agent codex` launch sees the resulting broken/foreign
  symlink and self-heals it to the keeper leaf — cutover needs no manual migration step.
- **Terminology stays disambiguated.** "AGENTS.md" the repo-convention symlink
  (`AGENTS.md -> CLAUDE.md`, edited in place, never `rm`+recreated — CLAUDE.md rule) and
  "AGENTS.md" the shared-source leaf (a harness's global-config-path symlink into
  `system/shared/AGENTS.md`, healed by deleting the *source*, never the leaf) name two
  different things at two different scopes; neither is a special case of the other.

## Consequences

- All three harnesses read one shared global-instruction body, self-healing on every
  launch the same way claude's leaf already did — codex and pi close the gap without
  gaining a claude-style hard-error, since neither harness ever writes its own leaf.
- A future divergence between codex's and pi's needed content forces a fork of the single
  source (or a move to a per-harness escape hatch — pi's `APPEND_SYSTEM.md`, codex's
  `AGENTS.override.md`) — an accepted boundary of the one-source-fits-all model, not a
  defect to design around now.
- Deleting arthack's codex source is a one-way door for that repo: any content it carried
  beyond the shared preamble must move into `system/shared/AGENTS.md` first, or it is
  lost on cutover.
