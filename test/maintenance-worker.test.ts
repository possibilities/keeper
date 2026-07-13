import { expect, test } from "bun:test";
import type { BackupResult } from "../src/backup";
import {
  type MaintenanceMessage,
  runBackupPass,
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

test("plain import on the main thread is inert", async () => {
  const module = await import("../src/maintenance-worker");
  expect(typeof module.runBackupPass).toBe("function");
  expect(typeof module.runProbePass).toBe("function");
});
