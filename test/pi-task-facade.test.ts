import { describe, expect, test } from "bun:test";
import taskFacadeExtension, {
  createTaskFacadeTool,
  type PiTaskEventBus,
  type PiTaskToolDefinition,
} from "../plugins/keeper/pi-extension/task-facade";

class FakeBus implements PiTaskEventBus {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  on(event: string, handler: (data: unknown) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
    return () => set.delete(handler);
  }

  emit(event: string, data: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
  }
}

const flushMicrotasks = async (): Promise<void> => {
  // RPC replies, Promise.race, and finally cleanup each enqueue a turn.
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

const immediateDeadline = {
  schedule(callback: () => void): undefined {
    queueMicrotask(callback);
    return undefined;
  },
  cancel(): void {},
};

function withKeeperJobId(value: string | undefined, run: () => void): void {
  const saved = process.env.KEEPER_JOB_ID;
  try {
    if (value === undefined) delete process.env.KEEPER_JOB_ID;
    else process.env.KEEPER_JOB_ID = value;
    run();
  } finally {
    if (saved === undefined) delete process.env.KEEPER_JOB_ID;
    else process.env.KEEPER_JOB_ID = saved;
  }
}

interface SpawnRequest {
  requestId: string;
  version: number;
  type: string;
  prompt: string;
  options: Record<string, unknown>;
}

interface StopRequest {
  requestId: string;
  version: number;
  handle: string;
  reason: string;
}

function rpcBus(
  version = 3,
  options: {
    autoAcknowledgeStop?: boolean;
    rejectType?: string;
  } = {},
): {
  bus: FakeBus;
  spawns: SpawnRequest[];
  stops: StopRequest[];
  acknowledgeStop(index?: number, data?: unknown): void;
} {
  const bus = new FakeBus();
  const spawns: SpawnRequest[] = [];
  const stops: StopRequest[] = [];
  let nextId = 1;

  bus.on("subagents:rpc:ping", (raw) => {
    const { requestId } = raw as { requestId: string };
    bus.emit(`subagents:rpc:ping:reply:${requestId}`, {
      success: true,
      data: { version },
    });
  });
  bus.on("subagents:rpc:spawn", (raw) => {
    const request = raw as SpawnRequest;
    spawns.push(request);
    if (request.type === options.rejectType) {
      bus.emit(`subagents:rpc:spawn:reply:${request.requestId}`, {
        success: false,
        error: `Unknown or disabled agent type: "${request.type}"`,
      });
      return;
    }
    const ordinal = nextId++;
    bus.emit(`subagents:rpc:spawn:reply:${request.requestId}`, {
      success: true,
      data: { id: `agent-${ordinal}`, handle: `owner-${ordinal}` },
    });
  });
  const acknowledgeStop = (
    index = stops.length - 1,
    data: unknown = { settled: true, failures: [] },
  ): void => {
    const request = stops[index];
    if (request === undefined)
      throw new Error("no stop request to acknowledge");
    bus.emit(`subagents:rpc:stop:reply:${request.requestId}`, {
      success: true,
      data,
    });
  };
  bus.on("subagents:rpc:stop", (raw) => {
    stops.push(raw as StopRequest);
    if (options.autoAcknowledgeStop !== false) acknowledgeStop();
  });
  return { bus, spawns, stops, acknowledgeStop };
}

describe("Pi Task facade extension", () => {
  test("an armed child registers only Task", () => {
    withKeeperJobId("job-parent", () => {
      const tools: PiTaskToolDefinition[] = [];
      taskFacadeExtension({
        events: new FakeBus(),
        registerTool: (tool) => tools.push(tool),
      });
      expect(tools.map((tool) => tool.name)).toEqual(["Task"]);
    });
  });

  test("an untracked child registers nothing", () => {
    withKeeperJobId(undefined, () => {
      const tools: PiTaskToolDefinition[] = [];
      taskFacadeExtension({
        events: new FakeBus(),
        registerTool: (tool) => tools.push(tool),
      });
      expect(tools).toEqual([]);
    });
  });

  test("a missing or throwing Pi surface fails open", () => {
    withKeeperJobId("job-parent", () => {
      expect(() => taskFacadeExtension({})).not.toThrow();
      expect(() =>
        taskFacadeExtension({
          events: new FakeBus(),
          registerTool: () => {
            throw new Error("registration failed");
          },
        }),
      ).not.toThrow();
    });
  });
});

describe("Pi Task facade", () => {
  test("returns only the terminal result body and keeps metadata in details", async () => {
    const { bus, spawns } = rpcBus();
    const tool = createTaskFacadeTool(bus);
    const pending = tool.execute("call-1", {
      subagent_type: "plan:model-selector",
      description: "select cells",
      prompt: "select",
    });
    await flushMicrotasks();

    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      version: 3,
      type: "plan:model-selector",
      prompt: "select",
      options: { description: "select cells", isBackground: false },
    });
    bus.emit("subagents:completed", {
      id: "agent-1",
      type: "plan:model-selector",
      status: "completed",
      result: '{"cells":[]}',
      toolUses: 3,
      durationMs: 25,
      tokens: { total: 42 },
    });

    const result = await pending;
    expect(result.content).toEqual([{ type: "text", text: '{"cells":[]}' }]);
    expect(result.details).toMatchObject({
      agent_id: "agent-1",
      status: "completed",
      rpc_protocol: 3,
      tool_uses: 3,
    });
  });

  test("an empty completed result is a loud Task failure, never 'No output'", async () => {
    const { bus } = rpcBus();
    const tool = createTaskFacadeTool(bus);
    const pending = tool.execute("call-1", {
      subagent_type: "plan:panel-runner",
      description: "convene",
      prompt: "q",
    });
    await flushMicrotasks();
    bus.emit("subagents:completed", {
      id: "agent-1",
      type: "plan:panel-runner",
      status: "completed",
      result: "",
    });
    await expect(pending).rejects.toThrow(/completed without a textual result/);
  });

  test("parallel calls correlate reverse-order completions", async () => {
    const { bus, spawns } = rpcBus();
    const tool = createTaskFacadeTool(bus);
    const first = tool.execute("call-1", {
      subagent_type: "plan:repo-scout",
      description: "repo",
      prompt: "one",
    });
    const second = tool.execute("call-2", {
      subagent_type: "plan:docs-gap-scout",
      description: "docs",
      prompt: "two",
    });
    await flushMicrotasks();
    expect(spawns.map((request) => request.type)).toEqual([
      "plan:repo-scout",
      "plan:docs-gap-scout",
    ]);

    bus.emit("subagents:completed", {
      id: "agent-2",
      status: "completed",
      result: "second",
    });
    bus.emit("subagents:completed", {
      id: "agent-1",
      status: "completed",
      result: "first",
    });
    expect((await first).content[0]?.text).toBe("first");
    expect((await second).content[0]?.text).toBe("second");
  });

  test("exposes exactly the shared three-field parallel Task schema", () => {
    const tool = createTaskFacadeTool(new FakeBus());
    expect(tool.executionMode).toBe("parallel");
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {
        subagent_type: {
          type: "string",
          description: "Named subagent type, such as plan:repo-scout.",
        },
        description: {
          type: "string",
          description: "Short task description shown in the subagent UI.",
        },
        prompt: {
          type: "string",
          description: "Complete prompt for the subagent.",
        },
      },
      required: ["subagent_type", "description", "prompt"],
      additionalProperties: false,
    });
    expect(JSON.stringify(tool.parameters)).not.toMatch(
      /agent.?id|owner|handle|rpc|cancel/i,
    );
  });

  test("rejects a missing or incompatible RPC protocol", async () => {
    const incompatible = rpcBus(2);
    await expect(
      createTaskFacadeTool(incompatible.bus).execute("call", {
        subagent_type: "plan:repo-scout",
        description: "repo",
        prompt: "scan",
      }),
    ).rejects.toThrow("expected 3, got 2");

    const absent = new FakeBus();
    await expect(
      createTaskFacadeTool(absent, {
        rpcTimeoutMs: 1,
        deadline: immediateDeadline,
      }).execute("call", {
        subagent_type: "plan:repo-scout",
        description: "repo",
        prompt: "scan",
      }),
    ).rejects.toThrow("did not answer");
  });

  test("strictly rejects a missing named agent without a fallback result", async () => {
    const { bus, spawns } = rpcBus(3, { rejectType: "plan:missing" });
    await expect(
      createTaskFacadeTool(bus).execute("call", {
        subagent_type: "plan:missing",
        description: "missing",
        prompt: "work",
      }),
    ).rejects.toThrow('Unknown or disabled agent type: "plan:missing"');
    expect(spawns).toHaveLength(1);
  });

  test("requires the spawn response to carry its opaque owner scope", async () => {
    const bus = new FakeBus();
    bus.on("subagents:rpc:ping", (raw) => {
      const { requestId } = raw as { requestId: string };
      bus.emit(`subagents:rpc:ping:reply:${requestId}`, {
        success: true,
        data: { version: 3 },
      });
    });
    bus.on("subagents:rpc:spawn", (raw) => {
      const { requestId } = raw as { requestId: string };
      bus.emit(`subagents:rpc:spawn:reply:${requestId}`, {
        success: true,
        data: { id: "agent-legacy" },
      });
    });
    await expect(
      createTaskFacadeTool(bus).execute("call", {
        subagent_type: "plan:panel-judge",
        description: "judge",
        prompt: "fuse",
      }),
    ).rejects.toThrow("spawn returned no owned agent scope");
  });

  test("surfaces a terminal subagent failure", async () => {
    const { bus } = rpcBus();
    const pending = createTaskFacadeTool(bus).execute("call", {
      subagent_type: "plan:gap-analyst",
      description: "gaps",
      prompt: "analyze",
    });
    await flushMicrotasks();
    bus.emit("subagents:failed", {
      id: "agent-1",
      status: "error",
      error: "provider unavailable",
    });
    await expect(pending).rejects.toThrow("provider unavailable");
  });

  test("cancellation targets the owner scope and waits for recursive acknowledgement", async () => {
    const { bus, stops, acknowledgeStop } = rpcBus(3, {
      autoAcknowledgeStop: false,
    });
    const controller = new AbortController();
    const reason = new DOMException("panel cancelled", "AbortError");
    const pending = createTaskFacadeTool(bus).execute(
      "call",
      {
        subagent_type: "plan:repo-scout",
        description: "repo",
        prompt: "scan",
      },
      controller.signal,
    );
    await flushMicrotasks();
    controller.abort(reason);
    await flushMicrotasks();

    let settled = false;
    void pending
      .catch(() => {})
      .finally(() => {
        settled = true;
      });
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({
      version: 3,
      handle: "owner-1",
      reason: "panel cancelled",
    });
    expect(stops[0]).not.toHaveProperty("agentId");

    acknowledgeStop();
    await expect(pending).rejects.toBe(reason);
  });

  test("a bounded recursive cancellation failure is loud, not AbortError", async () => {
    const { bus, stops, acknowledgeStop } = rpcBus(3, {
      autoAcknowledgeStop: false,
    });
    const controller = new AbortController();
    const pending = createTaskFacadeTool(bus).execute(
      "call",
      {
        subagent_type: "plan:panel-judge",
        description: "judge",
        prompt: "fuse",
      },
      controller.signal,
    );
    await flushMicrotasks();
    controller.abort(new DOMException("cancel", "AbortError"));
    await flushMicrotasks();
    expect(stops).toHaveLength(1);
    acknowledgeStop(0, {
      settled: false,
      failures: ["child judge-2 did not settle"],
    });
    const error = await pending.then(
      () => new Error("expected cancellation failure"),
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected Error result");
    expect(error.name).toBe("Error");
    expect(error.message).toContain("child judge-2 did not settle");
  });

  test("an abort before spawn preserves its reason and launches nothing", async () => {
    const bus = new FakeBus();
    let spawnCount = 0;
    bus.on("subagents:rpc:spawn", () => {
      spawnCount += 1;
    });
    const controller = new AbortController();
    const reason = new DOMException("cancel before admission", "AbortError");
    const pending = createTaskFacadeTool(bus).execute(
      "call",
      {
        subagent_type: "plan:panel-judge",
        description: "judge",
        prompt: "fuse",
      },
      controller.signal,
    );
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(spawnCount).toBe(0);
  });

  test("an abort while spawn is in flight stops the scope once ownership arrives", async () => {
    const bus = new FakeBus();
    let spawn: SpawnRequest | undefined;
    const stops: StopRequest[] = [];
    bus.on("subagents:rpc:ping", (raw) => {
      const { requestId } = raw as { requestId: string };
      bus.emit(`subagents:rpc:ping:reply:${requestId}`, {
        success: true,
        data: { version: 3 },
      });
    });
    bus.on("subagents:rpc:spawn", (raw) => {
      spawn = raw as SpawnRequest;
    });
    bus.on("subagents:rpc:stop", (raw) => {
      const request = raw as StopRequest;
      stops.push(request);
      bus.emit(`subagents:rpc:stop:reply:${request.requestId}`, {
        success: true,
        data: { settled: true, failures: [] },
      });
    });

    const controller = new AbortController();
    const reason = new DOMException("timeout", "AbortError");
    const pending = createTaskFacadeTool(bus).execute(
      "call",
      {
        subagent_type: "plan:panel-judge",
        description: "judge",
        prompt: "fuse",
      },
      controller.signal,
    );
    await flushMicrotasks();
    expect(spawn).toBeDefined();
    if (spawn === undefined) throw new Error("spawn request was not emitted");
    controller.abort(reason);
    bus.emit(`subagents:rpc:spawn:reply:${spawn.requestId}`, {
      success: true,
      data: { id: "judge-1", handle: "judge-tree-1" },
    });
    await expect(pending).rejects.toBe(reason);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({
      handle: "judge-tree-1",
      reason: "timeout",
    });
  });

  test("a completion arriving after abort cannot beat stop acknowledgement", async () => {
    const { bus, stops, acknowledgeStop } = rpcBus(3, {
      autoAcknowledgeStop: false,
    });
    const controller = new AbortController();
    const reason = new DOMException("caller stopped", "AbortError");
    const pending = createTaskFacadeTool(bus).execute(
      "call",
      {
        subagent_type: "plan:panel-judge",
        description: "judge",
        prompt: "fuse",
      },
      controller.signal,
    );
    await flushMicrotasks();
    controller.abort(reason);
    bus.emit("subagents:completed", {
      id: "agent-1",
      status: "completed",
      result: "late answer",
    });
    await flushMicrotasks();
    expect(stops).toHaveLength(1);
    acknowledgeStop();
    await expect(pending).rejects.toBe(reason);
  });

  test("cancelling one concurrent tree does not stop or corrupt its sibling", async () => {
    const { bus, spawns, stops } = rpcBus();
    const firstController = new AbortController();
    const reason = new DOMException("first only", "AbortError");
    const tool = createTaskFacadeTool(bus);
    const first = tool.execute(
      "first",
      {
        subagent_type: "plan:repo-scout",
        description: "one",
        prompt: "one",
      },
      firstController.signal,
    );
    const second = tool.execute("second", {
      subagent_type: "plan:docs-gap-scout",
      description: "two",
      prompt: "two",
    });
    await flushMicrotasks();
    const firstOrdinal =
      spawns.findIndex((request) => request.prompt === "one") + 1;
    const secondOrdinal =
      spawns.findIndex((request) => request.prompt === "two") + 1;
    expect(firstOrdinal).toBeGreaterThan(0);
    expect(secondOrdinal).toBeGreaterThan(0);
    firstController.abort(reason);
    bus.emit("subagents:completed", {
      id: `agent-${secondOrdinal}`,
      status: "completed",
      result: "sibling answer",
    });
    await expect(first).rejects.toBe(reason);
    expect((await second).content[0]?.text).toBe("sibling answer");
    expect(stops.map((request) => request.handle)).toEqual([
      `owner-${firstOrdinal}`,
    ]);
  });
});
