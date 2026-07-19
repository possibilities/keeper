import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ClaudeRenameHookDeps,
  type ClaudeRenameHookPayload,
  type ClaudeRenameNativeState,
  type ClaudeRenameProcessChild,
  type ClaudeRenameProcessDeps,
  type ClaudeRenameProcessResult,
  type ClaudeRenameTranscriptStat,
  executeClaudeRenameHook,
  parseClaudeRenameCommand,
  runClaudeRenameInferenceProcess,
} from "../plugins/keeper/plugin/hooks/rename";

const PAYLOAD: ClaudeRenameHookPayload = {
  hook_event_name: "UserPromptSubmit",
  session_id: "session-a",
  session_title: "old-title",
  transcript_path: "/project/session.jsonl",
  cwd: "/project",
  prompt: "/rename",
};

const STATE: ClaudeRenameNativeState = {
  sessionId: "session-a",
  sessionTitle: "old-title",
  transcriptPath: "/project/session.jsonl",
  projectDir: "/project",
  cwd: "/project",
};

const STAT: ClaudeRenameTranscriptStat = {
  dev: 1,
  ino: 2,
  mode: 0o100644,
  size: 37,
  mtimeMs: 100,
  ctimeMs: 90,
};

const SUCCESS: ClaudeRenameProcessResult = {
  exitCode: 0,
  stdout: JSON.stringify({
    schema_version: 1,
    ok: true,
    candidate: "project-search-ranking",
  }),
  timedOut: false,
  cancelled: false,
  overflow: false,
  startFailed: false,
};

interface Calls {
  state: number;
  stat: number;
  read: number;
  build: number;
  slug: number;
  inference: number;
}

function makeDeps(
  options: {
    keeperJobId?: string;
    nativeSupport?: boolean;
    states?: Array<ClaudeRenameNativeState | null>;
    stats?: ClaudeRenameTranscriptStat[];
    transcript?: Uint8Array;
    input?: string | null;
    processResult?: ClaudeRenameProcessResult;
    canonical?: Record<string, string | null>;
    statError?: boolean;
    readError?: boolean;
    buildError?: boolean;
    inferenceError?: boolean;
  } = {},
): { deps: ClaudeRenameHookDeps; calls: Calls } {
  const calls: Calls = {
    state: 0,
    stat: 0,
    read: 0,
    build: 0,
    slug: 0,
    inference: 0,
  };
  const states = options.states ?? [STATE, STATE];
  const stats = options.stats ?? [STAT, STAT];
  const canonical = options.canonical ?? {
    "project-search-ranking": "project-search-ranking",
    "manual-title": "manual-title",
  };
  const deps: ClaudeRenameHookDeps = {
    keeperJobId:
      "keeperJobId" in options ? options.keeperJobId : "managed-session",
    supportsNativeSessionTitle: () => options.nativeSupport ?? true,
    captureNativeState: () => {
      const index = calls.state++;
      return states[Math.min(index, states.length - 1)] ?? null;
    },
    statTranscript: () => {
      calls.stat += 1;
      if (options.statError) throw new Error("sensitive stat failure");
      return stats[Math.min(calls.stat - 1, stats.length - 1)] ?? STAT;
    },
    readTranscript: (_path, cutoff, expected) => {
      calls.read += 1;
      expect(cutoff).toBe(37);
      expect(expected).toEqual(STAT);
      if (options.readError) throw new Error("sensitive read failure");
      return (
        options.transcript ?? new TextEncoder().encode("secret transcript")
      );
    },
    buildInput: async (input) => {
      calls.build += 1;
      expect(input.cutoffBytes).toBe(37);
      expect(input.projectDir).toBe("/project");
      if (options.buildError) throw new Error("sensitive builder failure");
      return "input" in options
        ? (options.input ?? null)
        : "User: improve search";
    },
    canonicalSlug: async (text) => {
      calls.slug += 1;
      return text in canonical ? canonical[text] : null;
    },
    runInference: async () => {
      calls.inference += 1;
      if (options.inferenceError) throw new Error("SECRET_CREDENTIAL");
      return options.processResult ?? SUCCESS;
    },
  };
  return { deps, calls };
}

function titleOf(
  output: Awaited<ReturnType<typeof executeClaudeRenameHook>>,
): string | undefined {
  return output?.hookSpecificOutput.sessionTitle;
}

function noticeOf(
  output: Awaited<ReturnType<typeof executeClaudeRenameHook>>,
): string {
  return output?.hookSpecificOutput.additionalContext ?? "";
}

