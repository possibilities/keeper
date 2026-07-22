/**
 * Unit contract for the shared launcher-owned worker-cell resolution seam
 * (`src/worker-cell.ts`) — the ONE decision both the autopilot producer and the
 * manual dispatch CLI route through. Covers every union variant, the injected
 * filesystem-probe CADENCE (a lazy shadow probe reached only for a present cell),
 * the precedence (bad-matrix → out-of-matrix → missing → stale → shadowed), and the
 * no-prose contract (the helper returns machine kinds only; each caller owns its
 * operator text).
 *
 * Pure in-process — no daemon, no real plugin config, no real matrix.yaml.
 * `composeWorkerCellDir` takes an injected v2-matrix loader (never touching disk);
 * `resolveWorkerCell` takes injected probes. Every state — good axes, a ragged
 * per-model effort list, and each of the four matrix-load failures — is driven
 * without reading `~/.config/keeper`.
 */

import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeWorkerCompileCellResult } from "../plugins/prompt/src/claude_worker_compiler";
import {
  MatrixConfigError,
  type MatrixConfigState,
  type MatrixV2,
} from "../src/agent/matrix";
import {
  composeWorkerCellDir,
  createWorkPluginShadowProbe,
  findShadowingWorkManifest,
  inventoryConfiguredWorkPluginManifests,
  inventoryLaunchCwdWorkPluginManifests,
  inventoryWorkPluginManifests,
  providerUnlaunchableReason,
  resolveWorkerCell as resolveWorkerCellBase,
  selectedWorkerCellFreshness,
  verifyWorkerCellCohort,
  WORKER_CELL_BASE,
  type WorkerCellCompose,
  type WorkerCellProbeDeps,
  type WorkerCellResult,
} from "../src/worker-cell";

function resolveWorkerCell(
  compose: WorkerCellCompose,
  deps: Omit<WorkerCellProbeDeps, "probeFreshness"> &
    Partial<Pick<WorkerCellProbeDeps, "probeFreshness">>,
): WorkerCellResult {
  return resolveWorkerCellBase(compose, {
    probeFreshness: () => ({ ok: true }),
    ...deps,
  });
}

// A probe pair that FAILS the test if invoked — proves a code path never reaches
// the filesystem. Each throws so an accidental call surfaces.
const neverProbe = {
  dirExists: (_p: string): boolean => {
    throw new Error("dirExists must not be called on this path");
  },
  probeFreshness: (): { ok: true } => {
    throw new Error("probeFreshness must not be called on this path");
  },
  probeShadow: (): string | null => {
    throw new Error("probeShadow must not be called on this path");
  },
};

// Build a minimal-but-valid v2 matrix carrying just the cell axes the compose
// reads (subagent_models, per-model efforts, top-level efforts). The provider
// roster is irrelevant to composition, so it stays empty.
function mkMatrixV2(
  models: string[],
  efforts: string[] = ["low", "medium", "high", "xhigh", "max"],
  effortsByModel: Map<string, string[]> = new Map(),
): MatrixV2 {
  return {
    efforts,
    subagentTemplates: ["template/agents/worker.md.tmpl"],
    subagentModels: models,
    providers: [],
    wrapper_driver: { model: "sonnet", effort: "high" },
    defaults: { stop_timeout_ms: 1, max_attempts: 1 },
    driverByModel: new Map(),
    effortsByModel,
    shadowed: [],
    agentPins: new Map(),
  };
}

const CLAUDE_ONLY = (): MatrixV2 => mkMatrixV2(["opus", "sonnet"]);

// ---------------------------------------------------------------------------
// composeWorkerCellDir — loads the v2 matrix, composes, carries the reject
// ---------------------------------------------------------------------------

