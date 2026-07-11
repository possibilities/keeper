/**
 * Account routing at the Claude process boundary (`src/agent/main.ts`): the
 * router is the single decision for every unpinned Claude start / resume /
 * restore. A native decision preserves the built Claude argv byte-for-byte and
 * sets only the PII-free route carrier; a managed decision wraps that same argv
 * in the public `cswap run <slot> --share-history -- <argv…>` contract. Also
 * covers the `accounts check` read-only diagnostic and the `inspectRouting`
 * read-only snapshot (no reservation written).
 *
 * Everything runs through injected seams — the account router, the cswap bin,
 * and the spawn recorder — so no real claude-swap / Claude / tmux / subprocess /
 * observation sidecar is touched by the fast suite (the `inspectRouting` unit
 * pins a sidecar under a per-test tmpdir and asserts no ledger is written).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type NormalizedWindow,
  type Observation,
  type Route,
  writeObservationSidecar,
} from "../src/account-observation";
import type { RouteSelection } from "../src/account-router";
import { inspectRouting } from "../src/account-router";
import {
  NATIVE_ROUTE_ID,
  observationSidecarPath,
} from "../src/account-routing-config";
import { main } from "../src/agent/main";
import {
  expectExit,
  makeHarness,
  runAndCapture,
} from "./helpers/agent-main-harness";

const CSWAP = "/fake-home/.local/bin/cswap";
const UUID = "11111111-1111-1111-1111-111111111111";

/** A managed route selection for `slot`. */
function managed(slot: number): () => RouteSelection {
  return () => ({
    id: `claude-swap:${slot}`,
    kind: "managed",
    slot,
    reason: "selected",
  });
}

/** A native route selection (the fail-open default). */
function native(): () => RouteSelection {
  return () => ({
    id: NATIVE_ROUTE_ID,
    kind: "native",
    slot: null,
    reason: "no-observation",
  });
}

// ---------------------------------------------------------------------------
// managed wrap composition
// ---------------------------------------------------------------------------

describe("Claude managed route wraps the built argv in the cswap contract", () => {
  test("a managed route wraps native args after `run <slot> --share-history --`", async () => {
    const nativeH = makeHarness({
      argv: ["claude", "hello"],
      rawArgv: true,
      randomUuid: () => UUID,
      selectAccountRoute: native(),
    });
    const nativeCmd = await runAndCapture(nativeH, main);

    const managedH = makeHarness({
      argv: ["claude", "hello"],
      rawArgv: true,
      randomUuid: () => UUID,
      selectAccountRoute: managed(2),
    });
    const managedCmd = await runAndCapture(managedH, main);

    // The wrapper drops the native claude executable (cswap resolves `claude`
    // from PATH) and forwards every native ARGUMENT byte-for-byte after `--`.
    expect(managedCmd).toEqual([
      CSWAP,
      "run",
      "2",
      "--share-history",
      "--",
      ...nativeCmd.slice(1),
    ]);
    // Byte-for-byte: the forwarded tail is exactly the native args, unreordered.
    expect(managedCmd.slice(5)).toEqual(nativeCmd.slice(1));
  });

  test("a managed route carries the PII-free route id and sets no CLAUDE_CONFIG_DIR", async () => {
    const h = makeHarness({
      argv: ["claude", "hello"],
      rawArgv: true,
      env: {},
      randomUuid: () => UUID,
      selectAccountRoute: managed(5),
    });
    await runAndCapture(h, main);
    // The same-account fast path relies on keeper NOT presetting CLAUDE_CONFIG_DIR.
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(h.deps.env.KEEPER_ACCOUNT_ROUTE).toBe("claude-swap:5");
  });

  test("managed preserves model/effort/session-id/name after the -- boundary", async () => {
    const nativeH = makeHarness({
      argv: ["claude", "--model", "sonnet", "--effort", "xhigh", "task"],
      rawArgv: true,
      randomUuid: () => UUID,
      selectAccountRoute: native(),
    });
    const nativeCmd = await runAndCapture(nativeH, main);

    const managedH = makeHarness({
      argv: ["claude", "--model", "sonnet", "--effort", "xhigh", "task"],
      rawArgv: true,
      randomUuid: () => UUID,
      selectAccountRoute: managed(7),
    });
    const managedCmd = await runAndCapture(managedH, main);

    const tail = managedCmd.slice(5);
    expect(tail).toEqual(nativeCmd.slice(1));
    expect(tail).toContain("--model");
    expect(tail[tail.indexOf("--model") + 1]).toBe("sonnet");
    expect(tail).toContain("--session-id");
    expect(tail[tail.indexOf("--session-id") + 1]).toBe(UUID);
  });
});

