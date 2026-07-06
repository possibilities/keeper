## Description

**Size:** S
**Files:** cli/usage.ts, cli/keeper.ts, cli/descriptor.ts, test/usage.test.ts

### Approach

Add a `scrape` subverb to `keeper usage`: a leading-token pre-pass ahead of
the existing view parseArgs (mirroring the established multi-subverb split
pattern) routes `keeper usage scrape ...` to the merged scrape CLI's main
via a LAZY dynamic import inside the scrape arm only — bare `keeper usage`,
its snapshot modes, and `keeper usage --help` are byte-unchanged, and the
usage view's cold-start import set gains nothing. The subverb forwards argv
verbatim (`--target/--profile/--command/--rows/--cols`), prints the same
schema-1 JSON contract on stdout, and mirrors the entry's exit-code contract.
Register the new leaf in the CLI descriptor native command tree so the
descriptor-vs-reality conformance gate stays green, and add the subverb line
to the top-level usage text and the usage leaf help.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/usage.ts:785-797 — the parseArgs site the pre-pass lands ahead of; :1-33 header to extend
- cli/keeper.ts:28 (SUBCOMMANDS), :89 (USAGE entry), :584 (lazy handler map)
- cli/descriptor.ts — the native command tree shape as landed; register the scrape leaf per its conventions
- src/agent/dispatch.ts splitSubcommand + cli/agent.ts:44-52 — the subverb split + lazy-import discipline to mirror

**Optional** (reference as needed):
- cli/autopilot.ts:724-854 — the canonical multi-subverb main shape

### Risks

- The descriptor tree's final shape is owned by the upstream CLI-convergence epic this epic is sequenced behind — re-read it at execution time rather than assuming this spec's snapshot.

### Test notes

Unit-assert the pre-pass routing (scrape token → delegated argv verbatim;
no token → view path; --help handling both levels); descriptor conformance
suite green.

## Acceptance

- [ ] The scrape subverb delegates to the merged scrape CLI in-process with argv forwarded verbatim and the JSON contract on stdout
- [ ] Bare usage view, snapshot modes, and both help surfaces behave exactly as before, with the subverb listed in help text
- [ ] The new leaf is declared in the CLI descriptor tree and the descriptor conformance gate passes
- [ ] Full fast suite green

## Done summary

## Evidence