describe("Claude rename command parser", () => {
  test("matches only bare rename or one ordinary trailing argument", () => {
    expect(parseClaudeRenameCommand("/rename")).toEqual({ kind: "bare" });
    expect(parseClaudeRenameCommand("  /rename  ")).toEqual({ kind: "bare" });
    expect(parseClaudeRenameCommand("/rename manual-title")).toEqual({
      kind: "explicit",
      slug: "manual-title",
    });
    expect(parseClaudeRenameCommand("/rename @src/search.ts")).toEqual({
      kind: "explicit",
      slug: "@src/search.ts",
    });
  });

  test("rejects command-prefix, prose, whitespace, and extra-argument near misses", () => {
    for (const prompt of [
      "/renamefoo",
      "/rename-later",
      "please use /rename",
      "/rename  manual-title",
      "/rename\tmanual-title",
      "/rename manual-title trailing",
      "/rename\nmanual-title",
      "",
    ]) {
      expect(parseClaudeRenameCommand(prompt)).toBeNull();
    }
  });
});

describe("Claude rename hook core", () => {
  test("the non-match hot path performs no state, filesystem, slug, or process work", async () => {
    for (const prompt of [
      "/renamefoo",
      "/rename-later",
      "ordinary prose mentioning /rename",
      "/rename manual-title trailing",
    ]) {
      const { deps, calls } = makeDeps();
      const output = await executeClaudeRenameHook(
        { ...PAYLOAD, prompt },
        deps,
      );
      expect(output).toBeNull();
      expect(calls).toEqual({
        state: 0,
        stat: 0,
        read: 0,
        build: 0,
        slug: 0,
        inference: 0,
      });
    }
  });

  test("an exact command is inert without managed Keeper identity", async () => {
    const { deps, calls } = makeDeps({ keeperJobId: "" });
    expect(await executeClaudeRenameHook(PAYLOAD, deps)).toBeNull();
    expect(calls.state).toBe(0);
    expect(calls.stat).toBe(0);
    expect(calls.inference).toBe(0);
  });

  test("explicit canonical slug uses native sessionTitle without transcript or inference", async () => {
    const { deps, calls } = makeDeps();
    const output = await executeClaudeRenameHook(
      { ...PAYLOAD, prompt: "/rename manual-title" },
      deps,
    );
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "/rename: Session title updated.",
        sessionTitle: "manual-title",
      },
    });
    expect(calls).toEqual({
      state: 0,
      stat: 0,
      read: 0,
      build: 0,
      slug: 1,
      inference: 0,
    });
  });

  test("noncanonical and @path explicit arguments leave the title unchanged", async () => {
    for (const argument of [
      "Manual-Title",
      "manual--title",
      "@src/search.ts",
    ]) {
      const { deps, calls } = makeDeps();
      const output = await executeClaudeRenameHook(
        { ...PAYLOAD, prompt: `/rename ${argument}` },
        deps,
      );
      expect(titleOf(output)).toBeUndefined();
      expect(noticeOf(output)).toBe(
        "/rename: argument must be a canonical slug",
      );
      expect(calls.stat).toBe(0);
      expect(calls.read).toBe(0);
      expect(calls.inference).toBe(0);
    }
  });

  test("bare rename passes the exact cutoff and project to bounded input and returns native title", async () => {
    const transcript = new TextEncoder().encode("private transcript fixture");
    const { deps, calls } = makeDeps({ transcript });
    const output = await executeClaudeRenameHook(PAYLOAD, deps);
    expect(titleOf(output)).toBe("project-search-ranking");
    expect(output?.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(calls).toEqual({
      state: 2,
      stat: 2,
      read: 1,
      build: 1,
      slug: 1,
      inference: 1,
    });
  });

  test("empty and unreadable context fail open without inference", async () => {
    const empty = makeDeps({ input: null });
    const emptyOutput = await executeClaudeRenameHook(PAYLOAD, empty.deps);
    expect(titleOf(emptyOutput)).toBeUndefined();
    expect(noticeOf(emptyOutput)).toBe("/rename: nothing to name yet");
    expect(empty.calls.inference).toBe(0);

    for (const options of [
      { statError: true },
      { readError: true },
      { buildError: true },
    ]) {
      const fixture = makeDeps(options);
      const output = await executeClaudeRenameHook(PAYLOAD, fixture.deps);
      expect(titleOf(output)).toBeUndefined();
      expect(noticeOf(output)).toBe(
        "/rename: transcript context is unavailable",
      );
      expect(fixture.calls.inference).toBe(0);
    }
  });

  test("malformed payload and unavailable native capability leave title unchanged", async () => {
    const unsupported = makeDeps({ nativeSupport: false });
    const unsupportedOutput = await executeClaudeRenameHook(
      PAYLOAD,
      unsupported.deps,
    );
    expect(titleOf(unsupportedOutput)).toBeUndefined();
    expect(noticeOf(unsupportedOutput)).toBe(
      "/rename: native title support is unavailable",
    );
    expect(unsupported.calls.state).toBe(0);

    const malformed = makeDeps({ states: [null] });
    const malformedOutput = await executeClaudeRenameHook(
      PAYLOAD,
      malformed.deps,
    );
    expect(titleOf(malformedOutput)).toBeUndefined();
    expect(noticeOf(malformedOutput)).toBe(
      "/rename: session state is unavailable",
    );
  });

  test("every typed metadata failure remains content-free and title-neutral", async () => {
    const failureKinds = [
      "invalid_input",
      "route_unavailable",
      "spawn_failed",
      "capture_failed",
      "timeout",
      "cancelled",
      "output_too_large",
      "auth_failed",
      "quota_unavailable",
      "process_failed",
      "malformed_output",
      "unusable_candidate",
    ] as const;
    for (const kind of failureKinds) {
      const processResult: ClaudeRenameProcessResult = {
        ...SUCCESS,
        exitCode: kind === "invalid_input" ? 2 : 1,
        stdout: JSON.stringify({
          schema_version: 1,
          ok: false,
          error: { kind, message: "PRIVATE MODEL DIAGNOSTIC" },
        }),
      };
      const { deps } = makeDeps({ processResult });
      const output = await executeClaudeRenameHook(PAYLOAD, deps);
      expect(titleOf(output)).toBeUndefined();
      expect(noticeOf(output)).toBe(`/rename: title unchanged (${kind})`);
      expect(JSON.stringify(output)).not.toContain("PRIVATE MODEL DIAGNOSTIC");
    }
  });

  test("transport, malformed, and unusable candidate outcomes fail open", async () => {
    const cases: Array<[Partial<ClaudeRenameProcessResult>, string]> = [
      [{ startFailed: true }, "spawn_failed"],
      [{ timedOut: true }, "timeout"],
      [{ cancelled: true }, "cancelled"],
      [{ overflow: true }, "output_too_large"],
      [{ stdout: "not-json", exitCode: 1 }, "malformed_output"],
      [
        {
          stdout: JSON.stringify({
            schema_version: 1,
            ok: true,
            candidate: "Not Canonical",
          }),
        },
        "unusable_candidate",
      ],
    ];
    for (const [overrides, kind] of cases) {
      const { deps } = makeDeps({
        processResult: { ...SUCCESS, ...overrides },
      });
      const output = await executeClaudeRenameHook(PAYLOAD, deps);
      expect(titleOf(output)).toBeUndefined();
      expect(noticeOf(output)).toBe(`/rename: title unchanged (${kind})`);
    }
  });

  test("a thrown inference runner is folded to a fixed process failure", async () => {
    const { deps } = makeDeps({ inferenceError: true });
    const output = await executeClaudeRenameHook(PAYLOAD, deps);
    expect(titleOf(output)).toBeUndefined();
    expect(noticeOf(output)).toBe("/rename: title unchanged (process_failed)");
    expect(JSON.stringify(output)).not.toContain("SECRET_CREDENTIAL");
  });

  test("session, title, transcript path, project, cwd, and cutoff drift discard success", async () => {
    const stateDrifts: ClaudeRenameNativeState[] = [
      { ...STATE, sessionId: "session-b" },
      { ...STATE, sessionTitle: "newer-title" },
      { ...STATE, transcriptPath: "/project/new.jsonl" },
      { ...STATE, projectDir: "/other-project" },
      { ...STATE, cwd: "/project/subdir" },
    ];
    for (const drifted of stateDrifts) {
      const { deps } = makeDeps({ states: [STATE, drifted] });
      const output = await executeClaudeRenameHook(PAYLOAD, deps);
      expect(titleOf(output)).toBeUndefined();
      expect(noticeOf(output)).toBe(
        "/rename: session changed; title unchanged",
      );
    }

    const { deps } = makeDeps({
      stats: [STAT, { ...STAT, size: STAT.size + 1 }],
    });
    const output = await executeClaudeRenameHook(PAYLOAD, deps);
    expect(titleOf(output)).toBeUndefined();
    expect(noticeOf(output)).toBe("/rename: session changed; title unchanged");
  });

  test("pre-cancelled bare rename performs no transcript or process work", async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, calls } = makeDeps();
    const output = await executeClaudeRenameHook(
      PAYLOAD,
      deps,
      controller.signal,
    );
    expect(noticeOf(output)).toBe("/rename: title unchanged (cancelled)");
    expect(calls.stat).toBe(0);
    expect(calls.inference).toBe(0);
  });

  test("notices redact transcript, referenced file, model output, and credential fixtures", async () => {
    const secrets = [
      "TRANSCRIPT_SECRET_17",
      "REFERENCED_FILE_SECRET_29",
      "MODEL_OUTPUT_SECRET_41",
      "CREDENTIAL_SECRET_53",
    ];
    const { deps } = makeDeps({
      transcript: new TextEncoder().encode(`${secrets[0]} ${secrets[1]}`),
      processResult: {
        ...SUCCESS,
        exitCode: 1,
        stdout: `${secrets[2]} ${secrets[3]}`,
      },
    });
    const output = await executeClaudeRenameHook(PAYLOAD, deps);
    const serialized = JSON.stringify(output);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(noticeOf(output)).toBe(
      "/rename: title unchanged (malformed_output)",
    );
  });
});

