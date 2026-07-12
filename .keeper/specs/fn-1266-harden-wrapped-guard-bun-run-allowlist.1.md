## Description

Finding F1 (merges F3, F4). Evidence: `plugins/keeper/plugin/hooks/wrapped-guard.ts:524`
— `if (sub === "test" || sub === "run") return null;` clears the Bash allowlist for
any `bun run <arg>`. Combined with `:691` (a Write resolving outside every tracked
tree is allowed), a marked wrapped worker can (1) Write `/scratch/gen.ts`
[out-of-tree, allowed], (2) `bun run /scratch/gen.ts` [allowed via :524], (3) have
gen.ts `fs.writeFileSync` into `src/` — all three clear the guard, defeating the
total-edit-denial guarantee. This is the exact inline-code-execution class the guard
already denies for node/python/deno (INTERPRETER_EXECUTABLES) and for `bun -e/--eval/-p`.

Restrict the `bun run` branch so it can no longer launch an arbitrary writable file:
permit the test-runner surface (`bun test`, `bun run <allowlisted-script-name>`) while
denying a bare file-path arg (and/or a `bun test`/`bun run` target pointing outside the
repo's own test tree). Keep the deny direction as the safe fallthrough, consistent with
the existing positive-allowlist posture.

Files:
- plugins/keeper/plugin/hooks/wrapped-guard.ts (the `bun` branch in classifyWrappedExecutable)
- test/wrapped-guard.test.ts (allow/deny table + compound-sequence assertion)
- docs/adr/0050-wrapped-delegation-guard.md (update Consequences to reflect the closed gap; if any residual remains, name it explicitly)

## Acceptance

- [ ] `bun run <arbitrary-file-path>` is denied for a marked wrapped worker; the permitted test-runner invocation still clears.
- [ ] test/wrapped-guard.test.ts asserts the bun-run decision both ways (permitted case allowed, arbitrary-path case denied).
- [ ] A test asserts the compound out-of-tree-Write + `bun run <that file>` sequence is contained.
- [ ] ADR 0050 Consequences reflect the closed hole (or name any bounded residual).

## Done summary

## Evidence
