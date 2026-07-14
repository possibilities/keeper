import { describe, expect, test } from "bun:test";
import taskFacadeExtension, {
  createTaskFacadeTool as createRawTaskFacadeTool,
  type PiTaskEventBus,
  type PiTaskToolDefinition,
  type PromptCompilerRunner,
  type TaskFacadeOptions,
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

const THINKING_TURNS = { low: 25, medium: 40, high: 60, xhigh: 75 } as const;
type TestThinking = keyof typeof THINKING_TURNS;

function compiledResult(
  role: string,
  options: {
    outcome?: "hit" | "compiled" | "repaired";
    model?: unknown;
    effort?: unknown;
    thinking?: unknown;
    maxTurns?: unknown;
    outputs?: unknown[];
  } = {},
): string {
  const effort = options.effort ?? "high";
  const thinking = options.thinking ?? (effort === "max" ? "xhigh" : effort);
  const maxTurns =
    options.maxTurns ??
    (typeof thinking === "string" && thinking in THINKING_TURNS
      ? THINKING_TURNS[thinking as TestThinking]
      : 60);
  return JSON.stringify({
    schema_version: 1,
    target: "pi",
    request: { kind: "role", name: role },
    outcome: options.outcome ?? "hit",
    ok: true,
    outputs: options.outputs ?? [
      {
        role,
        launch_cell: {
          provider: "pi",
          model: options.model ?? "openai-codex/gpt-5.6-sol",
          effort,
        },
        thinking,
        max_turns: maxTurns,
      },
    ],
  });
}

const successfulCompilerRunner: PromptCompilerRunner = async (
  _executable,
  args,
) => {
  const role = args[3];
  if (role === undefined) throw new Error("test compiler received no role");
  return { stdout: compiledResult(role), stderr: "" };
};

function createTaskFacadeTool(
  events: PiTaskEventBus,
  overrides: TaskFacadeOptions = {},
): PiTaskToolDefinition {
  return createRawTaskFacadeTool(events, {
    compilerRunner: successfulCompilerRunner,
    ...overrides,
  });
}

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

  test("compiles the exact role argv and binds explicit Pi launch options", async () => {
    const { bus, spawns } = rpcBus();
    const calls: Array<{
      executable: string;
      args: readonly string[];
      options: Parameters<PromptCompilerRunner>[2];
    }> = [];
    const compilerRunner: PromptCompilerRunner = async (
      executable,
      args,
      options,
    ) => {
      calls.push({ executable, args, options });
      return {
        stdout: compiledResult("plan:repo-scout", {
          outcome: "compiled",
          model: "openai/gpt-5.6-terra",
          effort: "medium",
        }),
        stderr: "",
      };
    };
    const pending = createTaskFacadeTool(bus, { compilerRunner }).execute(
      "call",
      {
        subagent_type: "plan:repo-scout",
        description: "scan repo",
        prompt: "scan",
      },
    );
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.executable).toBe("keeper");
    expect(calls[0]?.args).toEqual([
      "prompt",
      "compile",
      "--role",
      "plan:repo-scout",
      "--target",
      "pi",
    ]);
    expect(calls[0]?.options).toMatchObject({
      encoding: "utf8",
      env: process.env,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      shell: false,
    });
    expect(calls[0]?.options).not.toHaveProperty("signal");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.options).toEqual({
      description: "scan repo",
      isBackground: false,
      model: "openai/gpt-5.6-terra",
      thinkingLevel: "medium",
      maxTurns: 40,
    });

    bus.emit("subagents:completed", {
      id: "agent-1",
      status: "completed",
      result: "done",
    });
    await pending;
  });

  test("binds each role's distinct effort, including max compatibility", async () => {
    const { bus, spawns } = rpcBus();
    const compilerRunner: PromptCompilerRunner = async (_file, args) => {
      const role = args[3] as string;
      if (role === "plan:docs-gap-scout") {
        return {
          stdout: compiledResult(role, {
            model: "openai/gpt-5.6-sol",
            effort: "low",
          }),
          stderr: "",
        };
      }
      return {
        stdout: compiledResult(role, {
          model: "openai/gpt-5.6-terra",
          effort: "max",
        }),
        stderr: "",
      };
    };
    const tool = createTaskFacadeTool(bus, { compilerRunner });
    const low = tool.execute("low", {
      subagent_type: "plan:docs-gap-scout",
      description: "docs",
      prompt: "scan docs",
    });
    const max = tool.execute("max", {
      subagent_type: "plan:panel-judge",
      description: "judge",
      prompt: "judge panel",
    });
    await flushMicrotasks();

    expect(spawns.map(({ type, options }) => ({ type, options }))).toEqual([
      {
        type: "plan:docs-gap-scout",
        options: {
          description: "docs",
          isBackground: false,
          model: "openai/gpt-5.6-sol",
          thinkingLevel: "low",
          maxTurns: 25,
        },
      },
      {
        type: "plan:panel-judge",
        options: {
          description: "judge",
          isBackground: false,
          model: "openai/gpt-5.6-terra",
          thinkingLevel: "xhigh",
          maxTurns: 75,
        },
      },
    ]);
    bus.emit("subagents:completed", {
      id: "agent-1",
      status: "completed",
      result: "low",
    });
    bus.emit("subagents:completed", {
      id: "agent-2",
      status: "completed",
      result: "max",
    });
    await Promise.all([low, max]);
  });

  test("compiler hit and compiled outcomes produce equivalent RPC binding", async () => {
    const { bus, spawns } = rpcBus();
    let invocation = 0;
    const compilerRunner: PromptCompilerRunner = async (_file, args) => {
      const outcome = invocation++ === 0 ? "compiled" : "hit";
      return {
        stdout: compiledResult(args[3] as string, { outcome }),
        stderr: "",
      };
    };
    const tool = createTaskFacadeTool(bus, { compilerRunner });
    const first = tool.execute("first", {
      subagent_type: "plan:repo-scout",
      description: "first",
      prompt: "one",
    });
    await flushMicrotasks();
    bus.emit("subagents:completed", {
      id: "agent-1",
      status: "completed",
      result: "one",
    });
    await first;
    const second = tool.execute("second", {
      subagent_type: "plan:repo-scout",
      description: "second",
      prompt: "two",
    });
    await flushMicrotasks();

    expect(spawns).toHaveLength(2);
    expect(spawns[0]?.options).toMatchObject({
      model: "openai-codex/gpt-5.6-sol",
      thinkingLevel: "high",
      maxTurns: 60,
    });
    expect(spawns[1]?.options).toMatchObject({
      model: spawns[0]?.options.model,
      thinkingLevel: spawns[0]?.options.thinkingLevel,
      maxTurns: spawns[0]?.options.maxTurns,
    });
    bus.emit("subagents:completed", {
      id: "agent-2",
      status: "completed",
      result: "two",
    });
    await second;
  });

  test.each([
    ["malformed JSON", "not-json", /malformed/],
    ["multiple JSON documents", "{}\n{}", /multi-document/],
    ["ok false", JSON.stringify({ ok: false }), /ok:false/],
    [
      "missing role",
      compiledResult("plan:repo-scout", {
        outputs: [
          {
            role: "plan:other",
            launch_cell: {
              provider: "pi",
              model: "openai/gpt-5.6-sol",
              effort: "high",
            },
            thinking: "high",
            max_turns: 60,
          },
        ],
      }),
      /0 matching output rows/,
    ],
    [
      "duplicate role",
      compiledResult("plan:repo-scout", {
        outputs: [
          {
            role: "plan:repo-scout",
            launch_cell: {
              provider: "pi",
              model: "openai/gpt-5.6-sol",
              effort: "high",
            },
            thinking: "high",
            max_turns: 60,
          },
          {
            role: "plan:repo-scout",
            launch_cell: {
              provider: "pi",
              model: "openai/gpt-5.6-terra",
              effort: "high",
            },
            thinking: "high",
            max_turns: 60,
          },
        ],
      }),
      /2 matching output rows/,
    ],
  ])("fails before spawn on compiler %s", async (_name, stdout, message) => {
    const { bus, spawns } = rpcBus();
    const compilerRunner: PromptCompilerRunner = async () => ({
      stdout: stdout as string,
      stderr: "",
    });
    await expect(
      createTaskFacadeTool(bus, { compilerRunner }).execute("call", {
        subagent_type: "plan:repo-scout",
        description: "repo",
        prompt: "scan",
      }),
    ).rejects.toThrow(message as RegExp);
    expect(spawns).toHaveLength(0);
  });

  test("fails before spawn when the compiler process fails", async () => {
    const { bus, spawns } = rpcBus();
    const compilerRunner: PromptCompilerRunner = async () => {
      throw new Error("keeper prompt compile exited 1: matrix invalid");
    };
    await expect(
      createTaskFacadeTool(bus, { compilerRunner }).execute("call", {
        subagent_type: "plan:repo-scout",
        description: "repo",
        prompt: "scan",
      }),
    ).rejects.toThrow("matrix invalid");
    expect(spawns).toHaveLength(0);
  });

  test.each([
    ["launch model", { model: "../escape" }, /launch model/],
    ["thinking", { effort: "max", thinking: "max", maxTurns: 75 }, /thinking/],
    ["max turns", { maxTurns: 0 }, /max_turns/],
  ])("rejects invalid compiler %s", async (_name, values, message) => {
    const { bus, spawns } = rpcBus();
    const compilerRunner: PromptCompilerRunner = async () => ({
      stdout: compiledResult("plan:repo-scout", values),
      stderr: "",
    });
    await expect(
      createTaskFacadeTool(bus, { compilerRunner }).execute("call", {
        subagent_type: "plan:repo-scout",
        description: "repo",
        prompt: "scan",
      }),
    ).rejects.toThrow(message as RegExp);
    expect(spawns).toHaveLength(0);
  });

  test("custom agents and work:worker bypass prompt compilation", async () => {
    const { bus, spawns } = rpcBus();
    let compilerCalls = 0;
    const compilerRunner: PromptCompilerRunner = async () => {
      compilerCalls += 1;
      throw new Error("compiler must not run");
    };
    const tool = createTaskFacadeTool(bus, { compilerRunner });
    const custom = tool.execute("custom", {
      subagent_type: "my-custom-agent",
      description: "custom",
      prompt: "custom work",
    });
    const worker = tool.execute("worker", {
      subagent_type: "work:worker",
      description: "work",
      prompt: "worker work",
    });
    await flushMicrotasks();

    expect(compilerCalls).toBe(0);
    expect(spawns.map((spawn) => spawn.type)).toEqual([
      "my-custom-agent",
      "work:worker",
    ]);
    expect(spawns.every((spawn) => !("model" in spawn.options))).toBe(true);
    bus.emit("subagents:completed", {
      id: "agent-1",
      status: "completed",
      result: "custom",
    });
    bus.emit("subagents:completed", {
      id: "agent-2",
      status: "completed",
      result: "worker",
    });
    await Promise.all([custom, worker]);
  });

  test("abort during compilation preserves the reason and spawns nothing", async () => {
    const { bus, spawns } = rpcBus();
    let compilerSignal: AbortSignal | undefined;
    let compilerCalls = 0;
    const compilerRunner: PromptCompilerRunner = async (
      _file,
      _args,
      options,
    ) => {
      compilerCalls += 1;
      compilerSignal = options.signal;
      return await new Promise<never>(() => {});
    };
    const controller = new AbortController();
    const reason = new DOMException("cancel compile", "AbortError");
    const pending = createTaskFacadeTool(bus, { compilerRunner }).execute(
      "call",
      {
        subagent_type: "plan:repo-scout",
        description: "repo",
        prompt: "scan",
      },
      controller.signal,
    );
    await flushMicrotasks();
    expect(compilerCalls).toBe(1);
    expect(compilerSignal).toBe(controller.signal);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(spawns).toHaveLength(0);
  });

  test("rejects a shell-shaped plan role before constructing compiler argv", async () => {
    const { bus, spawns } = rpcBus();
    let compilerCalls = 0;
    const compilerRunner: PromptCompilerRunner = async () => {
      compilerCalls += 1;
      throw new Error("must not run");
    };
    await expect(
      createTaskFacadeTool(bus, { compilerRunner }).execute("call", {
        subagent_type: "plan:repo-scout;touch-pwned",
        description: "repo",
        prompt: "scan",
      }),
    ).rejects.toThrow("fully-qualified plan:name token");
    expect(compilerCalls).toBe(0);
    expect(spawns).toHaveLength(0);
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