test("composeWorkerCellDir: an in-matrix (model, tier) resolves the absolute cell dir, no reject", () => {
  const c = composeWorkerCellDir("opus", "max", CLAUDE_ONLY);
  expect(c.reject).toBeUndefined();
  expect(c.matrixReject).toBeUndefined();
  expect(c.pluginDir).not.toBeNull();
  // Absolute path under keeper's generated workers tree, cwd-independent.
  expect(c.pluginDir?.startsWith("/")).toBe(true);
  expect(c.pluginDir).toContain("plugins/plan/workers/opus-max");
});

test("composeWorkerCellDir: a wrapped model in subagent_models composes its cell dir directly", () => {
  // In v2 subagent_models is the ONE cell axis (native + wrapped alike). A wrapped
  // capability with a narrowed effort list composes `workers/<model>-<effort>` with
  // no reject — no route probe, no re-derivation.
  const load = () =>
    mkMatrixV2(
      ["opus", "sonnet", "gpt-5.5"],
      ["low", "medium", "high", "xhigh", "max"],
      new Map([["gpt-5.5", ["high"]]]),
    );
  const c = composeWorkerCellDir("gpt-5.5", "high", load);
  expect(c.reject).toBeUndefined();
  expect(c.pluginDir).toContain("plugins/plan/workers/gpt-5.5-high");
});

test("composeWorkerCellDir: a null EITHER axis is legitimately cell-less (pluginDir null, no reject)", () => {
  expect(composeWorkerCellDir(null, "max", CLAUDE_ONLY)).toEqual({
    pluginDir: null,
    model: null,
    tier: "max",
  });
  expect(composeWorkerCellDir("opus", null, CLAUDE_ONLY)).toEqual({
    pluginDir: null,
    model: "opus",
    tier: null,
  });
  expect(composeWorkerCellDir(null, null, CLAUDE_ONLY)).toEqual({
    pluginDir: null,
    model: null,
    tier: null,
  });
});

test("composeWorkerCellDir: an out-of-matrix pair is carried as a reject (never a throw), axes retained", () => {
  const c = composeWorkerCellDir("opus", "ludicrous", CLAUDE_ONLY);
  expect(c.pluginDir).toBeNull();
  expect(c.matrixReject).toBeUndefined();
  expect(typeof c.reject).toBe("string");
  expect(c.reject).toContain("unknown tier");
  expect(c.model).toBe("opus");
  expect(c.tier).toBe("ludicrous");
});

test("composeWorkerCellDir: a model outside subagent_models is an out-of-matrix reject", () => {
  const c = composeWorkerCellDir("grok-9", "high", CLAUDE_ONLY);
  expect(c.pluginDir).toBeNull();
  expect(c.reject).toContain("unknown model");
});

test("composeWorkerCellDir: a matrix-load failure is carried as a four-state matrixReject (never a throw)", () => {
  for (const state of [
    "absent",
    "unparseable",
    "schema-invalid",
    "valid-but-empty",
  ] as const) {
    const c = composeWorkerCellDir("opus", "max", () => {
      throw new MatrixConfigError(state, "/cfg/matrix.yaml", `matrix ${state}`);
    });
    expect(c.pluginDir).toBeNull();
    expect(c.reject).toBeUndefined();
    expect(c.matrixReject?.state).toBe(state);
    // The detail carries the MatrixConfigError message (what + where + the fix).
    expect(c.matrixReject?.detail).toContain("/cfg/matrix.yaml");
    expect(c.matrixReject?.detail).toContain("matrix.example.yaml");
  }
});

test("composeWorkerCellDir: a non-MatrixConfigError from the loader propagates (a real bug, not degradable)", () => {
  expect(() =>
    composeWorkerCellDir("opus", "max", () => {
      throw new TypeError("not a matrix config error");
    }),
  ).toThrow(TypeError);
});

// ---------------------------------------------------------------------------
// resolveWorkerCell — the shared probe precedence over a compose
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

