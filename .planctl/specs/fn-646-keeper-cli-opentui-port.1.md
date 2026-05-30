## Description

**Size:** M
**Files:** package.json, tsconfig.json, biome.json, cli/keeper.ts (new), bun.lock

Lay the foundation the rest of the epic builds on: add the OpenTUI
dependency, create the typed `cli/` tree, wire the `bin`, widen the
typecheck/lint nets, and build the dispatcher skeleton. No renderer
work and no TUI cutover here — those land in `.2`+. The dispatcher can
route to stub `main(argv)` functions (or dynamically import the
not-yet-moved mains) so this task is independently verifiable.

### Approach

1. `bun add @opentui/core` — confirm the pre-built native binary
   resolves on this platform; confirm it does NOT enter
   `plugin/hooks/events-writer.ts`'s import graph (hook stays
   `bun:sqlite` + local only).
2. Create `cli/keeper.ts` with `#!/usr/bin/env bun`: read
   `Bun.argv.slice(2)`, match the first token against
   `{board,git,usage,autopilot}`, and delegate the remaining argv to
   that subcommand's `main(argv: string[])`. Define the top-level
   contracts the gap analysis flagged: bare `keeper` and unknown
   subcommand print a usage block and exit non-zero; `keeper <sub>
   --help` reaches the subcommand's own HELP; `keeper --version`
   surfaces `package.json` version.
3. `package.json`: add `"bin": {"keeper": "cli/keeper.ts"}`.
4. `tsconfig.json`: widen `include` to add `cli` (keep `src`, `test`).
   `package.json` lint script + biome scope: extend to cover `cli`.
5. Decide and document the directory shape for `.3`-`.5`: the four
   mains relocate to `cli/board.ts` / `cli/git.ts` / `cli/usage.ts` /
   `cli/autopilot.ts`, each exporting `main(argv)`; `cli/keeper.ts`
   imports them. (Wiring the actual moved mains happens in their own
   cutover tasks; this task may import-stub them.)

### Investigation targets

**Required** (read before coding):
- package.json — no `bin` today; scripts run via `bun run scripts/<x>.ts`
- tsconfig.json — `include: ["src","test"]`, `module: esnext`, `moduleResolution: bundler`, strict, path alias `@/*`→`./src/*`
- biome.json + the `lint` script (`biome check --no-errors-on-unmatched src test`)
- scripts/git.ts:~313 — example `parseArgs({args: Bun.argv.slice(2)})` + `--help`/HELP shape the dispatcher must accommodate

**Optional:**
- plugin/hooks/events-writer.ts — confirm the dep-isolation boundary

### Risks

- Native-binary install on CI (musl vs glibc) may need a Zig fallback — verify keeper's CI platform is a supported pre-built target.
- Widening tsconfig `include` to `cli` only (not `scripts`) avoids dragging the still-untyped one-shots into strict typecheck.

### Test notes

Add a small `test/keeper-cli.test.ts` exercising dispatch: known
subcommand routes to the right (stubbed) main with the residual argv;
unknown subcommand + bare invocation produce usage + non-zero exit;
`--version` prints the version. Assert via the dispatcher's argv
parsing, not by spawning a renderer.

## Acceptance

- [ ] `@opentui/core` installed; verified absent from the hook's import graph.
- [ ] `cli/keeper.ts` exists with shebang, routes the four subcommands, and handles bare/unknown/`--help`/`--version`.
- [ ] `package.json` has the `keeper` `bin`; tsconfig + lint cover `cli`.
- [ ] Dispatch test passes; `bun run typecheck` + `bun run lint` green on `cli`.

## Done summary
Added @opentui/core dep (hook import graph verified clean), created cli/ tree with keeper.ts dispatcher + four stub subcommand mains forwarding to scripts/, wired keeper bin, widened lint+typecheck to cover cli/, and added 15-case dispatch test.
## Evidence
