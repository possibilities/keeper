import { expect, test } from "bun:test";
import type { BackupResult } from "../src/backup";
import {
  type MaintenanceMessage,
  runBackupPass,
  runPanelCleanupPass,
  runProbePass,
} from "../src/maintenance-worker";

const success: BackupResult = {
  snapshotPath: "/backups/keeper.db",
  verified: true,
  bytes: 42,
  pruned: [],
  cleanupFailures: [],
  error: null,
};

test("runBackupPass relays the injected storage outcome", () => {
  const messages: MaintenanceMessage[] = [];
  const paths: string[] = [];
  runBackupPass(
    "/state/keeper.db",
    (message) => messages.push(message),
    () => false,
    (path) => {
      paths.push(path);
      return success;
    },
  );
  expect(paths).toEqual(["/state/keeper.db"]);
  expect(messages).toEqual([{ kind: "backup-result", result: success }]);
});

test("runBackupPass converts an injected throw into a failure relay", () => {
  const messages: MaintenanceMessage[] = [];
  expect(() =>
    runBackupPass(
      "/state/keeper.db",
      (message) => messages.push(message),
      () => false,
      () => {
        throw new Error("storage unavailable");
      },
    ),
  ).not.toThrow();
  expect(messages).toEqual([
    {
      kind: "backup-result",
      result: {
        snapshotPath: null,
        verified: false,
        bytes: 0,
        pruned: [],
        cleanupFailures: [],
        error: "storage unavailable",
      },
    },
  ]);
});

test("runBackupPass shutdown gate avoids touching storage", () => {
  const messages: MaintenanceMessage[] = [];
  runBackupPass(
    "/state/keeper.db",
    (message) => messages.push(message),
    () => true,
    () => {
      throw new Error("must not execute");
    },
  );
  expect(messages).toEqual([]);
});

test("runProbePass is silent for an injected healthy verdict", () => {
  const messages: MaintenanceMessage[] = [];
  runProbePass(
    "/state/keeper.db",
    (message) => messages.push(message),
    () => false,
    () => ["ok"],
  );
  expect(messages).toEqual([]);
});

test("runProbePass relays log and page for injected corruption", () => {
  const messages: MaintenanceMessage[] = [];
  runProbePass(
    "/state/keeper.db",
    (message) => messages.push(message),
    () => false,
    () => ["Page 7: malformed"],
  );
  expect(messages.map((message) => message.kind)).toEqual([
    "maintenance-log",
    "maintenance-page",
  ]);
});

test("runProbePass shutdown gate avoids touching storage", () => {
  const messages: MaintenanceMessage[] = [];
  runProbePass(
    "/state/keeper.db",
    (message) => messages.push(message),
    () => true,
    () => {
      throw new Error("must not execute");
    },
  );
  expect(messages).toEqual([]);
});

test("runPanelCleanupPass relays settled runs and isolates persistent errors", async () => {
  const messages: MaintenanceMessage[] = [];
  await runPanelCleanupPass(
    (message) => messages.push(message),
    () => false,
    {} as never,
    async () => ({
      root: "/state/panels",
      settled: ["/state/panels/a"],
      unresolved: [{ dir: "/state/panels/b", identities: ["x#1"] }],
      skipped: [],
      errors: [{ dir: "/state/panels/c", error: "read-only" }],
    }),
  );
  expect(messages).toHaveLength(2);
  expect(messages.map((message) => message.kind)).toEqual([
    "maintenance-log",
    "maintenance-log",
  ]);
  expect(
    messages.every(
      (message) =>
        message.kind !== "maintenance-log" || !message.message.includes("x#1"),
    ),
  ).toBe(true);
});

test("runPanelCleanupPass catches a pass failure so other maintenance survives", async () => {
  const messages: MaintenanceMessage[] = [];
  await expect(
    runPanelCleanupPass(
      (message) => messages.push(message),
      () => false,
      {} as never,
      async () => {
        throw new Error("panels unavailable");
      },
    ),
  ).resolves.toBeUndefined();
  expect(messages).toEqual([
    {
      kind: "maintenance-log",
      message: "[panel-cleanup] pass failed: panels unavailable",
    },
  ]);
});

test("runPanelCleanupPass shutdown gate avoids discovery", async () => {
  let executed = false;
  await runPanelCleanupPass(
    () => {},
    () => true,
    {} as never,
    async () => {
      executed = true;
      throw new Error("must not execute");
    },
  );
  expect(executed).toBe(false);
});

test("plain import on the main thread is inert", async () => {
  const module = await import("../src/maintenance-worker");
  expect(typeof module.runBackupPass).toBe("function");
  expect(typeof module.runProbePass).toBe("function");
});
