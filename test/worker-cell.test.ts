/**
 * Unit contract for the shared launcher-owned worker-cell resolution seam
 * (`src/worker-cell.ts`) — the ONE decision both the autopilot producer and the
 * manual dispatch CLI route through. Covers every union variant, the injected
 * filesystem- and host-matrix probe CADENCE (a lazy shadow probe reached only for
 * a present cell; a route probe reached only down the compose-reject arm), the
 * precedence (no-route → out-of-matrix → missing → shadowed), and the no-prose
 * contract (the helper returns machine kinds only; each caller owns its operator
 * text).
 *
 * Pure in-process — no daemon, no real plugin config, no real matrix.yaml.
 * `composeWorkerCellDir` reaches the compiled-in subagents matrix (a memoized
 * embed parse, no I/O); `resolveWorkerCell` and `defaultRouteProbe` take injected
 * probes / a hand-built matrix so no test touches the disk.
 */

import { expect, test } from "bun:test";
import { ConfigError } from "../src/agent/config";
import type { HarnessName } from "../src/agent/harness";
import type { Matrix } from "../src/agent/matrix";
import {
  composeWorkerCellDir,
  defaultRouteProbe,
  resolveWorkerCell,
  type WorkerCellCompose,
  type WorkerCellResult,
  type WorkerCellRoute,
} from "../src/worker-cell";

// A probe pair that FAILS the test if invoked — proves a code path never reaches
// the filesystem OR the host matrix. `dirExists`/`probeShadow` are the fs probes;
// `probeRoute` is the host-matrix probe (reached ONLY down the compose-reject
// arm). Each throws so an accidental call surfaces.
const neverProbe = {
  dirExists: (_p: string): boolean => {
    throw new Error("dirExists must not be called on this path");
  },
  probeShadow: (): string | null => {
    throw new Error("probeShadow must not be called on this path");
  },
  probeRoute: (): WorkerCellRoute => {
    throw new Error("probeRoute must not be called on this path");
  },
};

// A route probe that reports every wrapped-candidate as routable — leaves the
// generic out-of-matrix reject standing (the pre-no-route behavior).
const routed = (): WorkerCellRoute => ({ kind: "routed" });

// Build a host matrix from a `[harness, [models...]]` roster (native id ===
// capability). Enough to exercise `driverFor` / `providerOrderFor` purely.
function mkMatrix(roster: Array<[HarnessName, string[]]>): Matrix {
  return {
    efforts: ["high"],
    providers: roster.map(([name, models]) => ({
      name,
      route: true,
      models: new Map(models.map((m) => [m, m])),
      modelEfforts: new Map(),
    })),
    subagents: ["template/agents/worker.md.tmpl"],
    wrapper_driver: { model: "sonnet", effort: "high" },
    defaults: { stop_timeout_ms: 1, max_attempts: 1 },
  };
}

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
  // The `{model, tier}` axes are carried verbatim (the routed-wrapped arm needs
  // them) — but a null EITHER axis stays cell-less: pluginDir null, no reject.
  expect(composeWorkerCellDir(null, "max")).toEqual({
    pluginDir: null,
    model: null,
    tier: "max",
  });
  expect(composeWorkerCellDir("opus", null)).toEqual({
    pluginDir: null,
    model: "opus",
    tier: null,
  });
  expect(composeWorkerCellDir(null, null)).toEqual({
    pluginDir: null,
    model: null,
    tier: null,
  });
});

test("composeWorkerCellDir: an out-of-matrix pair is carried as a reject (never a throw), axes retained", () => {
  const c = composeWorkerCellDir("opus", "ludicrous");
  expect(c.pluginDir).toBeNull();
  expect(typeof c.reject).toBe("string");
  expect(c.reject).not.toBe("");
  // The axes ride the reject so the seam's routed-wrapped arm can re-derive the
  // host cell path without re-running the embedded-axis validation that threw.
  expect(c.model).toBe("opus");
  expect(c.tier).toBe("ludicrous");
});

// ---------------------------------------------------------------------------
// defaultRouteProbe — the host-matrix classification for a wrapped candidate
// ---------------------------------------------------------------------------

test("defaultRouteProbe: an ABSENT matrix → routed (the claude-only world; out-of-matrix stands)", () => {
  expect(defaultRouteProbe("gpt-5.5", () => null)).toEqual({ kind: "routed" });
});

test("defaultRouteProbe: a native (claude-served) model → routed", () => {
  const matrix = mkMatrix([
    ["claude", ["opus", "sonnet"]],
    ["codex", ["gpt-5.5"]],
  ]);
  expect(defaultRouteProbe("opus", () => matrix)).toEqual({ kind: "routed" });
});

