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

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => queueMicrotask(resolve));

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
  type: string;
  prompt: string;
  options: Record<string, unknown>;
}

function rpcBus(version = 2): {
  bus: FakeBus;
  spawns: SpawnRequest[];
  stops: string[];
} {
  const bus = new FakeBus();
  const spawns: SpawnRequest[] = [];
  const stops: string[] = [];
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
    bus.emit(`subagents:rpc:spawn:reply:${request.requestId}`, {
      success: true,
      data: { id: `agent-${nextId++}` },
    });
  });
  bus.on("subagents:rpc:stop", (raw) => {
    const { requestId, agentId } = raw as {
      requestId: string;
      agentId: string;
    };
    stops.push(agentId);
    bus.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
  });
  return { bus, spawns, stops };
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
      rpc_protocol: 2,
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

  test("rejects a missing or incompatible RPC protocol", async () => {
    const incompatible = rpcBus(1);
    await expect(
      createTaskFacadeTool(incompatible.bus).execute("call", {
        subagent_type: "plan:repo-scout",
        description: "repo",
        prompt: "scan",
      }),
    ).rejects.toThrow("expected 2, got 1");

    const absent = new FakeBus();
    await expect(
      createTaskFacadeTool(absent).execute("call", {
        subagent_type: "plan:repo-scout",
        description: "repo",
        prompt: "scan",
      }),
    ).rejects.toThrow("did not answer");
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

  test("cancellation asks the subagent extension to stop", async () => {
    const { bus, stops } = rpcBus();
    const controller = new AbortController();
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
    controller.abort();
    await expect(pending).rejects.toThrow("Task cancelled");
    expect(stops).toEqual(["agent-1"]);
  });
});
