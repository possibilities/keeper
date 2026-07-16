/**
 * Unit tests for the `keeper handoff` dispatch worker (`src/handoff-worker.ts`).
 *
 * The headline coverage is the BOOT-RECOVERY decision table — the durable
 * `handoffs` projection survives a restart, so a phantom `dispatching` row must
 * NOT double-launch (the lease + bind check) yet a genuinely-lost one MUST
 * re-dispatch. Driven against the pure `decideHandoffAction` with synthetic rows
 * + an injected clock, NO real spawn. Plus the `dispatchOneHandoff` confirm path
 * (mint-before-launch, ack abort, permanent vs transient launch failure) with
 * injected deps, and `buildHandoffPrompt`.
 *
 * The `isMainThread` guard in the worker makes a plain `import` inert (no Worker,
 * no DB), so these symbols are reachable without booting the loop.
 */

import { expect, test } from "bun:test";
import { HANDOFF_DOC_MAX_BYTES } from "../cli/handoff";
import { PROMPT_MAX_BYTES } from "../src/dispatch-command";
import type { LaunchResult, LaunchSpec } from "../src/exec-backend";
import {
  buildHandoffPrompt,
  decideHandoffAction,
  dispatchOneHandoff,
  HANDOFF_CAPTURE_PROMPT_FRAMING,
  HANDOFF_LEASE_TTL_MS,
  type HandoffDispatchDeps,
  type HandoffDispatchingAck,
  type HandoffDispatchRow,
  type HandoffLaunchFailedPayload,
  NEVER_BOUND_HANDOFF_THRESHOLD,
  resolveHandoffLaunchConfig,
} from "../src/handoff-worker";

const NOW = 1_700_000_000_000; // unix ms

function row(over: Partial<HandoffDispatchRow>): HandoffDispatchRow {
  return {
    handoff_id: "h-1",
    status: "requested",
    doc: "brief",
    target_session: "work",
    target_dir: null,
    claimed_at: null,
    never_bound_count: 0,
    capture: 0,
    model: null,
    effort: null,
    preset: null,
    envelope_path: null,
    ...over,
  };
}

// ── decision table ──────────────────────────────────────────────────────────

test("a requested row dispatches", () => {
  const a = decideHandoffAction(row({ status: "requested" }), false, NOW);
  expect(a.kind).toBe("dispatch");
});

test("a bound handoff (bind exists) is skipped regardless of status", () => {
  // Even a stale `dispatching` row that has since bound must NOT re-dispatch —
  // the bind check is the authoritative 'already up' gate and fires first.
  const a = decideHandoffAction(
    row({ status: "dispatching", claimed_at: 1 }), // ancient lease
    true,
    NOW,
  );
  expect(a).toMatchObject({ kind: "skip", reason: "bound" });
});

test("a terminal failed row is skipped (sticky)", () => {
  const a = decideHandoffAction(row({ status: "failed" }), false, NOW);
  expect(a).toMatchObject({ kind: "skip", reason: "failed" });
});

test("a FRESH dispatching row (lease not expired) is left alone — no double-dispatch", () => {
  // claimed just now → lease has not expired → still booting.
  const claimedAtSec = NOW / 1000;
  const a = decideHandoffAction(
    row({ status: "dispatching", claimed_at: claimedAtSec }),
    false,
    NOW,
  );
  expect(a).toMatchObject({ kind: "skip", reason: "dispatching-fresh" });
});

test("a STALE dispatching row (lease expired, no bind) re-dispatches", () => {
  // claimed_at older than the lease TTL and never bound → presumed lost.
  const claimedAtSec = (NOW - HANDOFF_LEASE_TTL_MS - 1000) / 1000;
  const a = decideHandoffAction(
    row({ status: "dispatching", claimed_at: claimedAtSec }),
    false,
    NOW,
  );
  expect(a.kind).toBe("redispatch");
});

test("the lease boundary is inclusive — exactly TTL old re-dispatches", () => {
  const claimedAtSec = (NOW - HANDOFF_LEASE_TTL_MS) / 1000;
  const a = decideHandoffAction(
    row({ status: "dispatching", claimed_at: claimedAtSec }),
    false,
    NOW,
  );
  expect(a.kind).toBe("redispatch");
});

test("a dispatching row with a NULL claimed_at is treated as expired (can't wedge)", () => {
  const a = decideHandoffAction(
    row({ status: "dispatching", claimed_at: null }),
    false,
    NOW,
  );
  expect(a.kind).toBe("redispatch");
});