test("defaultRouteProbe: a wrapped model with ≥1 serving provider → wrapped", () => {
  const matrix = mkMatrix([
    ["claude", ["opus"]],
    ["codex", ["gpt-5.5"]],
  ]);
  expect(defaultRouteProbe("gpt-5.5", () => matrix)).toEqual({
    kind: "wrapped",
  });
});

test("defaultRouteProbe: a wrapped model NO provider serves → no-route carrying the model", () => {
  const matrix = mkMatrix([
    ["claude", ["opus"]],
    ["codex", ["gpt-5.5"]],
  ]);
  expect(defaultRouteProbe("grok-9", () => matrix)).toEqual({
    kind: "no-route",
    model: "grok-9",
  });
});

test("defaultRouteProbe: a malformed matrix (ConfigError) → no-route DEGRADE, never throws", () => {
  // Producer/daemon posture: a parse fault at probe time degrades to the visible
  // no-route sticky rather than a fatalExit. `defaultRouteProbe` swallows the
  // ConfigError; a NON-config error still propagates (a real bug, not degradable).
  expect(
    defaultRouteProbe("gpt-5.5", () => {
      throw new ConfigError("bad matrix.yaml");
    }),
  ).toEqual({ kind: "no-route", model: "gpt-5.5" });

  expect(() =>
    defaultRouteProbe("gpt-5.5", () => {
      throw new TypeError("not a config error");
    }),
  ).toThrow(TypeError);
});

// ---------------------------------------------------------------------------
// resolveWorkerCell — the shared probe precedence over a compose
// ---------------------------------------------------------------------------