// ---------------------------------------------------------------------------
// native fallback preserves the launch
// ---------------------------------------------------------------------------

describe("Claude native route preserves the launch and carries the route id", () => {
  test("a native route runs Claude directly and sets the carrier", async () => {
    const h = makeHarness({
      argv: ["claude", "hello"],
      rawArgv: true,
      env: {},
      randomUuid: () => UUID,
      selectAccountRoute: native(),
    });
    const cmd = await runAndCapture(h, main);
    // First token is the resolved claude bin — no cswap wrap.
    expect(cmd[0]).toBe("/fake-home/.local/bin/claude");
    expect(cmd).not.toContain("run");
    expect(h.deps.env.KEEPER_ACCOUNT_ROUTE).toBe("default");
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// independence across fresh / resume / restore
// ---------------------------------------------------------------------------

describe("route selection is independent per launch", () => {
  test("a fresh launch resolves exactly one route", async () => {
    const h = makeHarness({
      argv: ["claude", "hello"],
      rawArgv: true,
      selectAccountRoute: native(),
    });
    await runAndCapture(h, main);
    expect(h.routerCalls()).toBe(1);
  });

  test("a resume launch resolves its own route (no prior attribution input)", async () => {
    // The router seam takes NO conversation/attribution argument, so a resume
    // cannot feed a prior route back into selection — it re-resolves cold.
    const h = makeHarness({
      argv: ["claude", "--resume", UUID],
      rawArgv: true,
      selectAccountRoute: native(),
    });
    await runAndCapture(h, main);
    expect(h.routerCalls()).toBe(1);
  });

  test("a managed resume preserves the resume argv after --", async () => {
    const h = makeHarness({
      argv: ["claude", "--resume", UUID],
      rawArgv: true,
      selectAccountRoute: managed(3),
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd.slice(0, 5)).toEqual([
      CSWAP,
      "run",
      "3",
      "--share-history",
      "--",
    ]);
    const tail = cmd.slice(5);
    expect(tail).toContain("--resume");
    expect(tail[tail.indexOf("--resume") + 1]).toBe(UUID);
  });
});

// ---------------------------------------------------------------------------
// override + non-claude fallthrough
// ---------------------------------------------------------------------------

describe("routing is confined to unpinned Claude launches", () => {
  test("an explicit --x-profile is an operator override, not routed", async () => {
    const h = makeHarness({
      argv: ["claude", "--x-profile", "multi-claude-1", "hello"],
      rawArgv: true,
      profileDir: "/fake-home/.claude-profiles/multi-claude-1",
      selectAccountRoute: () => {
        throw new Error("router must not run for an explicit profile");
      },
    });
    const cmd = await runAndCapture(h, main);
    expect(h.routerCalls()).toBe(0);
    expect(cmd[0]).toBe("/fake-home/.local/bin/claude");
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBe(
      "/fake-home/.claude-profiles/multi-claude-1",
    );
  });

  test("a codex launch is never routed", async () => {
    const h = makeHarness({
      argv: ["hello"],
      agent: "codex",
      selectAccountRoute: () => {
        throw new Error("router must not run for a non-claude harness");
      },
    });
    await runAndCapture(h, main);
    expect(h.routerCalls()).toBe(0);
    expect(h.deps.env.KEEPER_ACCOUNT_ROUTE).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// `accounts check` read-only diagnostic
// ---------------------------------------------------------------------------

describe("keeper agent accounts check", () => {
  const inspection = {
    health: "ok" as const,
    observed_at_ms: 1000,
    age_ms: 42,
    fresh: true,
    enabled: true,
    would_choose: {
      id: "claude-swap:2",
      kind: "managed" as const,
      slot: 2,
      reason: "selected",
    },
    candidates: [
      {
        id: "default",
        kind: "native" as const,
        slot: null,
        worst_utilization: 0.8,
      },
      {
        id: "claude-swap:2",
        kind: "managed" as const,
        slot: 2,
        worst_utilization: 0.2,
      },
    ],
  };

  test("--json emits the inspection snapshot and reserves nothing", async () => {
    const h = makeHarness({
      argv: ["accounts", "check", "--json"],
      rawArgv: true,
      inspectRouting: () => inspection,
      selectAccountRoute: () => {
        throw new Error("accounts check must never reserve a route");
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    // Read-only: the reserving router seam was never touched.
    expect(h.routerCalls()).toBe(0);
    expect(h.spawned.length).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual(inspection);
  });

  test("without --json prints a human summary and exits 0", async () => {
    const h = makeHarness({
      argv: ["accounts", "check"],
      rawArgv: true,
      inspectRouting: () => inspection,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const text = h.out.join("");
    expect(text).toContain("account routing:");
    expect(text).toContain("would choose: claude-swap:2");
    expect(text).toContain("claude-swap:2 [managed]");
  });
});

// ---------------------------------------------------------------------------
// inspectRouting — read-only snapshot over a real sidecar fixture
// ---------------------------------------------------------------------------

function win(
  key: string,
  utilization: number,
  resetsAt: string | null = null,
): NormalizedWindow {
  return { key, utilization, resetsAt };
}

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function seed(stateDir: string, routes: Route[]): void {
  const obs: Observation = {
    schema_version: 1,
    observed_at_ms: NOW,
    health: "ok",
    routes,
    notes: [],
  };
  writeObservationSidecar(observationSidecarPath(stateDir), obs);
}

describe("inspectRouting is read-only", () => {
  test("reports the route the policy would pick without writing a ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-inspect-"));
    try {
      seed(dir, [
        {
          id: NATIVE_ROUTE_ID,
          kind: "native",
          slot: null,
          windows: [win("session", 0.8)],
          measuredAtMs: NOW,
        },
        {
          id: "claude-swap:2",
          kind: "managed",
          slot: 2,
          windows: [win("session", 0.2)],
          measuredAtMs: NOW,
        },
      ]);
      const result = inspectRouting({ stateDir: dir, nowMs: NOW });
      expect(result.health).toBe("ok");
      expect(result.enabled).toBe(true);
      // Greatest worst-window headroom: 0.2 < 0.8 → the managed slot wins.
      expect(result.would_choose.id).toBe("claude-swap:2");
      expect(result.would_choose.kind).toBe("managed");
      expect(result.would_choose.slot).toBe(2);
      expect(result.candidates.map((c) => c.id).sort()).toEqual([
        "claude-swap:2",
        "default",
      ]);
      // Read-only: no reservation ledger was created.
      expect(readdirSync(dir)).not.toContain("reservations.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no observation → disabled native snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-inspect-"));
    try {
      const result = inspectRouting({ stateDir: dir, nowMs: NOW });
      expect(result.health).toBe("no-observation");
      expect(result.enabled).toBe(false);
      expect(result.would_choose.id).toBe(NATIVE_ROUTE_ID);
      expect(result.candidates).toEqual([]);
      expect(readdirSync(dir)).not.toContain("reservations.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