test("resolveWorkerCell: an out-of-matrix reject → out-of-matrix, fs probes never touched", () => {
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

test("resolveWorkerCell: a matrixReject → bad-matrix carrying the state + detail, ranks FIRST", () => {
  for (const state of [
    "absent",
    "unparseable",
    "schema-invalid",
    "valid-but-empty",
  ] as const) {
    const cell = resolveWorkerCell(
      {
        pluginDir: null,
        matrixReject: { state, detail: `matrix ${state} detail` },
      },
      neverProbe,
    );
    expect(cell).toEqual({
      ok: false,
      kind: "bad-matrix",
      state,
      detail: `matrix ${state} detail`,
    });
  }
});

test("resolveWorkerCell: bad-matrix outranks a stale pluginDir + present shadow (fs probes never consulted)", () => {
  // Defensive: a matrixReject wins even if the compose somehow also carried a
  // pluginDir — no matrix means no cell, so the fs probes stay untouched.
  const cell = resolveWorkerCell(
    {
      pluginDir: "/abs/cell",
      matrixReject: { state: "schema-invalid", detail: "bad" },
    },
    neverProbe,
  );
  expect(cell).toMatchObject({ kind: "bad-matrix", state: "schema-invalid" });
});

test("resolveWorkerCell: provider-reject ranks after bad-matrix and before out-of-matrix, with no probes", () => {
  const providerReject: NonNullable<WorkerCellCompose["providerReject"]> = {
    reason: "no-map-entry",
    provider: "gpt",
    direction: "claude_to_gpt",
    assigned: { model: "opus", effort: "max" },
    target: null,
  };
  expect(
    resolveWorkerCell(
      {
        pluginDir: "/abs/cell",
        providerReject,
        reject: "out of matrix",
      },
      neverProbe,
    ),
  ).toMatchObject({ kind: "provider-reject", reason: "no-map-entry" });
  expect(
    resolveWorkerCell(
      {
        pluginDir: "/abs/cell",
        providerReject,
        matrixReject: { state: "absent", detail: "no matrix" },
      },
      neverProbe,
    ),
  ).toMatchObject({ kind: "bad-matrix" });
});

test("resolveWorkerCell: provider launch contract accepts current native and wrapped cell classes", () => {
  const cases: WorkerCellCompose[] = [
    {
      pluginDir: "/abs/opus-max",
      providerLaunchContract: {
        provider: "claude",
        model: "opus",
        tier: "max",
        driver: "native",
        route: "native",
        wrappedCell: null,
      },
    },
    {
      pluginDir: "/abs/gpt-5.6-sol-max",
      providerLaunchContract: {
        provider: "gpt",
        model: "gpt-5.6-sol",
        tier: "max",
        driver: "wrapped",
        route: "wrapped",
        wrappedCell: "gpt-5.6-sol::max",
      },
    },
  ];
  for (const compose of cases) {
    expect(
      resolveWorkerCell(compose, {
        dirExists: () => true,
        probeShadow: () => null,
      }),
    ).toEqual({ ok: true, pluginDir: compose.pluginDir });
  }
});

test("resolveWorkerCell: provider constraint rejects a native-only effective cell before filesystem probes", () => {
  const cell = resolveWorkerCell(
    {
      pluginDir: "/abs/opus-xhigh",
      providerLaunchContract: {
        provider: "gpt",
        model: "opus",
        tier: "xhigh",
        driver: "native",
        route: "native",
        wrappedCell: null,
      },
    },
    neverProbe,
  );
  expect(cell).toEqual({
    ok: false,
    kind: "provider-unlaunchable",
    provider: "gpt",
    model: "opus",
    tier: "xhigh",
    driver: "native",
    route: "native",
    wrappedCell: null,
    constraintDriver: "wrapped",
  });
  if (!cell.ok && cell.kind === "provider-unlaunchable") {
    expect(providerUnlaunchableReason(cell)).toBe(
      "worker-provider-cell-unlaunchable: worker_provider=gpt cannot launch effective cell opus/xhigh — constraint requires wrapped, but driver=native, route=native, wrapped_marker=none; refusing to dispatch before spawn; fix the provider constraint, equivalence map, host matrix route, or compiled cell, then retry",
    );
  }
});

test("resolveWorkerCell: wrapped marker cannot bless a route-less or native route", () => {
  for (const route of [null, "native"] as const) {
    expect(
      resolveWorkerCell(
        {
          pluginDir: "/abs/gpt-5.6-sol-max",
          providerLaunchContract: {
            provider: "gpt",
            model: "gpt-5.6-sol",
            tier: "max",
            driver: "wrapped",
            route,
            wrappedCell: "gpt-5.6-sol::max",
          },
        },
        neverProbe,
      ),
    ).toMatchObject({
      ok: false,
      kind: "provider-unlaunchable",
      provider: "gpt",
      model: "gpt-5.6-sol",
      tier: "max",
      route,
    });
  }
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
  // Cell-less, out-of-matrix, and bad-matrix composes never reach the shadow probe.
  resolveWorkerCell(
    { pluginDir: null },
    { dirExists: () => true, probeShadow },
  );
  resolveWorkerCell(
    { pluginDir: null, reject: "x" },
    { dirExists: () => true, probeShadow },
  );
  resolveWorkerCell(
    { pluginDir: null, matrixReject: { state: "absent", detail: "x" } },
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
  // that serves it — so N cell launches trigger AT MOST one on-disk scan.
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
// Compiler freshness + exact preloaded-work inventory
// ---------------------------------------------------------------------------

test("resolveWorkerCell: stale cohort ranks after missing and before shadow", () => {
  let shadowCalls = 0;
  const stale = resolveWorkerCell(
    { pluginDir: "/abs/cell" },
    {
      dirExists: () => true,
      probeFreshness: () => ({
        ok: false,
        detail: "hash-mismatch: primary bytes differ",
      }),
      probeShadow: () => {
        shadowCalls++;
        return "/shadow/manifest.json";
      },
    },
  );
  expect(stale).toEqual({
    ok: false,
    kind: "stale",
    pluginDir: "/abs/cell",
    detail: "hash-mismatch: primary bytes differ",
  });
  expect(shadowCalls).toBe(0);

  let freshnessCalls = 0;
  const missing = resolveWorkerCell(
    { pluginDir: "/abs/cell" },
    {
      dirExists: () => false,
      probeFreshness: () => {
        freshnessCalls++;
        return { ok: false, detail: "stale" };
      },
      probeShadow: () => null,
    },
  );
  expect(missing).toMatchObject({ kind: "missing" });
  expect(freshnessCalls).toBe(0);
});

test("verifyWorkerCellCohort: compiler output cells become the exact selected-dir inventory", () => {
  const verified = verifyWorkerCellCohort({
    verify: () => ({
      ok: true,
      target: "claude",
      fingerprint: "compiler-fingerprint",
      outputs: [
        {
          cell: { model: "opus", effort: "max" },
        } as ClaudeWorkerCompileCellResult,
      ],
    }),
  });
  expect(verified).toEqual({
    ok: true,
    fingerprint: "compiler-fingerprint",
    pluginDirs: [join(WORKER_CELL_BASE, "opus-max")],
  });
});

test("verifyWorkerCellCohort: typed compiler failure becomes concise machine stale detail", () => {
  expect(
    verifyWorkerCellCohort({
      verify: () => ({
        ok: false,
        target: "claude",
        failure: {
          kind: "hash-mismatch",
          message: "primary hash does not match",
          path: "/workers/opus-max/agents/worker.md",
        },
      }),
    }),
  ).toEqual({
    ok: false,
    detail:
      "hash-mismatch: primary hash does not match (/workers/opus-max/agents/worker.md)",
  });
});

test("verifyWorkerCellCohort: one alternate checkout root owns verification and physical allowed cells", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worker-cohort-root-")));
  try {
    const checkoutA = join(root, "checkout-a");
    const checkoutB = join(root, "checkout-b");
    const cellA = join(checkoutA, "plugins", "plan", "workers", "opus-max");
    const cellB = join(checkoutB, "plugins", "plan", "workers", "opus-max");
    mkdirSync(cellA, { recursive: true });
    mkdirSync(cellB, { recursive: true });
    const checkoutAlias = join(root, "checkout-a-alias");
    const cellAlias = join(root, "opus-max-alias");
    symlinkSync(checkoutA, checkoutAlias);
    symlinkSync(cellA, cellAlias);

    let verifierRoot: string | undefined;
    const verified = verifyWorkerCellCohort({
      repoRoot: checkoutAlias,
      verify: (options) => {
        verifierRoot = options?.repoRoot;
        return {
          ok: true,
          target: "claude",
          fingerprint: "checkout-a",
          outputs: [
            {
              cell: { model: "opus", effort: "max" },
            } as ClaudeWorkerCompileCellResult,
          ],
        };
      },
    });

    expect(verifierRoot).toBe(checkoutAlias);
    expect(verified).toMatchObject({
      ok: true,
      pluginDirs: [realpathSync(cellA)],
    });
    // A symlink to checkout A's selected cell is the same physical identity.
    expect(selectedWorkerCellFreshness(cellAlias, verified)).toEqual({
      ok: true,
    });
    // Identically named output in checkout B cannot ride checkout A's proof.
    expect(selectedWorkerCellFreshness(cellB, verified)).toEqual({
      ok: false,
      detail: `selected-cell-not-in-verified-cohort: ${cellB}`,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selectedWorkerCellFreshness: verified exact membership is fresh; absent selected cell is stale", () => {
  const verified = {
    ok: true as const,
    fingerprint: "fp",
    pluginDirs: ["/workers/opus-max", "/workers/sonnet-high"],
  };
  expect(selectedWorkerCellFreshness("/workers/opus-max", verified)).toEqual({
    ok: true,
  });
  expect(selectedWorkerCellFreshness("/workers/opus-high", verified)).toEqual({
    ok: false,
    detail: "selected-cell-not-in-verified-cohort: /workers/opus-high",
  });
  // Minimal injected clean fixture, intentionally no compiler inventory.
  expect(selectedWorkerCellFreshness("/any/test-cell", { ok: true })).toEqual({
    ok: true,
  });
});

function dropWorkPlugin(pluginDir: string, name = "work"): string {
  const manifestDir = join(pluginDir, ".claude-plugin");
  mkdirSync(manifestDir, { recursive: true });
  const manifest = join(manifestDir, "plugin.json");
  writeFileSync(manifest, JSON.stringify({ name }));
  return manifest;
}

test("work manifest inventory: exact selected manifest is legitimate, workers sibling shadows", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worker-cell-exact-")));
  try {
    const workers = join(root, "workers");
    dropWorkPlugin(join(workers, "opus-max"));
    const sibling = dropWorkPlugin(join(workers, "sonnet-max"));
    const inventory = inventoryWorkPluginManifests([], [workers]);
    expect(
      findShadowingWorkManifest(inventory, join(workers, "opus-max")),
    ).toBe(sibling);
    expect(
      findShadowingWorkManifest(
        inventory.filter((entry) => entry.manifest !== sibling),
        join(workers, "opus-max"),
      ),
    ).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work manifest inventory: explicit plugin_dirs work plugin shadows selected cell", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "worker-cell-explicit-")),
  );
  try {
    const selected = join(root, "workers", "opus-max");
    dropWorkPlugin(selected);
    const external = join(root, "explicit-work");
    const manifest = dropWorkPlugin(external);
    const inventory = inventoryWorkPluginManifests([external], []);
    expect(findShadowingWorkManifest(inventory, selected)).toBe(manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work manifest inventory: symlink aliases compare by physical identity", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "worker-cell-symlink-")),
  );
  try {
    const selected = join(root, "workers", "opus-max");
    dropWorkPlugin(selected);
    const sibling = join(root, "workers", "sonnet-max");
    const siblingManifest = dropWorkPlugin(sibling);
    const scan = join(root, "scan");
    mkdirSync(scan);
    symlinkSync(sibling, join(scan, "looks-like-opus-max"));
    const inventory = inventoryWorkPluginManifests([], [scan]);
    expect(inventory[0]?.physicalPluginDir).toBe(realpathSync(sibling));
    // The alias path cannot exploit the old broad workers-tree exemption.
    expect(findShadowingWorkManifest(inventory, realpathSync(selected))).toBe(
      join(scan, "looks-like-opus-max", ".claude-plugin", "plugin.json"),
    );
    expect(siblingManifest).toContain("sonnet-max");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work manifest inventory: missing and malformed entries are ignored", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worker-cell-ignore-")));
  try {
    const explicitMissing = join(root, "missing");
    const malformed = join(root, "scan", "malformed", ".claude-plugin");
    mkdirSync(malformed, { recursive: true });
    writeFileSync(join(malformed, "plugin.json"), "not json");
    dropWorkPlugin(join(root, "scan", "notes"), "notes");
    expect(
      inventoryWorkPluginManifests(
        [explicitMissing],
        [join(root, "scan"), join(root, "absent-scan")],
      ),
    ).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured work inventory: strip-scan-dirs omits scan shadows but hard plugin_dirs still shadow", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "worker-cell-isolation-")),
  );
  try {
    const selected = join(root, "selected");
    dropWorkPlugin(selected);
    const scanDir = join(root, "scan");
    dropWorkPlugin(join(scanDir, "scanned-work"));
    const explicit = join(root, "explicit-work");
    const explicitManifest = dropWorkPlugin(explicit);

    const isolatedScanOnly = inventoryConfiguredWorkPluginManifests({
      pluginDirs: [],
      pluginScanDirs: [scanDir],
      workerPluginIsolation: true,
    });
    expect(isolatedScanOnly).toEqual([]);
    expect(findShadowingWorkManifest(isolatedScanOnly, selected)).toBeNull();

    const isolatedWithExplicit = inventoryConfiguredWorkPluginManifests({
      pluginDirs: [explicit],
      pluginScanDirs: [scanDir],
      workerPluginIsolation: true,
    });
    expect(findShadowingWorkManifest(isolatedWithExplicit, selected)).toBe(
      explicitManifest,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch cwd inventory uses discovery's auto-plugin predicate and physical identity", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worker-cwd-plugin-")));
  try {
    const cwd = join(root, "repo");
    const manifest = dropWorkPlugin(cwd);
    // A manifest alone is not a launcher input: discoverPlugins does not add '.'.
    expect(inventoryLaunchCwdWorkPluginManifests(cwd)).toEqual([]);
    mkdirSync(join(cwd, "agents"));
    const inventory = inventoryLaunchCwdWorkPluginManifests(cwd);
    expect(inventory).toEqual([
      { manifest, physicalPluginDir: realpathSync(cwd) },
    ]);

    const selected = join(root, "selected-cell");
    dropWorkPlugin(selected);
    const selectedAlias = join(root, "selected-alias");
    symlinkSync(selected, selectedAlias);
    mkdirSync(join(selected, "skills"));
    expect(
      findShadowingWorkManifest(
        inventoryLaunchCwdWorkPluginManifests(selectedAlias),
        realpathSync(selected),
      ),
    ).toBeNull();
    expect(findShadowingWorkManifest(inventory, realpathSync(selected))).toBe(
      manifest,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cycle shadow probe scans configured inputs once and bounds/refreshes cwd memo entries", () => {
  let configuredCalls = 0;
  const cwdCalls: string[] = [];
  const probe = createWorkPluginShadowProbe({
    inventoryConfigured: () => {
      configuredCalls++;
      return [];
    },
    inventoryCwd: (cwd) => {
      cwdCalls.push(cwd);
      return [];
    },
    physicalize: (path) => path,
    maxCwdEntries: 2,
  });

  expect(probe("/selected", "/cwd-a")).toBeNull();
  expect(probe("/selected", "/cwd-a")).toBeNull(); // cache hit
  expect(probe("/selected", "/cwd-b")).toBeNull();
  expect(probe("/selected", "/cwd-c")).toBeNull(); // evicts cwd-a
  expect(probe("/selected", "/cwd-a")).toBeNull();
  expect(probe("/selected", "/cwd-a", { refreshCwd: true })).toBeNull();
  expect(configuredCalls).toBe(1);
  expect(cwdCalls).toEqual(["/cwd-a", "/cwd-b", "/cwd-c", "/cwd-a", "/cwd-a"]);
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
  // 'regenerate via render-plugin-templates' remediation prose.
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

  const stale = resolveWorkerCell(
    { pluginDir: "/abs/cell" },
    {
      dirExists: () => true,
      probeFreshness: () => ({ ok: false, detail: "hash-mismatch" }),
      probeShadow: () => null,
    },
  );
  expect(Object.keys(stale).sort()).toEqual([
    "detail",
    "kind",
    "ok",
    "pluginDir",
  ]);
  expect(JSON.stringify(stale)).not.toContain("keeper prompt compile");

  // The bad-matrix reject carries the state + the raw detail ONLY — never the
  // caller's 'keeper retry-dispatch' remediation framing.
  const bad = resolveWorkerCell(
    { pluginDir: null, matrixReject: { state: "absent", detail: "no matrix" } },
    neverProbe,
  );
  expect(Object.keys(bad).sort()).toEqual(["detail", "kind", "ok", "state"]);
  expect(JSON.stringify(bad)).not.toContain("retry-dispatch");
});

test("resolveWorkerCell result is a closed union an assertNever switch can exhaust", () => {
  // A compile-time contract exercised at runtime: every reject kind maps, and an
  // unmapped kind would fail `assertNever` at compile time (the parity net both
  // callers rely on). This asserts the runtime shape stays in lockstep.
  const kinds = new Set<string>();
  const classify = (r: WorkerCellResult): string => {
    if (r.ok) return "ok";
    switch (r.kind) {
      case "bad-matrix":
        return "bad-matrix";
      case "provider-pin-unknown":
        return "provider-pin-unknown";
      case "provider-reject":
        return "provider-reject";
      case "out-of-matrix":
        return "out-of-matrix";
      case "provider-unlaunchable":
        return "provider-unlaunchable";
      case "missing":
        return "missing";
      case "stale":
        return "stale";
      case "shadowed":
        return "shadowed";
      default:
        return ((x: never) => `unreachable:${String(x)}`)(r);
    }
  };
  const state: MatrixConfigState = "absent";
  const cases: WorkerCellCompose[] = [
    { pluginDir: "/c" }, // → ok
    { pluginDir: null }, // → ok (cell-less)
    { pluginDir: null, reject: "x" }, // → out-of-matrix
    { pluginDir: null, matrixReject: { state, detail: "d" } }, // → bad-matrix
    { pluginDir: null, providerPinReject: { detail: "banana" } }, // → provider-pin-unknown
    {
      pluginDir: null,
      providerReject: {
        reason: "no-map-entry",
        provider: "gpt",
        direction: "claude_to_gpt",
        assigned: { model: "opus", effort: "high" },
        target: null,
      },
    }, // → provider-reject
    {
      pluginDir: "/c",
      providerLaunchContract: {
        provider: "gpt",
        model: "opus",
        tier: "high",
        driver: "native",
        route: "native",
        wrappedCell: null,
      },
    }, // → provider-unlaunchable
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
        {
          dirExists: () => true,
          probeFreshness: () => ({ ok: false, detail: "hash-mismatch" }),
          probeShadow: () => null,
        },
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
    new Set([
      "ok",
      "out-of-matrix",
      "bad-matrix",
      "provider-pin-unknown",
      "provider-reject",
      "provider-unlaunchable",
      "missing",
      "stale",
      "shadowed",
    ]),
  );
});