test("resolveWorkerCell: a present cell with no shadow → ok, pluginDir threaded (native never routes)", () => {
  const cell = resolveWorkerCell(
    { pluginDir: "/abs/keeper/plugins/plan/workers/opus-max" },
    // A native (composed) cell must NEVER touch the route probe.
    {
      dirExists: () => true,
      probeShadow: () => null,
      probeRoute: neverProbe.probeRoute,
    },
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

test("resolveWorkerCell: a reject compose + routed probe → out-of-matrix, fs probes never touched", () => {
  // The route probe IS consulted down the reject arm (that is the wrapped-cell
  // check); a `routed` verdict leaves the generic out-of-matrix reject standing,
  // and the filesystem probes stay untouched.
  const cell = resolveWorkerCell(
    { pluginDir: null, reject: "no worker agent for (opus, ludicrous)" },
    {
      dirExists: neverProbe.dirExists,
      probeShadow: neverProbe.probeShadow,
      probeRoute: routed,
    },
  );
  expect(cell).toEqual({
    ok: false,
    kind: "out-of-matrix",
    message: "no worker agent for (opus, ludicrous)",
  });
});

test("resolveWorkerCell: a reject compose + no-route probe → no-route carrying the model (ranks ahead)", () => {
  // A wrapped model claude does not serve lands as an out-of-matrix compose; the
  // route probe re-classifies it to the more actionable no-route reject, ranked
  // AHEAD of the generic out-of-matrix. fs probes stay untouched.
  const cell = resolveWorkerCell(
    { pluginDir: null, reject: "no worker agent for (gpt-5.5, high)" },
    {
      dirExists: neverProbe.dirExists,
      probeShadow: neverProbe.probeShadow,
      probeRoute: () => ({ kind: "no-route", model: "gpt-5.5" }),
    },
  );
  expect(cell).toEqual({ ok: false, kind: "no-route", model: "gpt-5.5" });
});

test("resolveWorkerCell: a reject compose + wrapped probe + rendered manifest → ok, resolves the host cell dir", () => {
  // The headline fix: a routed WRAPPED candidate re-derives its rendered host cell
  // path from the {model, tier} the compose carried (PATH ONLY — the embedded-axis
  // validation is what threw) and falls through to the manifest probe, resolving
  // OK with the cell dir — the same discipline a native cell dispatches under.
  const cell = resolveWorkerCell(
    {
      pluginDir: null,
      reject: 'unknown model "gpt-5.5"',
      model: "gpt-5.5",
      tier: "high",
    },
    {
      dirExists: () => true,
      probeShadow: () => null,
      probeRoute: (): WorkerCellRoute => ({ kind: "wrapped" }),
    },
  );
  expect(cell.ok).toBe(true);
  if (cell.ok) {
    // Absolute, cwd-independent, under keeper's generated workers tree — the SAME
    // shape a native cell composes, just the wrapped capability model's name.
    expect(cell.pluginDir?.startsWith("/")).toBe(true);
    expect(cell.pluginDir).toContain("plugins/plan/workers/gpt-5.5-high");
  }
});

test("resolveWorkerCell: a wrapped probe + ABSENT manifest → missing naming the host cell dir (regen hint upstream)", () => {
  // A routed-but-UNRENDERED wrapped cell surfaces as the ordinary `missing` reject
  // carrying the composed host cell dir (the caller composes the regenerate hint),
  // BEFORE the shadow probe — proving the wrapped arm honors the full precedence.
  const cell = resolveWorkerCell(
    { pluginDir: null, reject: "x", model: "gpt-5.5", tier: "high" },
    {
      dirExists: () => false,
      probeShadow: neverProbe.probeShadow,
      probeRoute: (): WorkerCellRoute => ({ kind: "wrapped" }),
    },
  );
  expect(cell.ok).toBe(false);
  if (!cell.ok) {
    expect(cell.kind).toBe("missing");
    if (cell.kind === "missing") {
      expect(cell.pluginDir).toContain("plugins/plan/workers/gpt-5.5-high");
    }
  }
});

test("resolveWorkerCell: a wrapped routed cell still honors the shadow probe (same guard as native)", () => {
  const cell = resolveWorkerCell(
    { pluginDir: null, reject: "x", model: "gpt-5.5", tier: "high" },
    {
      dirExists: () => true,
      probeShadow: () => "/scan/arthack-work/plugin.json",
      probeRoute: (): WorkerCellRoute => ({ kind: "wrapped" }),
    },
  );
  expect(cell.ok).toBe(false);
  if (!cell.ok && cell.kind === "shadowed") {
    expect(cell.pluginDir).toContain("plugins/plan/workers/gpt-5.5-high");
    expect(cell.shadowManifest).toBe("/scan/arthack-work/plugin.json");
  } else {
    throw new Error(`expected shadowed, got ${JSON.stringify(cell)}`);
  }
});

test("resolveWorkerCell: a wrapped verdict on a reject compose MISSING its axes → out-of-matrix (defensive)", () => {
  // A wrapped verdict but no {model, tier} on the compose (never a real reject
  // compose — the pure compose always carries the axes) leaves the generic
  // out-of-matrix standing rather than composing a bogus path. fs probes untouched.
  const cell = resolveWorkerCell(
    { pluginDir: null, reject: "bad pair" },
    {
      dirExists: neverProbe.dirExists,
      probeShadow: neverProbe.probeShadow,
      probeRoute: (): WorkerCellRoute => ({ kind: "wrapped" }),
    },
  );
  expect(cell).toEqual({
    ok: false,
    kind: "out-of-matrix",
    message: "bad pair",
  });
});

test("resolveWorkerCell: an absent cell manifest → missing, BEFORE the shadow probe, never routes", () => {
  const cell = resolveWorkerCell(
    { pluginDir: "/abs/cell" },
    {
      dirExists: () => false,
      probeShadow: () => {
        throw new Error("shadow probe reached after a missing manifest");
      },
      probeRoute: neverProbe.probeRoute,
    },
  );
  expect(cell).toEqual({ ok: false, kind: "missing", pluginDir: "/abs/cell" });
});

test("resolveWorkerCell: a shadowing work plugin → shadowed, carrying both paths, never routes", () => {
  const cell = resolveWorkerCell(
    { pluginDir: "/abs/cell" },
    {
      dirExists: () => true,
      probeShadow: () => "/scan/arthack-work/plugin.json",
      probeRoute: neverProbe.probeRoute,
    },
  );
  expect(cell).toEqual({
    ok: false,
    kind: "shadowed",
    pluginDir: "/abs/cell",
    shadowManifest: "/scan/arthack-work/plugin.json",
  });
});

test("resolveWorkerCell: precedence — a no-route probe outranks the out-of-matrix message", () => {
  // reject present + no-route probe → no-route wins; fs probes never consulted.
  const cell = resolveWorkerCell(
    { pluginDir: null, reject: "bad pair" },
    {
      dirExists: () => false,
      probeShadow: () => "/scan/shadow/plugin.json",
      probeRoute: () => ({ kind: "no-route", model: "gpt-5.5" }),
    },
  );
  expect(cell).toMatchObject({ kind: "no-route", model: "gpt-5.5" });
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
      probeRoute: neverProbe.probeRoute,
    },
  );
  expect(cell).toMatchObject({ kind: "missing" });
  expect(shadowCalls).toBe(0);
});

// ---------------------------------------------------------------------------
// Probe cadence — the route probe fires ONLY down the reject arm; the shadow
// probe fires lazily; a memoized closure serves once
// ---------------------------------------------------------------------------

test("resolveWorkerCell: the route probe is reached ONLY down the compose-reject arm (native bypass)", () => {
  let routeCalls = 0;
  const probeRoute = (): WorkerCellRoute => {
    routeCalls++;
    return { kind: "routed" };
  };
  // A present (native) cell and a cell-less compose never route.
  resolveWorkerCell(
    { pluginDir: "/abs/cell" },
    { dirExists: () => true, probeShadow: () => null, probeRoute },
  );
  resolveWorkerCell(
    { pluginDir: null },
    { dirExists: () => true, probeShadow: () => null, probeRoute },
  );
  expect(routeCalls).toBe(0);
  // A reject compose (a wrapped candidate) reaches it exactly once.
  resolveWorkerCell(
    { pluginDir: null, reject: "x" },
    { dirExists: () => true, probeShadow: () => null, probeRoute },
  );
  expect(routeCalls).toBe(1);
});

test("resolveWorkerCell: the shadow probe is reached ONLY for a present cell with a live manifest", () => {
  let shadowCalls = 0;
  const probeShadow = (): string | null => {
    shadowCalls++;
    return null;
  };
  // Cell-less and reject compose never reach the shadow probe.
  resolveWorkerCell(
    { pluginDir: null },
    { dirExists: () => true, probeShadow, probeRoute: routed },
  );
  resolveWorkerCell(
    { pluginDir: null, reject: "x" },
    { dirExists: () => true, probeShadow, probeRoute: routed },
  );
  expect(shadowCalls).toBe(0);
  // A present cell with a live manifest reaches it exactly once.
  resolveWorkerCell(
    { pluginDir: "/abs/cell" },
    { dirExists: () => true, probeShadow, probeRoute: neverProbe.probeRoute },
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
  const deps = {
    dirExists: () => true,
    probeShadow: memoized,
    probeRoute: neverProbe.probeRoute,
  };
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
  const deps = {
    dirExists: () => true,
    probeShadow: fresh,
    probeRoute: neverProbe.probeRoute,
  };
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
    {
      dirExists: () => false,
      probeShadow: () => null,
      probeRoute: neverProbe.probeRoute,
    },
  );
  // The missing reject exposes the raw cell path — NEVER the caller-composed
  // 'regenerate via render-plugin-templates' remediation prose (that stays in
  // the producer's byte-pinned reason string and dispatch's own error text).
  expect(Object.keys(missing).sort()).toEqual(["kind", "ok", "pluginDir"]);
  expect(JSON.stringify(missing)).not.toContain("render-plugin-templates");
  expect(JSON.stringify(missing)).not.toContain("regenerate");

  const shadowed = resolveWorkerCell(
    { pluginDir: "/abs/cell" },
    {
      dirExists: () => true,
      probeShadow: () => "/scan/w/plugin.json",
      probeRoute: neverProbe.probeRoute,
    },
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

  // The no-route reject carries the capability model ONLY — never the caller's
  // 'add a provider to matrix.yaml' remediation prose or the file path.
  const noRoute = resolveWorkerCell(
    { pluginDir: null, reject: "x" },
    {
      dirExists: neverProbe.dirExists,
      probeShadow: neverProbe.probeShadow,
      probeRoute: () => ({ kind: "no-route", model: "gpt-5.5" }),
    },
  );
  expect(Object.keys(noRoute).sort()).toEqual(["kind", "model", "ok"]);
  expect(JSON.stringify(noRoute)).not.toContain("matrix.yaml");
  expect(JSON.stringify(noRoute)).not.toContain("provider");
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
      case "no-route":
        return "no-route";
      case "missing":
        return "missing";
      case "shadowed":
        return "shadowed";
      default:
        return ((x: never) => `unreachable:${String(x)}`)(r);
    }
  };
  const okCases: Array<[WorkerCellCompose, WorkerCellRoute]> = [
    [{ pluginDir: "/c" }, { kind: "routed" }], // → ok
    [{ pluginDir: null }, { kind: "routed" }], // → ok (cell-less)
    [{ pluginDir: null, reject: "x" }, { kind: "routed" }], // → out-of-matrix
    [
      { pluginDir: null, reject: "x" },
      { kind: "no-route", model: "m" },
    ], // → no-route
  ];
  for (const [c, route] of okCases) {
    kinds.add(
      classify(
        resolveWorkerCell(c, {
          dirExists: () => true,
          probeShadow: () => null,
          probeRoute: () => route,
        }),
      ),
    );
  }
  kinds.add(
    classify(
      resolveWorkerCell(
        { pluginDir: "/c" },
        {
          dirExists: () => false,
          probeShadow: () => null,
          probeRoute: neverProbe.probeRoute,
        },
      ),
    ),
  );
  kinds.add(
    classify(
      resolveWorkerCell(
        { pluginDir: "/c" },
        {
          dirExists: () => true,
          probeShadow: () => "/s",
          probeRoute: neverProbe.probeRoute,
        },
      ),
    ),
  );
  expect(kinds).toEqual(
    new Set(["ok", "out-of-matrix", "no-route", "missing", "shadowed"]),
  );
});
