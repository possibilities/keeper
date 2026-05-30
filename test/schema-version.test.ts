/**
 * Cross-language guard: keeper-py must understand the schema the daemon writes.
 *
 * keeper bumps `SCHEMA_VERSION` (src/db.ts) on every additive ALTER. The
 * Python reader in `keeper/api.py` — the one `jobctl commit-work` calls to
 * compute session-attributed dirty files — gates loud on any version outside
 * its `SUPPORTED_SCHEMA_VERSIONS` frozenset and fails EVERY `commit-work` on
 * the host until the set is updated. The two version sources live in different
 * languages and have drifted twice (fn-643→v37, fn-645→v38), so prose in
 * CLAUDE.md alone is not enough — this assertion fails the build the moment
 * the daemon's version outruns the reader's whitelist.
 *
 * The whitelist is a hard set (an unrecognized version raises, even one keeper
 * never reads from), but a forward-only schema can only grow, so asserting the
 * frozenset's max covers `SCHEMA_VERSION` is the necessary-and-sufficient
 * guard: it catches the "bumped db.ts, forgot api.py" miss without forbidding
 * keeper-py from dropping ancient floor versions it no longer supports.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_VERSION } from "../src/db";

const API_PY = join(import.meta.dir, "..", "keeper", "api.py");

/** Parse `SUPPORTED_SCHEMA_VERSIONS = frozenset({31, 32, ...})` from api.py. */
function readSupportedVersions(): number[] {
  const src = readFileSync(API_PY, "utf8");
  const match = src.match(
    /SUPPORTED_SCHEMA_VERSIONS\s*=\s*frozenset\(\{([^}]*)\}\)/,
  );
  if (!match) {
    throw new Error(
      `could not find SUPPORTED_SCHEMA_VERSIONS frozenset in ${API_PY}`,
    );
  }
  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = Number.parseInt(s, 10);
      if (!Number.isInteger(n)) {
        throw new Error(`non-integer schema version in api.py frozenset: ${s}`);
      }
      return n;
    });
}

test("keeper-py SUPPORTED_SCHEMA_VERSIONS covers the daemon SCHEMA_VERSION", () => {
  const supported = readSupportedVersions();
  expect(supported.length).toBeGreaterThan(0);
  const max = Math.max(...supported);
  // If this fails: you bumped SCHEMA_VERSION in src/db.ts but did not add the
  // new version to keeper/api.py's SUPPORTED_SCHEMA_VERSIONS frozenset. Add it
  // (and a matching doc-comment line) in the same change — see CLAUDE.md
  // "Migrations are forward-only".
  expect(max).toBeGreaterThanOrEqual(SCHEMA_VERSION);
});
