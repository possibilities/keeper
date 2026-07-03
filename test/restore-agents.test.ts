/**
 * restore-agents shim tests. The crash-restore engine moved to `src/tabs-core.ts`
 * behind `keeper tabs` (see `test/tabs.test.ts`); `scripts/restore-agents.ts` is
 * now a thin deprecation shim that maps the legacy flag surface to a `keeper tabs`
 * argv and delegates in-process. These tests pin the pure flag mapping — the ONE
 * behavior the shim still owns until the delegation task deletes it.
 */

import { expect, test } from "bun:test";
import { mapLegacyArgs } from "../scripts/restore-agents";

test("maps the setup-tmux spawn (--apply --session X --last-generation) to keeper tabs restore", () => {
  // The load-bearing byte-compat case: setup-tmux's existing spawn must keep
  // working. --last-generation IS the new default bounded selection (no flag);
  // --apply gains --allow-empty to preserve the old exit-0-on-zero behavior.
  expect(
    mapLegacyArgs(["--apply", "--session", "work", "--last-generation"]),
  ).toEqual(["restore", "--apply", "--allow-empty", "--session", "work"]);
});

test("bare restore (dry-run) maps to keeper tabs restore with no --apply", () => {
  expect(mapLegacyArgs([])).toEqual(["restore"]);
  expect(mapLegacyArgs(["--session", "scratch"])).toEqual([
    "restore",
    "--session",
    "scratch",
  ]);
});

test("--force and --db pass through to the restore mapping", () => {
  expect(mapLegacyArgs(["--apply", "--force", "--db", "/x/keeper.db"])).toEqual(
    ["restore", "--apply", "--allow-empty", "--force", "--db", "/x/keeper.db"],
  );
});

test("--snapshot-current maps to keeper tabs dump --include-managed (preserving full-set membership)", () => {
  // Old --snapshot-current dumped the FULL live set (no plan_verb filter), so the
  // shim adds --include-managed to keep that membership.
  expect(mapLegacyArgs(["--snapshot-current"])).toEqual([
    "dump",
    "--include-managed",
  ]);
  expect(
    mapLegacyArgs(["--snapshot-current", "--session", "work", "--db", "/x.db"]),
  ).toEqual([
    "dump",
    "--include-managed",
    "--session",
    "work",
    "--db",
    "/x.db",
  ]);
});

test("--help maps to keeper tabs restore --help", () => {
  expect(mapLegacyArgs(["--help"])).toEqual(["restore", "--help"]);
});

test("an unrecognized legacy flag throws (only the legacy set is mapped)", () => {
  expect(() => mapLegacyArgs(["--bogus"])).toThrow();
});
