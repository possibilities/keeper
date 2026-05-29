## Description

**Size:** S
**Files:** README.md, CLAUDE.md (AGENTS.md is a symlink — edit CLAUDE.md in place)

Flip all developer-facing docs from the `bun scripts/<name>.ts`
invocation model to `keeper <subcommand>`, now that the CLI exists.
Pure documentation — no code.

### Approach

1. **README.md**: in the "Example clients" section (~341-554), replace
   every `bun scripts/board.ts|git.ts|usage.ts|autopilot.ts` (prose +
   `sh` fences at ~464-466/492-493/518-520/539-540) with `keeper
   board|git|usage|autopilot`; update the intro paragraph (~348-364)
   and the two "three example clients" mentions (~141-142, ~341-344);
   revise ~513 ("SIGINT calls the live-shell's `dispose()`") to describe
   shutdown without leaking the internal module name; reconcile the
   stale `--live` reference (no main-level `--live` flag exists — the
   scripts pass `enabled:true` unconditionally and the TTY gate decides).
   Scan ~90-145 for any "four scripts"-style enumeration in Architecture.
2. **CLAUDE.md**: swap identifier mentions at ~16-17 (clients), ~123
   (`scripts/usage.ts`→`keeper usage`), ~216 (`scripts/board.ts`→`keeper
   board`); optionally add a one-liner pointing at `cli/keeper.ts`. Do
   NOT edit the event-sourcing/worker-contract sections (server-side,
   untouched). Edit CLAUDE.md directly — never `rm`+recreate the
   AGENTS.md symlink.

### Investigation targets

**Required** (read before coding):
- README.md ~141-145, ~341-554 (Example clients), ~90-145 (Architecture), ~513 (SIGINT/live-shell mention), ~348-364 (--live reference)
- CLAUDE.md ~16-17, ~123, ~216

### Risks

- Don't over-edit: only the client/invocation surface changes; server-side invariants stay verbatim.

### Test notes

No code. Grep README + CLAUDE.md for residual `bun scripts/` and
`live-shell` references after editing; confirm none remain in the
client-facing prose.

## Acceptance

- [ ] No `bun scripts/<name>.ts` invocation remains in README's client-facing prose/fences; all flipped to `keeper <subcommand>`.
- [ ] The internal `live-shell` module name no longer leaks into README prose; the stale `--live` reference is reconciled.
- [ ] CLAUDE.md identifier mentions point at the `keeper` subcommands; AGENTS.md symlink intact; server-side sections untouched.

## Done summary

## Evidence
