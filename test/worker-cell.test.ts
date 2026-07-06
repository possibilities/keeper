/**
 * Unit contract for the shared launcher-owned worker-cell resolution seam
 * (`src/worker-cell.ts`) — the ONE decision both the autopilot producer and the
 * manual dispatch CLI route through. Covers every union variant, the injected
 * filesystem-probe CADENCE (a lazy shadow probe reached only for a present cell),
 * the precedence (out-of-matrix → missing → shadowed), and the no-prose contract
 * (the helper returns machine kinds only; each caller owns its operator text).
 *
 * Pure in-process — no daemon, no real plugin config. `composeWorkerCellDir`
 * reaches the compiled-in subagents matrix (a memoized embed parse, no I/O);
 * `resolveWorkerCell` takes injected probes so no test touches the disk.
 */

import { expect, test } from "bun:test";
import {
  composeWorkerCellDir,
  resolveWorkerCell,
  type WorkerCellCompose,
  type WorkerCellResult,
} from "../src/worker-cell";

// A probe pair that FAILS the test if invoked — proves a code path never reaches
// the filesystem. `dirExists`/`probeShadow` throw so an accidental call surfaces.
const neverProbe = {
  dirExists: (_p: string): boolean => {
    throw new Error("dirExists must not be called on this path");
  },
  probeShadow: (): string | null => {
    throw new Error("probeShadow must not be called on this path");
  },
};

// ---------------------------------------------------------------------------
// composeWorkerCellDir — the pure try/catch wrapper around workerCellPluginDir
// ---------------------------------------------------------------------------

test("composeWorkerCellDir: an in-matrix (model, tier) resolves the absolute cell dir, no reject", () => {
  const c = composeWorkerCellDir("opus", "max");
  expect(c.reject).toBeUndefined();
  expect(c.pluginDir).not.toBeNull();
  // Absolute path under keeper's generated workers tree, cwd-independent.
  expect(c.pluginDir?.startsWith("/")).toBe(true);
  expect(c.pluginDir).toContain("plugins/plan/workers/opus-max");
});

test("composeWorkerCellDir: a null EITHER axis is legitimately cell-less (pluginDir null, no reject)", () => {
  expect(composeWorkerCellDir(null, "max")).toEqual({ pluginDir: null });
  expect(composeWorkerCellDir("opus", null)).toEqual({ pluginDir: null });
  expect(composeWorkerCellDir(null, null)).toEqual({ pluginDir: null });
});

test("composeWorkerCellDir: an out-of-matrix pair is carried as a reject (never a throw)", () => {
  const c = composeWorkerCellDir("opus", "ludicrous");
  expect(c.pluginDir).toBeNull();
  expect(typeof c.reject).toBe("string");
  expect(c.reject).not.toBe("");
});

// ---------------------------------------------------------------------------
// resolveWorkerCell — the shared filesystem-probe precedence over a compose
// ---------------------------------------------------------------------------

test("resolveWorkerCell: a present cell with no shadow → ok, pluginDir threaded", () => {
  const cell = resolveWorkerCell(
    { pluginDir: "/abs/keeper/plugins/plan/workers/opus-max" },
    { dirExists: () => true, probeShadow: () => null },
  );
  expect(cell).toEqual({
    ok: true,
    pluginDir: "/abs/keeper/plugins/plan/workers/opus-max",
  });
});

test("resolveWorkerCell: a cell-less compose → ok with null pluginDir, probes never touched", () => {
  const cell = resolveWorkerCell({ pluginDir: null }, neverProbe);
  expect(cell).toEqual({ ok: true, pluginDir: null });
});

test("resolveWorkerCell: a reject compose → out-of-matrix, probes never touched (invalid wins first)", () => {
  const cell = resolveWorkerCell(
    { pluginDir: null, reject: "no worker agent for (opus, ludicrous)" },
    neverProbe,
  );
  expect(cell).toEqual({
    ok: false,
    kind: "out-of-matrix",
    message: "no worker agent for (opus, ludicrous)",
  });
});

test("resolveWorkerCell: an absent cell manifest → missing, BEFORE the shadow probe", () => {
  const cell = resolveWorkerCell(
    { pluginDir: "/abs/cell" },
    {
      dirExists: () => false,
      probeShadow: () => {
        throw new Error("shadow probe reached after a missing manifest");
      },
    },
  );
  expect(cell).toEqual({ ok: false, kind: "missing", pluginDir: "/abs/cell" });
});

test("resolveWorkerCell: a shadowing work plugin → shadowed, carrying both paths", () => {
  const cell = resolveWorkerCell(
    { pluginDir: "/abs/cell" },
    {
      dirExists: () => true,
      probeShadow: () => "/scan/arthack-work/plugin.json",
    },
  );
  expect(cell).toEqual({
    ok: false,
    kind: "shadowed",
    pluginDir: "/abs/cell",
    shadowManifest: "/scan/arthack-work/plugin.json",
  });
});

test("resolveWorkerCell: precedence — a reject outranks a missing manifest AND a shadow", () => {
  // reject + manifest-absent + shadow-present all true at once → out-of-matrix
  // (the probes are never consulted).
  const cell = resolveWorkerCell(
    { pluginDir: null, reject: "bad pair" },
    {
      dirExists: () => false,
      probeShadow: () => "/scan/shadow/plugin.json",
    },
  );
  expect(cell.ok).toBe(false);
  expect(cell).toMatchObject({ kind: "out-of-matrix", message: "bad pair" });
});