test("an unknown status is inert", () => {
  const a = decideHandoffAction(row({ status: "weird" }), false, NOW);
  expect(a.kind).toBe("skip");
});

// ── prompt composition ────────────────────────────────────────────────────

test("buildHandoffPrompt prepends the configured prefix + the framing + the inline brief", () => {
  const p = buildHandoffPrompt("investigate the flaky reaper", "/hack");
  expect(p.startsWith("/hack ")).toBe(true);
  // The brief rides INLINE — no `keeper handoff show` pointer round-trip.
  expect(p).toContain("investigate the flaky reaper");
  expect(p).not.toContain("keeper handoff show");
  // The framing frames the brief as the session's REQUEST, never an execute
  // order — an order would override `/hack`'s confirm-before-acting beat, which
  // is the whole behavior a handoff-ee must run. Regression guard.
  expect(p).not.toContain("carry it out");
  expect(p.toLowerCase()).toContain("request");
});

test("buildHandoffPrompt with no prefix is just the framing + the inline brief", () => {
  const p = buildHandoffPrompt("investigate the flaky reaper", undefined);
  expect(p.startsWith("/")).toBe(false);
  expect(p).toContain("investigate the flaky reaper");
  expect(p).not.toContain("keeper handoff show");
  // An empty-string prefix is treated as absent.
  expect(buildHandoffPrompt("investigate the flaky reaper", "")).toBe(p);
});

test("the coupled cap holds: both framings + a max-size 64KB brief fit under PROMPT_MAX_BYTES", () => {
  // The doc cap (64KB) and argv cap (96KB) are coupled: the full inline brief
  // rides the launch argv. Pin the longer autonomous capture framing too.
  const maxDoc = "x".repeat(HANDOFF_DOC_MAX_BYTES);
  for (const capture of [false, true]) {
    const prompt = buildHandoffPrompt(maxDoc, "/hack", capture);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(
      PROMPT_MAX_BYTES,
    );
  }
});

test("capture prompt is autonomous and instructs the handoff-ee to write one bounded nine-key envelope", () => {
  const prompt = buildHandoffPrompt("repair the flaky reaper", "/hack", true);
  expect(prompt).toBe(
    `/hack ${HANDOFF_CAPTURE_PROMPT_FRAMING}\n\nrepair the flaky reaper`,
  );
  expect(prompt).toContain("without parking for a confirm beat");
  expect(prompt).toContain("$KEEPER_HANDOFF_ENVELOPE");
  expect(prompt).toContain("exactly these keys: schema_version");
  expect(prompt).toContain("at or below 65536 bytes");
  expect(prompt).not.toContain("pre-approved order to execute");
});

// ── dispatchOneHandoff confirm path ─────────────────────────────────────────

interface Recorder {
  dispatching: number;
  launches: Array<{ session: string; cwd: string; spec: LaunchSpec }>;
  failed: HandoffLaunchFailedPayload[];
}

function makeDeps(over: Partial<HandoffDispatchDeps> & { rec?: Recorder }): {
  deps: HandoffDispatchDeps;
  rec: Recorder;
} {
  const rec: Recorder = over.rec ?? {
    dispatching: 0,
    launches: [],
    failed: [],
  };
  const deps: HandoffDispatchDeps = {
    emitDispatching: async (): Promise<HandoffDispatchingAck> => {
      rec.dispatching++;
      return { ok: true };
    },
    launch: async (session, cwd, spec): Promise<LaunchResult> => {
      rec.launches.push({ session, cwd, spec });
      return { ok: true };
    },
    emitLaunchFailed: (p): void => {
      rec.failed.push(p);
    },
    buildPrompt: (doc) => `/hack ${doc}`,
    // Default: no `dispatch.handoff` pin → flagless launch (the prior default).
    // Pin-carrying tests override this.
    resolveDispatchConfig: () => ({}),
    ...over,
  };
  return { deps, rec };
}

const noAbort = new AbortController().signal;

test("dispatchOneHandoff mints HandoffDispatching BEFORE launch with --name handoff::<id>", async () => {
  const order: string[] = [];
  const { deps } = makeDeps({
    emitDispatching: async () => {
      order.push("mint");
      return { ok: true };
    },
    launch: async (_s, _c, spec) => {
      order.push(`launch:${spec.claudeName}`);
      return { ok: true };
    },
  });
  const out = await dispatchOneHandoff(
    row({ handoff_id: "h-9", target_session: "work" }),
    "/repo",
    noAbort,
    deps,
  );
  expect(out).toBe("launched");
  // Mint strictly precedes launch (the outbox ordering), and the launch carries
  // the binding `--name handoff::<id>`.
  expect(order).toEqual(["mint", "launch:handoff::h-9"]);
});