class FakeStream extends EventEmitter {
  override on(
    event: "data",
    listener: (chunk: Uint8Array | string) => void,
  ): this {
    return super.on(event, listener);
  }

  override removeListener(
    event: "data",
    listener: (chunk: Uint8Array | string) => void,
  ): this {
    return super.removeListener(event, listener);
  }
}

class FakeChild extends EventEmitter implements ClaudeRenameProcessChild {
  pid = 4321;
  stdout = new FakeStream();
  stderr = new FakeStream();
  directKills = 0;

  kill(): boolean {
    this.directKills += 1;
    return true;
  }
}

function processFixture(): {
  child: FakeChild;
  deps: ClaudeRenameProcessDeps;
  argv: string[][];
  fireTimer(): void;
  killed(): number;
} {
  const child = new FakeChild();
  const argv: string[][] = [];
  let timer: (() => void) | null = null;
  let kills = 0;
  return {
    child,
    argv,
    deps: {
      spawn: (command, args) => {
        argv.push([command, ...args]);
        return child;
      },
      setTimer: (callback) => {
        timer = callback;
        return 7;
      },
      clearTimer: () => {},
      killTree: () => {
        kills += 1;
      },
    },
    fireTimer: () => timer?.(),
    killed: () => kills,
  };
}

describe("Claude rename metadata process boundary", () => {
  test("passes input only to the isolated Keeper metadata mode", async () => {
    const fixture = processFixture();
    const controller = new AbortController();
    const pending = runClaudeRenameInferenceProcess(
      "bounded naming input",
      controller.signal,
      fixture.deps,
    );
    fixture.child.stdout.emit(
      "data",
      JSON.stringify({ schema_version: 1, ok: true, candidate: "a-title" }),
    );
    fixture.child.emit("close", 0);
    const result = await pending;
    expect(fixture.argv).toEqual([
      [
        "keeper",
        "agent",
        "claude",
        "--x-metadata-inference",
        "bounded naming input",
      ],
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"candidate":"a-title"');
    expect(fixture.killed()).toBe(0);
  });

  test("outer timeout kills the complete child process tree", async () => {
    const fixture = processFixture();
    const pending = runClaudeRenameInferenceProcess(
      "bounded naming input",
      new AbortController().signal,
      fixture.deps,
    );
    fixture.fireTimer();
    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(fixture.killed()).toBe(1);
  });

  test("cancellation kills the complete child process tree", async () => {
    const fixture = processFixture();
    const controller = new AbortController();
    const pending = runClaudeRenameInferenceProcess(
      "bounded naming input",
      controller.signal,
      fixture.deps,
    );
    controller.abort();
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(fixture.killed()).toBe(1);
  });
});

describe("Claude rename plugin resources", () => {
  test("registers one rename skill and one bounded UserPromptSubmit hook", () => {
    const root = join(import.meta.dir, "..");
    const skill = readFileSync(
      join(root, "plugins/keeper/skills/rename/SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("\nname: rename\n");
    expect(skill).toContain('argument-hint: "[canonical-slug]"');
    expect(skill).toContain("/rename @src/search.ts");

    const hooks = JSON.parse(
      readFileSync(join(root, "plugins/keeper/hooks/hooks.json"), "utf8"),
    ) as {
      hooks: {
        UserPromptSubmit: Array<{
          hooks: Array<{ type: string; command: string; timeout?: number }>;
        }>;
      };
    };
    const renameHooks = hooks.hooks.UserPromptSubmit.flatMap((entry) =>
      entry.hooks.filter((hook) => hook.command.endsWith("/hooks/rename.ts")),
    );
    expect(renameHooks).toEqual([
      {
        type: "command",
        command: `\${CLAUDE_PLUGIN_ROOT}/plugin/hooks/rename.ts`,
        timeout: 30,
      },
    ]);
  });
});
