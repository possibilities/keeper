import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  createMonitorFacadeTool,
  MONITOR_BATCH_WINDOW_MS,
  MONITOR_DEFAULT_TIMEOUT_MS,
  MONITOR_MAX_TIMEOUT_MS,
  MONITOR_MIN_TIMEOUT_MS,
  MONITOR_PARAMETERS,
  type MonitorArtifact,
  type MonitorChild,
  type MonitorClock,
  type MonitorLineBatch,
  type MonitorSpawnOptions,
  type MonitorTerminalOutcome,
  PiMonitorController,
  resolveMonitorParams,
} from "../plugins/keeper/pi-extension/monitor-facade";

class FakeReadable extends EventEmitter {}

class FakeChild extends EventEmitter implements MonitorChild {
  pid: number;
  exitCode: number | null = null;
  stdout = new FakeReadable();
  stderr = new FakeReadable();
  signals: NodeJS.Signals[] = [];
  exitOnSignal: NodeJS.Signals | null = "SIGTERM";

  constructor(pid = 4100) {
    super();
    this.pid = pid;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signal(signal);
    return true;
  }

  signal(signal: NodeJS.Signals): void {
    this.signals.push(signal);
    if (this.exitOnSignal === signal) this.close(null, signal);
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? (signal === null ? 0 : 128);
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

interface TimerRecord {
  callback: () => void;
  timeoutMs: number;
  cleared: boolean;
}

class FakeClock implements MonitorClock {
  readonly timers: TimerRecord[] = [];

  setTimer(callback: () => void, timeoutMs: number): TimerRecord {
    const timer = { callback, timeoutMs, cleared: false };
    this.timers.push(timer);
    return timer;
  }

  clearTimer(handle: unknown): void {
    (handle as TimerRecord).cleared = true;
  }

  pending(timeoutMs?: number): TimerRecord[] {
    return this.timers.filter(
      (timer) =>
        !timer.cleared &&
        (timeoutMs === undefined || timer.timeoutMs === timeoutMs),
    );
  }

  run(timer: TimerRecord): void {
    if (timer.cleared) return;
    timer.cleared = true;
    timer.callback();
  }

  runDelay(timeoutMs: number): void {
    const timer = this.pending(timeoutMs)[0];
    if (timer === undefined) throw new Error(`no ${timeoutMs}ms timer`);
    this.run(timer);
  }
}

class FakeArtifact implements MonitorArtifact {
  readonly writes: Array<{
    stream: "stdout" | "stderr";
    chunk: Buffer;
  }> = [];
  closed = false;

  constructor(readonly path: string) {}

  write(stream: "stdout" | "stderr", chunk: Uint8Array): void {
    if (this.closed) throw new Error("closed artifact");
    this.writes.push({ stream, chunk: Buffer.from(chunk) });
  }

  close(): void {
    this.closed = true;
  }
}

interface HarnessOptions {
  ids?: string[];
  children?: FakeChild[];
  clock?: FakeClock;
  maxLineChars?: number;
  maxQueuedLines?: number;
  suppressionBudget?: number;
}

function harness(options: HarnessOptions = {}) {
  const ids = [...(options.ids ?? ["monitor-1"])];
  const children = [...(options.children ?? [new FakeChild()])];
  const clock = options.clock ?? new FakeClock();
  const batches: MonitorLineBatch[] = [];
  const terminals: MonitorTerminalOutcome[] = [];
  const artifacts: FakeArtifact[] = [];
  const spawns: Array<{ command: string; options: MonitorSpawnOptions }> = [];
  const deliveryOrder: string[] = [];
  const env = { PATH: "/test/bin", HOME: "/test/home" };
  const controller = new PiMonitorController({
    deliverBatch: (batch) => {
      deliveryOrder.push("batch");
      batches.push(batch);
    },
    deliverTerminal: (outcome) => {
      deliveryOrder.push("terminal");
      terminals.push(outcome);
    },
    spawn: (command, spawnOptions) => {
      spawns.push({ command, options: spawnOptions });
      const child = children.shift();
      if (child === undefined) throw new Error("no fake child");
      return child;
    },
    clock,
    allocateTaskId: () => ids.shift() ?? "monitor-fallback",
    createArtifact: (id) => {
      const artifact = new FakeArtifact(`/private/${id}.log`);
      artifacts.push(artifact);
      return artifact;
    },
    killTree: (child, signal) => (child as FakeChild).signal(signal),
    cwd: "/session/cwd",
    env,
    ...(options.maxLineChars === undefined
      ? {}
      : { maxLineChars: options.maxLineChars }),
    ...(options.maxQueuedLines === undefined
      ? {}
      : { maxQueuedLines: options.maxQueuedLines }),
    ...(options.suppressionBudget === undefined
      ? {}
      : { suppressionBudget: options.suppressionBudget }),
  });
  return {
    controller,
    clock,
    batches,
    terminals,
    artifacts,
    spawns,
    deliveryOrder,
    env,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function listenerTotal(child: FakeChild): number {
  return (
    child.listenerCount("close") +
    child.listenerCount("exit") +
    child.listenerCount("error") +
    child.stdout.listenerCount("data") +
    child.stderr.listenerCount("data")
  );
}

describe("Pi Monitor facade schema", () => {
  test("exposes exactly the shared strict command schema", () => {
    expect(MONITOR_PARAMETERS).toEqual({
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to run and monitor.",
        },
        description: {
          type: "string",
          description: "Short description of the monitored command.",
        },
        persistent: {
          type: "boolean",
          default: false,
          description: "Keep watching until explicitly stopped.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1000,
          maximum: 3600000,
          default: 300000,
          description:
            "Deadline in milliseconds, ignored for persistent watches.",
        },
      },
      required: ["command", "description"],
      additionalProperties: false,
    });
    expect(JSON.stringify(MONITOR_PARAMETERS)).not.toMatch(/\bws\b|source/i);
  });

  test("applies defaults and rejects caps, unknown fields, and source variants", () => {
    expect(
      resolveMonitorParams({ command: "echo ok", description: "echo" }),
    ).toEqual({
      command: "echo ok",
      description: "echo",
      persistent: false,
      timeout_ms: MONITOR_DEFAULT_TIMEOUT_MS,
    });
    expect(
      resolveMonitorParams({
        command: "echo ok",
        description: "echo",
        persistent: true,
        timeout_ms: MONITOR_MIN_TIMEOUT_MS,
      }),
    ).toMatchObject({ persistent: true, timeout_ms: 1000 });
    expect(() =>
      resolveMonitorParams({
        command: "x",
        description: "x",
        timeout_ms: MONITOR_MIN_TIMEOUT_MS - 1,
      }),
    ).toThrow("1000 to 3600000");
    expect(() =>
      resolveMonitorParams({
        command: "x",
        description: "x",
        timeout_ms: MONITOR_MAX_TIMEOUT_MS + 1,
      }),
    ).toThrow("1000 to 3600000");
    expect(() =>
      resolveMonitorParams({
        command: "x",
        description: "x",
        source: "ws",
      }),
    ).toThrow("Unknown Monitor parameter: source");
    expect(() =>
      resolveMonitorParams({
        command: "x",
        description: "x",
        ws: "wss://example.test",
      }),
    ).toThrow("Unknown Monitor parameter: ws");
  });

  test("tool returns the stable id in result details", async () => {
    const child = new FakeChild();
    const { controller } = harness({ ids: ["stable-id"], children: [child] });
    const tool = createMonitorFacadeTool(controller);
    const result = await tool.execute("call-1", {
      command: "printf hi",
      description: "printer",
    });

    expect(tool.name).toBe("Monitor");
    expect(tool.parameters).toBe(MONITOR_PARAMETERS);
    expect(result).toEqual({
      content: [{ type: "text", text: "Monitor started: stable-id" }],
      details: { taskId: "stable-id" },
    });
    child.close(0);
  });
});

describe("PiMonitorController lifecycle", () => {
  test("arms in the session shell and records a sorted live snapshot", () => {
    const first = new FakeChild(1);
    const second = new FakeChild(2);
    const { controller, clock, spawns, env } = harness({
      ids: ["z-task", "a-task"],
      children: [first, second],
    });

    const z = controller.arm({ command: "echo z", description: "zed" });
    const a = controller.arm({
      command: "echo a",
      description: "aye",
      timeout_ms: 10_000,
    });

    expect([z, a]).toEqual(["z-task", "a-task"]);
    expect(controller.list()).toEqual([
      {
        id: "a-task",
        type: "shell",
        kind: "monitor",
        command: "echo a",
        description: "aye",
      },
      {
        id: "z-task",
        type: "shell",
        kind: "monitor",
        command: "echo z",
        description: "zed",
      },
    ]);
    expect(spawns).toEqual([
      {
        command: "echo z",
        options: {
          cwd: "/session/cwd",
          env,
          shell: "/bin/bash",
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      },
      {
        command: "echo a",
        options: {
          cwd: "/session/cwd",
          env,
          shell: "/bin/bash",
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      },
    ]);
    expect(
      clock
        .pending()
        .map((timer) => timer.timeoutMs)
        .sort(),
    ).toEqual([10_000, 300_000]);
    first.close(0);
    second.close(0);
  });

  test("persistent watches ignore their deadline", () => {
    const child = new FakeChild();
    const { controller, clock } = harness({ children: [child] });
    controller.arm({
      command: "watch",
      description: "persistent",
      persistent: true,
      timeout_ms: 1_000,
    });
    expect(clock.pending()).toEqual([]);
    child.close(0);
  });

  test("frames split UTF-8 and CRLF, persists first, and batches at 200ms", async () => {
    const child = new FakeChild();
    const { controller, clock, batches, terminals, artifacts, deliveryOrder } =
      harness({ children: [child] });
    const id = controller.arm({
      command: "producer",
      description: "unicode",
      persistent: true,
    });
    const encoded = Buffer.from("snowman ☃\r\nnext\npartial");
    const split = encoded.indexOf(Buffer.from("☃")) + 1;

    child.stdout.emit("data", encoded.subarray(0, split));
    child.stdout.emit("data", encoded.subarray(split));
    expect(batches).toEqual([]);
    expect(clock.pending(MONITOR_BATCH_WINDOW_MS)).toHaveLength(1);
    expect(
      Buffer.concat(
        artifacts[0]?.writes
          .filter(({ stream }) => stream === "stdout")
          .map(({ chunk }) => chunk) ?? [],
      ).toString(),
    ).toBe("snowman ☃\r\nnext\npartial");

    clock.runDelay(200);
    expect(batches).toEqual([
      { taskId: id, description: "unicode", lines: ["snowman ☃", "next"] },
    ]);
    expect(deliveryOrder).toEqual(["batch"]);

    child.close(0);
    await flushMicrotasks();
    expect(batches).toHaveLength(1);
    expect(terminals).toEqual([
      {
        taskId: id,
        description: "unicode",
        status: "exited",
        artifactPath: "/private/monitor-1.log",
        exitCode: 0,
        signal: null,
        suppressedLines: 0,
      },
    ]);
    expect(deliveryOrder).toEqual(["batch", "terminal"]);
    expect(artifacts[0]?.closed).toBe(true);
    expect(listenerTotal(child)).toBe(0);
  });

  test("persists stderr without delivering it as monitor output", async () => {
    const child = new FakeChild();
    const { controller, batches, terminals, artifacts } = harness({
      children: [child],
    });
    controller.arm({
      command: "noisy",
      description: "stderr",
      persistent: true,
    });
    child.stderr.emit("data", Buffer.from("warning\n"));
    child.close(2);
    await flushMicrotasks();

    expect(batches).toEqual([]);
    expect(
      Buffer.concat(
        artifacts[0]?.writes.map(({ chunk }) => chunk) ?? [],
      ).toString(),
    ).toBe("warning\n");
    expect(terminals[0]).toMatchObject({ status: "exited", exitCode: 2 });
  });

  test("bounds queued lines and visibly auto-stops a sustained flood", async () => {
    const child = new FakeChild();
    const { controller, batches, terminals, artifacts } = harness({
      children: [child],
      maxQueuedLines: 2,
      suppressionBudget: 2,
    });
    controller.arm({
      command: "flood",
      description: "flooder",
      persistent: true,
    });

    child.stdout.emit("data", Buffer.from("one\ntwo\nthree\nfour\nfive\n"));
    await flushMicrotasks();

    expect(batches).toEqual([
      {
        taskId: "monitor-1",
        description: "flooder",
        lines: ["one", "two"],
      },
    ]);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      taskId: "monitor-1",
      status: "flood",
      suppressedLines: 2,
      error: "monitor output exceeded the 2-line suppression budget",
    });
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(controller.list()).toEqual([]);
    expect(artifacts[0]?.closed).toBe(true);
    expect(listenerTotal(child)).toBe(0);
  });

  test("bounds a newline-free physical line until its boundary", async () => {
    const child = new FakeChild();
    const { controller, clock, batches, terminals } = harness({
      children: [child],
      maxLineChars: 5,
      suppressionBudget: 2,
    });
    controller.arm({
      command: "long",
      description: "long lines",
      persistent: true,
    });
    child.stdout.emit("data", Buffer.from("123456789"));
    child.stdout.emit("data", Buffer.from("tail\nok\nabcdef\n"));
    await flushMicrotasks();

    expect(terminals[0]).toMatchObject({ status: "flood", suppressedLines: 2 });
    expect(clock.pending(200)).toHaveLength(0);
    expect(batches).toEqual([
      {
        taskId: "monitor-1",
        description: "long lines",
        lines: ["ok"],
      },
    ]);
  });

  test("spawn failure is one deferred terminal with no live ownership", async () => {
    const clock = new FakeClock();
    const artifact = new FakeArtifact("/private/failed.log");
    const terminals: MonitorTerminalOutcome[] = [];
    const controller = new PiMonitorController({
      deliverBatch() {},
      deliverTerminal: (terminal) => terminals.push(terminal),
      spawn: () => {
        throw new Error("ENOENT bash");
      },
      createArtifact: () => artifact,
      allocateTaskId: () => "failed-id",
      clock,
    });

    expect(
      controller.arm({ command: "missing", description: "missing command" }),
    ).toBe("failed-id");
    expect(controller.list()).toEqual([]);
    expect(terminals).toEqual([]);
    await flushMicrotasks();
    expect(terminals).toEqual([
      {
        taskId: "failed-id",
        description: "missing command",
        status: "spawn_failed",
        artifactPath: "/private/failed.log",
        exitCode: null,
        signal: null,
        error: "ENOENT bash",
        suppressedLines: 0,
      },
    ]);
    expect(artifact.closed).toBe(true);
  });

  test("timeout wins races and clears every listener and timer", async () => {
    const child = new FakeChild();
    const { controller, clock, terminals } = harness({ children: [child] });
    controller.arm({ command: "slow", description: "slow" });
    const timeout = clock.pending(MONITOR_DEFAULT_TIMEOUT_MS)[0];
    if (timeout === undefined) throw new Error("missing timeout");

    clock.run(timeout);
    child.close(0);
    expect(await controller.stop("monitor-1")).toBe(false);
    await flushMicrotasks();

    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ status: "timed_out" });
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(clock.pending()).toEqual([]);
    expect(listenerTotal(child)).toBe(0);
  });

  test("exact-id stop is idempotent and cannot stop a sibling", async () => {
    const first = new FakeChild(1);
    const second = new FakeChild(2);
    const { controller, terminals } = harness({
      ids: ["b", "a"],
      children: [first, second],
    });
    controller.arm({
      command: "first",
      description: "first",
      persistent: true,
    });
    controller.arm({
      command: "second",
      description: "second",
      persistent: true,
    });

    expect(await controller.stop("missing")).toBe(false);
    expect(await controller.stop("b")).toBe(true);
    expect(await controller.stop("b")).toBe(false);
    expect(controller.list().map(({ id }) => id)).toEqual(["a"]);
    expect(first.signals).toEqual(["SIGTERM"]);
    expect(second.signals).toEqual([]);
    expect(terminals.map(({ taskId, status }) => ({ taskId, status }))).toEqual(
      [{ taskId: "b", status: "stopped" }],
    );
    second.close(0);
  });

  test("stopAll owns one shutdown terminal per task and is idempotent", async () => {
    const first = new FakeChild(1);
    const second = new FakeChild(2);
    const { controller, terminals } = harness({
      ids: ["b", "a"],
      children: [first, second],
    });
    controller.arm({
      command: "first",
      description: "first",
      persistent: true,
    });
    controller.arm({
      command: "second",
      description: "second",
      persistent: true,
    });

    await Promise.all([controller.stopAll(), controller.stopAll()]);
    await controller.stopAll();

    expect(controller.list()).toEqual([]);
    expect(terminals.map(({ taskId, status }) => ({ taskId, status }))).toEqual(
      [
        { taskId: "b", status: "shutdown" },
        { taskId: "a", status: "shutdown" },
      ],
    );
    expect(first.signals).toEqual(["SIGTERM"]);
    expect(second.signals).toEqual(["SIGTERM"]);
    expect(listenerTotal(first)).toBe(0);
    expect(listenerTotal(second)).toBe(0);
  });

  test("bounded teardown escalates from TERM to KILL", async () => {
    const child = new FakeChild();
    child.exitOnSignal = null;
    const clock = new FakeClock();
    const { controller, terminals } = harness({ children: [child], clock });
    controller.arm({
      command: "stuck",
      description: "stuck",
      persistent: true,
    });

    const stopping = controller.stop("monitor-1");
    expect(child.signals).toEqual(["SIGTERM"]);
    clock.runDelay(500);
    await flushMicrotasks();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    clock.runDelay(100);
    expect(await stopping).toBe(true);

    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ status: "stopped" });
    expect(clock.pending()).toEqual([]);
    expect(listenerTotal(child)).toBe(0);
  });

  test("shutdown during timeout teardown cannot mint a second terminal", async () => {
    const child = new FakeChild();
    child.exitOnSignal = null;
    const clock = new FakeClock();
    const { controller, terminals } = harness({ children: [child], clock });
    controller.arm({ command: "stuck", description: "stuck" });
    clock.runDelay(MONITOR_DEFAULT_TIMEOUT_MS);

    const shutdown = controller.stopAll();
    clock.runDelay(500);
    await flushMicrotasks();
    clock.runDelay(100);
    await shutdown;

    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ status: "timed_out" });
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