test("dispatchOneHandoff launches into the row's target_session", async () => {
  const { deps, rec } = makeDeps({});
  await dispatchOneHandoff(
    row({ handoff_id: "h-10", target_session: "my-session" }),
    "/repo",
    noAbort,
    deps,
  );
  expect(rec.launches[0]?.session).toBe("my-session");
});

test("dispatchOneHandoff launches flagless when the dispatch.handoff pin is absent (ADR 0040)", async () => {
  const { deps, rec } = makeDeps({
    // The default `resolveDispatchConfig` returns {} (no pin).
  });
  await dispatchOneHandoff(
    row({ handoff_id: "h-noflag", target_session: "s" }),
    "/repo",
    noAbort,
    deps,
  );
  // No compiled default for handoff — an absent row means NO --model/--effort flags
  // (byte-identical to the prior flagless launch).
  expect(rec.launches[0]?.spec.model).toBeUndefined();
  expect(rec.launches[0]?.spec.effort).toBeUndefined();
});

test("dispatchOneHandoff carries the dispatch.handoff pin's model/effort onto the spec (ADR 0040)", async () => {
  const { deps, rec } = makeDeps({
    resolveDispatchConfig: () => ({ model: "opus", effort: "high" }),
  });
  await dispatchOneHandoff(
    row({ handoff_id: "h-pinned", target_session: "s" }),
    "/repo",
    noAbort,
    deps,
  );
  // A present row makes handoff pinnable — the resolved pair flows onto the spec.
  expect(rec.launches[0]?.spec.model).toBe("opus");
  expect(rec.launches[0]?.spec.effort).toBe("high");
});

test("a capture row launches with its requested triple, autonomous prompt, and envelope carrier", async () => {
  const { deps, rec } = makeDeps({
    buildPrompt: (doc, capture) =>
      capture ? `AUTONOMOUS ${doc}` : `PARK ${doc}`,
    resolveDispatchConfig: () => ({
      harness: "claude",
      model: "fallback",
      effort: "low",
    }),
  });
  const out = await dispatchOneHandoff(
    row({
      handoff_id: "h-capture",
      capture: 1,
      preset: "pi::gpt-5.4::high",
      envelope_path: "/durable/handoffs/h-capture.json",
    }),
    "/repo",
    noAbort,
    deps,
  );
  expect(out).toBe("launched");
  expect(rec.launches).toEqual([
    {
      session: "work",
      cwd: "/repo",
      spec: {
        prompt: "AUTONOMOUS brief",
        claudeName: "handoff::h-capture",
        harness: "pi",
        model: "gpt-5.4",
        effort: "high",
        handoffEnvelope: "/durable/handoffs/h-capture.json",
      },
    },
  ]);
});

test("a non-capture row's complete launch spec remains byte-identical", async () => {
  const { deps, rec } = makeDeps({
    buildPrompt: (doc, capture) => `${capture ? "UNEXPECTED" : "/hack"} ${doc}`,
    // The legacy dispatch path used model/effort but deliberately ignored a
    // harness pin; capture must not alter that default surface.
    resolveDispatchConfig: () => ({
      harness: "pi",
      model: "sonnet",
      effort: "high",
    }),
  });
  await dispatchOneHandoff(
    row({ handoff_id: "h-plain" }),
    "/repo",
    noAbort,
    deps,
  );
  expect(rec.launches).toEqual([
    {
      session: "work",
      cwd: "/repo",
      spec: {
        prompt: "/hack brief",
        claudeName: "handoff::h-plain",
        model: "sonnet",
        effort: "high",
      },
    },
  ]);
});

test("resolveHandoffLaunchConfig falls back safely for malformed or partial row overrides", () => {
  const dispatch = { harness: "claude", model: "sonnet", effort: "medium" };
  expect(
    resolveHandoffLaunchConfig(
      { preset: "not-a-triple", model: null, effort: null },
      dispatch,
    ),
  ).toEqual(dispatch);
  expect(
    resolveHandoffLaunchConfig(
      { preset: null, model: "opus", effort: null },
      dispatch,
    ),
  ).toEqual(dispatch);
  expect(
    resolveHandoffLaunchConfig(
      { preset: null, model: "opus", effort: "max" },
      dispatch,
    ),
  ).toEqual({ harness: "claude", model: "opus", effort: "max" });
});

