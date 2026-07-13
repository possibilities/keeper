import { expect, test } from "bun:test";
import {
  AWAIT_LEASE_TTL_MS,
  type AwaitDispatchDeps,
  type AwaitDispatchRow,
  decideAwaitAction,
  dispatchOneAwait,
  NEVER_BOUND_AWAIT_THRESHOLD,
} from "../src/await-worker";
import type { LaunchResult } from "../src/exec-backend";

const NOW = 1_700_000_000_000;

function row(over: Partial<AwaitDispatchRow> = {}): AwaitDispatchRow {
  return {
    await_id: "await-1",
    condition_spec: JSON.stringify([{ condition: "landed", target: "fn-1" }]),
    follow_up: "continue after landing",
    target_session: "work",
    target_dir: null,
    timeout_at: null,
    status: "waiting",
    claimed_at: null,
    attempt_count: 0,
    never_bound_count: 0,
    ...over,
  };
}

test("waiting rows are never leased; a met condition claims firing", () => {
  expect(decideAwaitAction(row(), "waiting", NOW)).toMatchObject({
    kind: "skip",
    reason: "condition-waiting",
  });
  expect(decideAwaitAction(row(), "met", NOW)).toMatchObject({ kind: "fire" });
});

test("only firing leases reclaim after expiry", () => {
  const fresh = decideAwaitAction(
    row({ status: "firing", claimed_at: NOW / 1000 }),
    "waiting",
    NOW,
  );
  expect(fresh).toMatchObject({ kind: "skip", reason: "firing-fresh" });
  const reclaimed = decideAwaitAction(
    row({
      status: "firing",
      claimed_at: (NOW - AWAIT_LEASE_TTL_MS) / 1000,
    }),
    "waiting",
    NOW,
  );
  expect(reclaimed).toMatchObject({ kind: "refire" });
});

test("a bound firing intent completes instead of re-firing its stable effect", () => {
  expect(
    decideAwaitAction(
      row({ status: "firing", claimed_at: 1 }),
      "waiting",
      NOW,
      true,
    ),
  ).toMatchObject({ kind: "done" });
});

test("the never-bound breaker terminalizes instead of retrying forever", () => {
  const action = decideAwaitAction(
    row({
      status: "firing",
      never_bound_count: NEVER_BOUND_AWAIT_THRESHOLD,
      claimed_at: 1,
    }),
    "waiting",
    NOW,
  );
  expect(action).toMatchObject({
    kind: "failed",
    reason: "durable await never-bound breaker tripped",
  });
});

test("timeout before a met condition is terminal", () => {
  expect(
    decideAwaitAction(row({ timeout_at: (NOW - 1) / 1000 }), "waiting", NOW),
  ).toMatchObject({ kind: "timed_out" });
});

test("an unknown condition terminal-fails without a retry loop", () => {
  expect(decideAwaitAction(row(), "unknown", NOW)).toMatchObject({
    kind: "failed",
    reason: "unknown durable await condition",
  });
});

test("redelivery has one idempotent effect identity", async () => {
  const effects = new Set<string>();
  const launchNames: string[] = [];
  const terminals: string[] = [];
  const deps: AwaitDispatchDeps = {
    emitFiring: async () => ({ ok: true }),
    emitTerminal: (kind) => terminals.push(kind),
    launch: async (_session, _cwd, spec): Promise<LaunchResult> => {
      const name = spec.claudeName ?? "";
      launchNames.push(name);
      effects.add(name); // launcher-side idempotency is keyed by the stable intent id.
      return { ok: true };
    },
  };
  const signal = new AbortController().signal;
  await dispatchOneAwait(row({ await_id: "a-stable" }), "/repo", signal, deps);
  await dispatchOneAwait(
    row({ status: "firing", await_id: "a-stable", claimed_at: 1 }),
    "/repo",
    signal,
    deps,
  );

  expect(launchNames).toEqual(["await::a-stable", "await::a-stable"]);
  expect([...effects]).toEqual(["await::a-stable"]);
  expect(terminals).toEqual(["done", "done"]);
});

test("firing is durably acknowledged before the fresh launch", async () => {
  const order: string[] = [];
  const deps: AwaitDispatchDeps = {
    emitFiring: async () => {
      order.push("firing");
      return { ok: true };
    },
    emitTerminal: () => {},
    launch: async (_session, _cwd, spec): Promise<LaunchResult> => {
      order.push(`launch:${spec.claudeName}`);
      return { ok: true };
    },
  };
  await dispatchOneAwait(
    row({ await_id: "a-ack" }),
    "/repo",
    new AbortController().signal,
    deps,
  );
  expect(order).toEqual(["firing", "launch:await::a-ack"]);
});