test("resolveWorkerCell: precedence — a missing manifest outranks a present shadow (shadow unreached)", () => {
  let shadowCalls = 0;
  const cell = resolveWorkerCell(
    { pluginDir: "/abs/cell" },
    {
      dirExists: () => false,
      probeShadow: () => {
        shadowCalls++;
        return "/scan/shadow/plugin.json";
      },
    },
  );
  expect(cell).toMatchObject({ kind: "missing" });
  expect(shadowCalls).toBe(0);
});

// ---------------------------------------------------------------------------
// Probe cadence — the shadow probe fires lazily; a memoized closure serves once
// ---------------------------------------------------------------------------

test("resolveWorkerCell: the shadow probe is reached ONLY for a present cell with a live manifest", () => {
  let shadowCalls = 0;
  const probeShadow = (): string | null => {
    shadowCalls++;
    return null;
  };
  // Cell-less and reject compose never reach the probe.
  resolveWorkerCell(
    { pluginDir: null },
    { dirExists: () => true, probeShadow },
  );
  resolveWorkerCell(
    { pluginDir: null, reject: "x" },
    { dirExists: () => true, probeShadow },
  );
  expect(shadowCalls).toBe(0);
  // A present cell with a live manifest reaches it exactly once.
  resolveWorkerCell(
    { pluginDir: "/abs/cell" },
    { dirExists: () => true, probeShadow },
  );
  expect(shadowCalls).toBe(1);
});

test("resolveWorkerCell: a memoized shadow closure (producer cadence) scans at most once across launches", () => {
  // The producer keeps ONE per-cycle memo and hands resolveWorkerCell a closure
  // that serves it — so N cell launches trigger AT MOST one on-disk scan. This
  // pins that split against a regression back to a readdir-per-launch.
  let scanCount = 0;
  let memo: string | null | undefined;
  const memoized = (): string | null => {
    if (memo === undefined) {
      scanCount++;
      memo = null; // one scan; clean
    }
    return memo;
  };
  const deps = { dirExists: () => true, probeShadow: memoized };
  for (let i = 0; i < 5; i++) {
    resolveWorkerCell({ pluginDir: `/abs/cell-${i}` }, deps);
  }
  expect(scanCount).toBe(1);
});

test("resolveWorkerCell: a fresh probe (dispatch cadence) scans on each call", () => {
  // The dispatch CLI hands the fresh default probe — it fires ONE worker, so a
  // per-call scan is fine. Pins the deliberately-different cadence.
  let scanCount = 0;
  const fresh = (): string | null => {
    scanCount++;
    return null;
  };
  const deps = { dirExists: () => true, probeShadow: fresh };
  resolveWorkerCell({ pluginDir: "/abs/cell-a" }, deps);
  resolveWorkerCell({ pluginDir: "/abs/cell-b" }, deps);
  expect(scanCount).toBe(2);
});

// ---------------------------------------------------------------------------
// No-prose contract — the helper returns machine kinds ONLY; callers add text
// ---------------------------------------------------------------------------

test("resolveWorkerCell: reject results carry machine fields ONLY, no operator prose", () => {
  const missing = resolveWorkerCell(
    { pluginDir: "/abs/cell" },
    { dirExists: () => false, probeShadow: () => null },
  );
  // The missing reject exposes the raw cell path — NEVER the caller-composed
  // 'regenerate via render-plugin-templates' remediation prose (that stays in
  // the producer's byte-pinned reason string and dispatch's own error text).
  expect(Object.keys(missing).sort()).toEqual(["kind", "ok", "pluginDir"]);
  expect(JSON.stringify(missing)).not.toContain("render-plugin-templates");
  expect(JSON.stringify(missing)).not.toContain("regenerate");

  const shadowed = resolveWorkerCell(
    { pluginDir: "/abs/cell" },
    { dirExists: () => true, probeShadow: () => "/scan/w/plugin.json" },
  );
  expect(Object.keys(shadowed).sort()).toEqual([
    "kind",
    "ok",
    "pluginDir",
    "shadowManifest",
  ]);
  // No 'steal' / 'remove or rename' shadow prose leaks into the machine result.
  expect(JSON.stringify(shadowed)).not.toContain("steal");
  expect(JSON.stringify(shadowed)).not.toContain("rename");
});

test("resolveWorkerCell result is a closed union an assertNever switch can exhaust", () => {
  // A compile-time contract exercised at runtime: every reject kind maps, and an
  // unmapped kind would fail `assertNever` at compile time (the parity net both
  // callers rely on). This asserts the runtime shape stays in lockstep.
  const kinds = new Set<string>();
  const classify = (r: WorkerCellResult): string => {
    if (r.ok) return "ok";
    switch (r.kind) {
      case "out-of-matrix":
        return "out-of-matrix";
      case "missing":
        return "missing";
      case "shadowed":
        return "shadowed";
      default:
        return ((x: never) => `unreachable:${String(x)}`)(r);
    }
  };
  const cases: WorkerCellCompose[] = [
    { pluginDir: "/c" }, // → ok
    { pluginDir: null }, // → ok (cell-less)
    { pluginDir: null, reject: "x" }, // → out-of-matrix
  ];
  for (const c of cases) {
    kinds.add(
      classify(
        resolveWorkerCell(c, {
          dirExists: () => true,
          probeShadow: () => null,
        }),
      ),
    );
  }
  kinds.add(
    classify(
      resolveWorkerCell(
        { pluginDir: "/c" },
        { dirExists: () => false, probeShadow: () => null },
      ),
    ),
  );
  kinds.add(
    classify(
      resolveWorkerCell(
        { pluginDir: "/c" },
        { dirExists: () => true, probeShadow: () => "/s" },
      ),
    ),
  );
  expect(kinds).toEqual(
    new Set(["ok", "out-of-matrix", "missing", "shadowed"]),
  );
});
