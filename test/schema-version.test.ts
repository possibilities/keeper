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
 * The whitelist is a hard set: an unrecognized version raises, even one keeper
 * never reads from. So the guard is MEMBERSHIP, not max — the live
 * `SCHEMA_VERSION` must appear IN the frozenset, because that exact version is
 * what keeper-py will be handed on the host. (fn-762.3 tightened this from a
 * `max >= SCHEMA_VERSION` check, which a non-contiguous set could satisfy
 * without actually listing the current version.) keeper-py stays free to drop
 * ancient floor versions it no longer supports — membership only pins the
 * current one.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_STEPS, SCHEMA_VERSION } from "../src/db";

const API_PY = join(import.meta.dir, "..", "keeper", "api.py");

// keeper-py's SUPPORTED_SCHEMA_VERSIONS floor: a contract of keeper-py's
// reader (it stays free to drop ancient versions it no longer supports), not
// a property of the ladder itself. Pinned here as a named const so a future
// floor raise in keeper/api.py is a deliberate two-sided edit — bump this
// alongside it, don't let the derivability test silently start passing on a
// stale floor.
const PYTHON_SUPPORTED_FLOOR = 31;

/** Parse `SUPPORTED_SCHEMA_VERSIONS = frozenset({31, 32, ...})` from api.py.
 *
 * The frozenset literal may span multiple lines (Black reflowed it once the
 * set crossed the line-length limit), so the regex is whitespace-tolerant
 * across newlines via the `s` flag — matching the `{...}` body even when it
 * is broken across lines. */
function readSupportedVersions(): number[] {
  const src = readFileSync(API_PY, "utf8");
  const match = src.match(
    /SUPPORTED_SCHEMA_VERSIONS\s*=\s*frozenset\(\s*\{([^}]*)\}\s*\)/s,
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

test("keeper-py SUPPORTED_SCHEMA_VERSIONS contains the daemon SCHEMA_VERSION", () => {
  const supported = readSupportedVersions();
  expect(supported.length).toBeGreaterThan(0);
  // If this fails: you bumped SCHEMA_VERSION in src/db.ts but did not add the
  // new version to keeper/api.py's SUPPORTED_SCHEMA_VERSIONS frozenset. Add it
  // (and a matching doc-comment line) in the same change — see CLAUDE.md
  // "Migrations are forward-only". Membership (not max): keeper-py is handed
  // this exact version on the host, and its whitelist is a hard set.
  expect(supported).toContain(SCHEMA_VERSION);
});

test("keeper-py SUPPORTED_SCHEMA_VERSIONS is exactly the ladder's versions at/above the Python floor", () => {
  // Sibling to the membership test above: that one pins the CURRENT version
  // stays listed; this one pins the WHOLE set is derivable from the ladder,
  // so api.py's frozenset can never silently drift from SCHEMA_STEPS (add a
  // ladder entry without touching api.py, or vice versa) without failing
  // here first. api.py itself stays hand-written — this test is what retires
  // it as a silent second surface.
  const supported = new Set(readSupportedVersions());
  const derived = new Set(
    SCHEMA_STEPS.map((s) => s.version).filter(
      (v) => v >= PYTHON_SUPPORTED_FLOOR,
    ),
  );
  expect(supported).toEqual(derived);
});
