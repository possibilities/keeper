import { describe, expect, test } from "bun:test";
import type { RouteResolution, RouteSelection } from "../src/account-router";
import { main } from "../src/agent/main";
import {
  expectExit,
  makeHarness,
  runAndCapture,
} from "./helpers/agent-main-harness";

const CSWAP = "/fake-home/.local/bin/cswap";
const UUID = "11111111-1111-1111-1111-111111111111";

function selection(slot: number, accountOrdinal?: number): RouteSelection {
  return {
    id: `claude-swap:${slot}`,
    kind: "managed",
    slot,
    ...(accountOrdinal === undefined ? {} : { accountOrdinal }),
    reason: "selected",
  };
}

function managed(slot: number, accountOrdinal?: number): () => RouteResolution {
  return () => ({ ok: true, selection: selection(slot, accountOrdinal) });
}

describe("mandatory Claude account routing", () => {
  test("every successful launch uses cswap run --share-history", async () => {
    const h = makeHarness({
      argv: ["claude", "hello"],
      rawArgv: true,
      randomUuid: () => UUID,
      selectAccountRoute: managed(2),
    });
    const command = await runAndCapture(h, main);
    expect(command.slice(0, 5)).toEqual([
      CSWAP,
      "run",
      "2",
      "--share-history",
      "--",
    ]);
    expect(command.slice(5)).toContain("hello");
    expect(h.deps.env.KEEPER_ACCOUNT_ROUTE).toBe("claude-swap:2");
    expect(h.routerCalls()).toBe(1);
  });

  test("model, effort, session id, and prompt survive after the boundary", async () => {
    const h = makeHarness({
      argv: ["claude", "--model", "sonnet", "--effort", "xhigh", "task"],
      rawArgv: true,
      randomUuid: () => UUID,
      selectAccountRoute: managed(7),
    });
    const tail = (await runAndCapture(h, main)).slice(5);
    expect(tail).toContain("--model");
    expect(tail[tail.indexOf("--model") + 1]).toBe("sonnet");
    expect(tail).toContain("--session-id");
    expect(tail[tail.indexOf("--session-id") + 1]).toBe(UUID);
    expect(tail).toContain("task");
  });

  test("passes explicit and launch-triple models into account scoring", async () => {
    const explicitModels: Array<string | null> = [];
    const explicit = makeHarness({
      argv: ["claude", "--model=fable", "--effort", "high", "explicit task"],
      rawArgv: true,
      selectAccountRoute: (model) => {
        explicitModels.push(model);
        return { ok: true, selection: selection(4) };
      },
    });
    await runAndCapture(explicit, main);
    expect(explicitModels).toEqual(["fable"]);

    const presetModels: Array<string | null> = [];
    const preset = makeHarness({
      argv: ["claude", "--x-preset", "claude::fable::medium", "preset task"],
      rawArgv: true,
      selectAccountRoute: (model) => {
        presetModels.push(model);
        return { ok: true, selection: selection(5) };
      },
    });
    const command = await runAndCapture(preset, main);
    expect(presetModels).toEqual(["fable"]);
    expect(command[command.indexOf("--model") + 1]).toBe("fable");
  });

  test("automatic routing failure exits 1 before Claude starts", async () => {
    const h = makeHarness({
      argv: ["claude", "hello"],
      rawArgv: true,
      selectAccountRoute: () => ({
        ok: false,
        error: "no fresh routeable claude-swap account is available",
      }),
    });
    expect(await expectExit(main(h.deps))).toBe(1);
    expect(h.spawned).toEqual([]);
    expect(h.err.join("")).toContain("no fresh routeable claude-swap account");
  });

  test("route identity and display ordinal survive the same-account path", async () => {
    const h = makeHarness({
      argv: ["claude", "hello"],
      rawArgv: true,
      env: { KEEPER_ACCOUNT_ORDINAL: "99" },
      selectAccountRoute: managed(5, 1),
    });
    await runAndCapture(h, main);
    expect(h.deps.env.KEEPER_ACCOUNT_ROUTE).toBe("claude-swap:5");
    expect(h.deps.env.KEEPER_ACCOUNT_ORDINAL).toBe("1");
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});

describe("explicit account selection", () => {
  test("the selected active account is still wrapped as a managed route", async () => {
    const models: Array<string | null> = [];
    const h = makeHarness({
      argv: ["claude", "--x-account=0", "--model", "fable", "hello"],
      rawArgv: true,
      selectAccountRouteByOrdinal: (ordinal, model) => {
        models.push(model);
        return {
          ok: true,
          selection: selection(9, ordinal),
        };
      },
    });
    const command = await runAndCapture(h, main);
    expect(command.slice(0, 3)).toEqual([CSWAP, "run", "9"]);
    expect(h.requestedAccountOrdinals()).toEqual([0]);
    expect(models).toEqual(["fable"]);
    expect(h.routerCalls()).toBe(0);
    expect(h.deps.env.KEEPER_ACCOUNT_ROUTE).toBe("claude-swap:9");
  });

  test("an unresolved request exits 2 without substitution", async () => {
    const h = makeHarness({
      argv: ["claude", "--x-account", "c3", "hello"],
      rawArgv: true,
      selectAccountRouteByOrdinal: () => ({
        ok: false,
        error: "account c3 is out of range (available: c0-c1)",
      }),
    });
    expect(await expectExit(main(h.deps))).toBe(2);
    expect(h.spawned).toEqual([]);
    expect(h.routerCalls()).toBe(0);
  });
});

describe("selection remains independent per invocation", () => {
  test("a resume resolves and wraps its own managed route", async () => {
    const h = makeHarness({
      argv: ["claude", "--resume", UUID],
      rawArgv: true,
      selectAccountRoute: managed(3),
    });
    const command = await runAndCapture(h, main);
    expect(h.routerCalls()).toBe(1);
    expect(command.slice(0, 5)).toEqual([
      CSWAP,
      "run",
      "3",
      "--share-history",
      "--",
    ]);
    expect(command.slice(5)).toContain("--resume");
  });

  test("Pi launches never consult claude-swap routing", async () => {
    const h = makeHarness({ argv: ["pi", "hello"], rawArgv: true });
    const command = await runAndCapture(h, main);
    expect(command[0]).toBe("/fake-home/.local/bin/pi");
    expect(h.routerCalls()).toBe(0);
  });

  test("a Pi triple naming Fable still never consults Claude routing", async () => {
    const h = makeHarness({
      argv: ["pi", "--x-preset", "pi::fable::medium", "task"],
      rawArgv: true,
      selectAccountRoute: () => {
        throw new Error("Pi must not route through Claude accounts");
      },
    });
    const command = await runAndCapture(h, main);
    expect(command[0]).toBe("/fake-home/.local/bin/pi");
    expect(command[command.indexOf("--model") + 1]).toBe("fable");
    expect(h.routerCalls()).toBe(0);
  });
});

describe("keeper agent accounts check", () => {
  const inspection = {
    model_scope: null,
    health: "ok" as const,
    observed_at_ms: 1000,
    age_ms: 42,
    fresh: true,
    enabled: true,
    error: null,
    would_choose: {
      id: "claude-swap:2",
      kind: "managed" as const,
      slot: 2,
      reason: "selected",
    },
    candidates: [
      {
        id: "claude-swap:2",
        kind: "managed" as const,
        slot: 2,
        worst_utilization: 0.2,
        fable_remaining: 0.4,
      },
    ],
  };

  test("--json emits the read-only snapshot", async () => {
    const h = makeHarness({
      argv: ["accounts", "check", "--json"],
      rawArgv: true,
      inspectRouting: () => inspection,
      selectAccountRoute: () => {
        throw new Error("accounts check must not reserve");
      },
    });
    expect(await expectExit(main(h.deps))).toBe(0);
    expect(h.routerCalls()).toBe(0);
    expect(h.spawned).toEqual([]);
    expect(JSON.parse(h.out.join(""))).toEqual(inspection);
  });

  test("disabled human output reports unavailable without a fake default", async () => {
    const h = makeHarness({
      argv: ["accounts", "check"],
      rawArgv: true,
      inspectRouting: () => ({
        model_scope: null,
        health: "no-observation",
        observed_at_ms: null,
        age_ms: null,
        fresh: false,
        enabled: false,
        error: "no claude-swap account inventory is available",
        would_choose: null,
        candidates: [],
      }),
    });
    expect(await expectExit(main(h.deps))).toBe(0);
    expect(h.out.join("")).toContain("model-scope=generic-only");
    expect(h.out.join("")).toContain("would choose: unavailable");
  });
});
