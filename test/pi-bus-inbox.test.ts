import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  BUS_WATCH_COMMAND,
  type BusWatchChild,
  claimBusInboxOwnership,
  PiBusInboxController,
  parseBusWatchRecord,
  releaseBusInboxOwnership,
} from "../plugins/keeper/pi-extension/bus-inbox";

class FakeReadable extends EventEmitter {
  resumed = false;

  resume(): void {
    this.resumed = true;
  }
}

class FakeChild extends EventEmitter implements BusWatchChild {
  pid = 4242;
  exitCode: number | null = null;
  stdout = new FakeReadable();
  stderr = new FakeReadable();
  ended = false;
  signals: NodeJS.Signals[] = [];
  closeOnEnd = false;

  stdin = {
    end: (): void => {
      this.ended = true;
      if (this.closeOnEnd) {
        this.exitCode = 0;
        this.emit("close", 0);
      }
    },
  };

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    return true;
  }
}

function immediateTimer(
  callback: (...args: unknown[]) => void,
  _ms?: number,
): ReturnType<typeof setTimeout> {
  queueMicrotask(callback);
  return 1 as unknown as ReturnType<typeof setTimeout>;
}

describe("PiBusInboxController", () => {
  test("starts once, drains stderr, parses split records, and reports ambient presence", () => {
    const child = new FakeChild();
    let spawns = 0;
    const delivered: string[] = [];
    const controller = new PiBusInboxController({
      deliver: (line) => delivered.push(line),
      spawn: () => {
        spawns += 1;
        return child;
      },
    });

    controller.start();
    controller.start();
    expect(spawns).toBe(1);
    expect(child.stderr.resumed).toBe(true);
    expect(controller.ambientTask()).toEqual({
      id: "pi-bus-4242",
      type: "shell",
      command: BUS_WATCH_COMMAND,
      description: "keeper agent bus",
    });

    child.stdout.emit(
      "data",
      Buffer.from('{"type":"agent_bus_message","line":"hello'),
    );
    child.stdout.emit("data", Buffer.from(' world"}\n'));
    child.stdout.emit("data", Buffer.from("not-json\n"));
    expect(delivered).toEqual(["hello world"]);
  });

  test("unexpected child error clears presence and schedules a bounded restart", async () => {
    const first = new FakeChild();
    const second = new FakeChild();
    second.closeOnEnd = true;
    const children = [first, second];
    const controller = new PiBusInboxController({
      deliver() {},
      spawn: () => children.shift() ?? second,
      setTimer: immediateTimer as typeof setTimeout,
      clearTimer: (() => {}) as typeof clearTimeout,
    });
    controller.start();
    first.emit("error", new Error("watcher crashed"));
    expect(controller.ambientTask()).toBeNull();
    await Promise.resolve();
    expect(controller.ambientTask()?.id).toBe("pi-bus-4242");
    await controller.stop();
  });

  test("drops an oversized physical record through its newline boundary", () => {
    const child = new FakeChild();
    const delivered: string[] = [];
    const controller = new PiBusInboxController({
      deliver: (line) => delivered.push(line),
      spawn: () => child,
    });
    controller.start();
    child.stdout.emit("data", Buffer.from("x".repeat(9_000)));
    child.stdout.emit(
      "data",
      Buffer.from(
        '{"type":"agent_bus_message","line":"suffix"}\n' +
          '{"type":"agent_bus_message","line":"next"}\n',
      ),
    );
    expect(delivered).toEqual(["next"]);
  });

  test("stop invalidates late output and closes the stdin lifetime lease", async () => {
    const child = new FakeChild();
    child.closeOnEnd = true;
    const delivered: string[] = [];
    const controller = new PiBusInboxController({
      deliver: (line) => delivered.push(line),
      spawn: () => child,
    });
    controller.start();

    await controller.stop();
    expect(child.ended).toBe(true);
    expect(controller.ambientTask()).toBeNull();
    child.stdout.emit(
      "data",
      Buffer.from('{"type":"agent_bus_message","line":"late"}\n'),
    );
    expect(delivered).toEqual([]);
  });

  test("stop escalates through TERM and KILL when EOF does not close", async () => {
    const child = new FakeChild();
    const controller = new PiBusInboxController({
      deliver() {},
      spawn: () => child,
      setTimer: immediateTimer as typeof setTimeout,
      clearTimer: (() => {}) as typeof clearTimeout,
    });
    controller.start();

    await controller.stop();
    expect(child.ended).toBe(true);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("spawn failure degrades to no ambient task", () => {
    const controller = new PiBusInboxController({
      deliver() {},
      spawn: () => {
        throw new Error("missing keeper");
      },
    });
    expect(() => controller.start()).not.toThrow();
    expect(controller.ambientTask()).toBeNull();
  });
});

describe("process-global inbox ownership", () => {
  test("one top-level runtime owns the watcher while nested runtimes stand down", () => {
    const top = {};
    const nested = {};
    expect(claimBusInboxOwnership(top)).toBe(true);
    expect(claimBusInboxOwnership(nested)).toBe(false);
    releaseBusInboxOwnership(nested);
    expect(claimBusInboxOwnership(nested)).toBe(false);
    releaseBusInboxOwnership(top);
    expect(claimBusInboxOwnership(nested)).toBe(true);
    releaseBusInboxOwnership(nested);
  });

  test("double-claiming the SAME token is idempotent (returns the existing ownership, not a rejection)", () => {
    const token = {};
    expect(claimBusInboxOwnership(token)).toBe(true);
    // A second claim from the identical holder is a no-op re-affirmation, not
    // a distinct owner colliding with itself.
    expect(claimBusInboxOwnership(token)).toBe(true);
    expect(claimBusInboxOwnership(token)).toBe(true);
    releaseBusInboxOwnership(token);
  });

  test("release then re-claim of the same identity succeeds", () => {
    const token = {};
    expect(claimBusInboxOwnership(token)).toBe(true);
    releaseBusInboxOwnership(token);
    // The lease is fully vacated — the same token may claim it fresh.
    expect(claimBusInboxOwnership(token)).toBe(true);
    releaseBusInboxOwnership(token);
  });
});

describe("parseBusWatchRecord", () => {
  test("accepts only bounded Agent Bus message records", () => {
    expect(
      parseBusWatchRecord(
        JSON.stringify({ type: "agent_bus_message", line: "hello" }),
      ),
    ).toBe("hello");
    expect(
      parseBusWatchRecord(JSON.stringify({ type: "other", line: "x" })),
    ).toBeNull();
    expect(parseBusWatchRecord("{")).toBeNull();
    expect(
      parseBusWatchRecord(
        JSON.stringify({
          type: "agent_bus_message",
          line: "x".repeat(9_000),
        }),
      ),
    ).toBeNull();
  });

  test("passes a file-backed read notification without exposing body content", () => {
    const line =
      "Agent Bus message from alice — read /trusted/bus-artifacts/00000000000000000000000000000001";
    const record = JSON.stringify({ type: "agent_bus_message", line });
    expect(parseBusWatchRecord(record)).toBe(line);
    expect(record).not.toContain("private message body");
  });
});