test("dispatchOneHandoff uses the row's target_dir as the launch cwd (per-row wins over the global)", async () => {
  const { deps, rec } = makeDeps({});
  await dispatchOneHandoff(
    row({ handoff_id: "h-dir", target_dir: "/Users/dev/code/other" }),
    "/keeperd-cwd",
    noAbort,
    deps,
  );
  expect(rec.launches[0]?.cwd).toBe("/Users/dev/code/other");
});

test("dispatchOneHandoff falls back to the global cwd when target_dir is null or empty", async () => {
  const { deps, rec } = makeDeps({});
  await dispatchOneHandoff(
    row({ handoff_id: "h-null", target_dir: null }),
    "/keeperd-cwd",
    noAbort,
    deps,
  );
  await dispatchOneHandoff(
    row({ handoff_id: "h-empty", target_dir: "" }),
    "/keeperd-cwd",
    noAbort,
    deps,
  );
  expect(rec.launches[0]?.cwd).toBe("/keeperd-cwd");
  expect(rec.launches[1]?.cwd).toBe("/keeperd-cwd");
});

test("an ack {ok:false} aborts WITHOUT launching (no double-dispatch window)", async () => {
  const { deps, rec } = makeDeps({
    emitDispatching: async () => ({ ok: false }),
  });
  const out = await dispatchOneHandoff(row({}), "/repo", noAbort, deps);
  expect(out).toBe("aborted-prelaunch");
  expect(rec.launches.length).toBe(0);
});

test("an ack REJECT (timeout/shutdown) aborts WITHOUT launching", async () => {
  const { deps, rec } = makeDeps({
    emitDispatching: async () => {
      throw new Error("ack timeout");
    },
  });
  const out = await dispatchOneHandoff(row({}), "/repo", noAbort, deps);
  expect(out).toBe("aborted-prelaunch");
  expect(rec.launches.length).toBe(0);
});

test("a PERMANENT launch failure mints HandoffLaunchFailed", async () => {
  const { deps, rec } = makeDeps({
    launch: async (): Promise<LaunchResult> => ({
      ok: false,
      error: "keeper agent exit 3",
    }),
  });
  const out = await dispatchOneHandoff(
    row({ handoff_id: "h-11" }),
    "/repo",
    noAbort,
    deps,
  );
  expect(out).toBe("failed");
  expect(rec.failed).toEqual([
    { handoff_id: "h-11", reason: "keeper agent exit 3" },
  ]);
});

test("a TRANSIENT launch failure does NOT mint a terminal failure (lease re-dispatches)", async () => {
  const { deps, rec } = makeDeps({
    launch: async (): Promise<LaunchResult> => ({
      ok: false,
      error: "timeout-kill",
      retryable: true,
    }),
  });
  const out = await dispatchOneHandoff(row({}), "/repo", noAbort, deps);
  expect(out).toBe("failed");
  // The `dispatching` row stays put; the never-bound breaker bounds the retries.
  expect(rec.failed.length).toBe(0);
});

test("a thrown launch is treated as a PERMANENT failure", async () => {
  const { deps, rec } = makeDeps({
    launch: async (): Promise<LaunchResult> => {
      throw new Error("spawn blew up");
    },
  });
  const out = await dispatchOneHandoff(
    row({ handoff_id: "h-12" }),
    "/repo",
    noAbort,
    deps,
  );
  expect(out).toBe("failed");
  expect(rec.failed[0]?.handoff_id).toBe("h-12");
  expect(rec.failed[0]?.reason).toContain("launch threw");
});

test("a row with no target_session is a permanent failure, never launched", async () => {
  const { deps, rec } = makeDeps({});
  const out = await dispatchOneHandoff(
    row({ handoff_id: "h-13", target_session: null }),
    "/repo",
    noAbort,
    deps,
  );
  expect(out).toBe("invalid-target");
  expect(rec.launches.length).toBe(0);
  expect(rec.failed[0]?.handoff_id).toBe("h-13");
});

test("a pre-aborted signal skips the dispatch entirely", async () => {
  const ac = new AbortController();
  ac.abort();
  const { deps, rec } = makeDeps({});
  const out = await dispatchOneHandoff(row({}), "/repo", ac.signal, deps);
  expect(out).toBe("aborted-shutdown");
  expect(rec.dispatching).toBe(0);
  expect(rec.launches.length).toBe(0);
});

test("NEVER_BOUND_HANDOFF_THRESHOLD is K=3 (the breaker contract)", () => {
  // Pinned so the worker's decision-table comment + the fold agree on K.
  expect(NEVER_BOUND_HANDOFF_THRESHOLD).toBe(3);
});
