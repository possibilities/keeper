import { describe, expect, test } from "bun:test";
import {
  buildRenameConversationInput,
  createRenameCommandHandler,
  createRenameInvocationState,
  findRenamePathReferences,
  isValidRenameSlug,
  type RenameCommandContext,
  type RenameCommandDeps,
  type RenameInputFileSystem,
  type RenameInputStat,
} from "../plugins/keeper/pi-extension/rename-command";

function parityFileSystem(): RenameInputFileSystem {
  const files = new Map([
    ["/project", { bytes: Buffer.alloc(0), directory: true, ino: 1 }],
    [
      "/project/docs/name file.md",
      {
        bytes: Buffer.from("design context with @recursive.ts"),
        directory: false,
        ino: 2,
      },
    ],
  ]);
  const handles = new Map<number, { path: string; offset: number }>();
  let nextFd = 10;
  const entry = (path: string) => {
    const found = files.get(path);
    if (found === undefined) throw new Error("missing");
    return found;
  };
  const stat = (path: string): RenameInputStat => {
    const found = entry(path);
    return {
      dev: 1,
      ino: found.ino,
      mode: found.directory ? 0o040755 : 0o100644,
      size: found.bytes.byteLength,
      mtimeMs: 1,
      ctimeMs: 1,
      isFile: () => !found.directory,
      isSymbolicLink: () => false,
    };
  };
  return {
    realpath: (path) => {
      entry(path);
      return path;
    },
    lstat: stat,
    open: (path) => {
      entry(path);
      const fd = nextFd++;
      handles.set(fd, { path, offset: 0 });
      return fd;
    },
    fstat: (fd) => stat(handles.get(fd)?.path ?? ""),
    read: (fd, buffer, offset, length) => {
      const handle = handles.get(fd);
      if (handle === undefined) throw new Error("bad fd");
      const bytes = entry(handle.path).bytes;
      const count = Math.min(length, bytes.byteLength - handle.offset);
      if (count <= 0) return 0;
      buffer.set(bytes.subarray(handle.offset, handle.offset + count), offset);
      handle.offset += count;
      return count;
    },
    close: (fd) => {
      handles.delete(fd);
    },
  };
}

describe("/rename conversation input", () => {
  test("a single user message is sufficient input", () => {
    expect(
      buildRenameConversationInput(
        [{ role: "user", content: "Build project search" }],
        1_000,
      ),
    ).toBe("User: Build project search");
  });

  test("includes the active conversation in chronological order", () => {
    const input = buildRenameConversationInput(
      [
        { role: "user", content: [{ type: "text", text: "Build search" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private" },
            { type: "text", text: "I found the index" },
          ],
        },
        { role: "toolResult", content: [{ type: "text", text: "secret" }] },
        { role: "user", content: [{ type: "text", text: "Add ranking" }] },
      ],
      1_000,
    );

    expect(input).toBe(
      "User: Build search\n\nAssistant: I found the index\n\nUser: Add ranking",
    );
    expect(input).not.toContain("private");
    expect(input).not.toContain("secret");
  });

  test("keeps compaction summaries and removes expanded skills", () => {
    const input = buildRenameConversationInput(
      [
        { role: "compactionSummary", summary: "Implement durable queues" },
        {
          role: "user",
          content: `<skill name="hack">${"noise".repeat(100)}</skill>\n\nFix retries`,
        },
      ],
      1_000,
    );

    expect(input).toBe(
      "Conversation summary: Implement durable queues\n\nUser: Fix retries",
    );
  });

  test("bounds UTF-8 input and gives user text twice the truncation weight", () => {
    const input = buildRenameConversationInput(
      [
        { role: "user", content: "u".repeat(200) },
        { role: "assistant", content: "a".repeat(200) },
      ],
      79,
    );

    expect(input).not.toBeNull();
    expect(Buffer.byteLength(input ?? "", "utf8")).toBeLessThanOrEqual(79);
    const userLength = /User: (u*)/.exec(input ?? "")?.[1]?.length ?? 0;
    const assistantLength =
      /Assistant: (a*)/.exec(input ?? "")?.[1]?.length ?? 0;
    expect(userLength).toBe(assistantLength * 2);
  });

  test("never splits a multi-byte character past the byte cap", () => {
    const input = buildRenameConversationInput(
      [{ role: "user", content: "😀".repeat(20) }],
      11,
    );

    expect(Buffer.byteLength(input ?? "", "utf8")).toBeLessThanOrEqual(11);
    expect(input).toBe("User: 😀");
  });

  test("cannot be configured above the final 16 KiB input cap", () => {
    const input = buildRenameConversationInput(
      [{ role: "user", content: "x".repeat(30_000) }],
      1_000_000,
    );

    expect(Buffer.byteLength(input ?? "", "utf8")).toBe(16 * 1024);
  });

  test("expands safe human path references within the final allocation cap", () => {
    const prose = [
      'Use @"docs/name\u00a0file.md", not me@example.com.',
      "Ignore `@inline.ts` and:",
      "```",
      "@fenced.ts",
      "```",
    ].join("\n");
    expect(findRenamePathReferences(prose)).toEqual(["docs/name\u00a0file.md"]);

    const pi = buildRenameConversationInput(
      [
        { role: "compactionSummary", summary: "Earlier design work" },
        { role: "user", content: prose },
        { role: "assistant", content: "Assistant says @assistant.ts" },
      ],
      16 * 1024,
      { projectDir: "/project", fileSystem: parityFileSystem() },
    );

    const expected = [
      "Conversation summary: Earlier design work",
      `User: ${prose}\n\n[Referenced file: "docs/name file.md"]\ndesign context with @recursive.ts\n[End referenced file]`,
      "Assistant: Assistant says @assistant.ts",
    ].join("\n\n");
    expect(pi).toBe(expected);
  });
});

describe("/rename explicit slug", () => {
  test("accepts only exact canonical slugs", () => {
    expect(isValidRenameSlug("project-search-ranking")).toBe(true);
    for (const invalid of [
      "Project-Search",
      "project search",
      "project--search",
      "-project-search",
      "project-search-",
      "project_search",
      "a".repeat(65),
      "",
    ]) {
      expect(isValidRenameSlug(invalid)).toBe(false);
    }
  });

  test("sets a valid slug immediately without reading or inferring", async () => {
    const names: string[] = [];
    const notices: Array<{ message: string; level?: string }> = [];
    let turnReads = 0;
    const deps: RenameCommandDeps = {
      runTurnCli: async () => {
        turnReads += 1;
        return { stdout: "", stderr: "" };
      },
      resolveProvider: () => undefined,
      getAuth: async () => ({ ok: false, error: "unused" }),
      runCompletion: async () => {
        throw new Error("unused");
      },
    };
    const ctx: RenameCommandContext = {
      cwd: "/work/repo",
      sessionManager: {
        getSessionId: () => "session-1",
        getLeafId: () => "leaf-1",
        getSessionName: () => undefined,
      },
      model: undefined,
      modelRegistry: {
        getProvider: () => undefined,
        getApiKeyAndHeaders: async () => ({ ok: false, error: "unused" }),
      },
      ui: {
        notify: (message, level) => notices.push({ message, level }),
      },
    };
    const handler = createRenameCommandHandler(
      { setSessionName: (name) => names.push(name) },
      deps,
      createRenameInvocationState(),
    );

    await handler("project-search-ranking", ctx);

    expect(names).toEqual(["project-search-ranking"]);
    expect(turnReads).toBe(0);
    expect(notices).toEqual([
      { message: "Session renamed: project-search-ranking", level: "info" },
    ]);
  });

  test("returns an error for a non-slug without mutating the title", async () => {
    const names: string[] = [];
    const notices: Array<{ message: string; level?: string }> = [];
    const deps: RenameCommandDeps = {
      runTurnCli: async () => ({ stdout: "", stderr: "" }),
      resolveProvider: () => undefined,
      getAuth: async () => ({ ok: false, error: "unused" }),
      runCompletion: async () => {
        throw new Error("unused");
      },
    };
    const ctx: RenameCommandContext = {
      cwd: "/work/repo",
      sessionManager: {
        getSessionId: () => "session-1",
        getLeafId: () => "leaf-1",
        getSessionName: () => undefined,
      },
      model: undefined,
      modelRegistry: {
        getProvider: () => undefined,
        getApiKeyAndHeaders: async () => ({ ok: false, error: "unused" }),
      },
      ui: {
        notify: (message, level) => notices.push({ message, level }),
      },
    };
    const handler = createRenameCommandHandler(
      { setSessionName: (name) => names.push(name) },
      deps,
      createRenameInvocationState(),
    );

    await handler("Not A Slug", ctx);

    expect(names).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.level).toBe("error");
    expect(notices[0]?.message).toContain("argument must be a lowercase slug");
  });

  test("a valid explicit slug cancels a pending inferred rename", async () => {
    const names: string[] = [];
    const state = createRenameInvocationState();
    const deps: RenameCommandDeps = {
      runTurnCli: async () => ({
        stdout: JSON.stringify({ ok: true, data: { turn: null } }),
        stderr: "",
      }),
      resolveProvider: () => undefined,
      getAuth: async () => ({ ok: false, error: "unused" }),
      runCompletion: async () => {
        throw new Error("unused");
      },
    };
    const ctx: RenameCommandContext = {
      cwd: "/work/repo",
      sessionManager: {
        getSessionId: () => "session-1",
        getLeafId: () => "leaf-1",
        getSessionName: () => undefined,
      },
      model: undefined,
      modelRegistry: {
        getProvider: () => undefined,
        getApiKeyAndHeaders: async () => ({ ok: false, error: "unused" }),
      },
      ui: { notify() {} },
      isIdle: () => true,
    };
    const handler = createRenameCommandHandler(
      { setSessionName: (name) => names.push(name) },
      deps,
      state,
    );

    await handler("", ctx);
    expect(state.pending).not.toBeNull();
    await handler("manual-title", ctx);

    expect(state.pending).toBeNull();
    expect(names).toEqual(["manual-title"]);
  });
});

describe("/rename conversation orchestration", () => {
  test("uses the full context immediately while the assistant is active", async () => {
    let completionInput = "";
    let turnReads = 0;
    const ctx: RenameCommandContext = {
      cwd: "/work/repo",
      sessionManager: {
        getSessionId: () => "session-1",
        getLeafId: () => "leaf-1",
        getSessionName: () => undefined,
        buildSessionContext: () => ({
          messages: [
            { role: "user", content: "Build project search" },
            { role: "assistant", content: "Implemented indexing" },
            { role: "user", content: "Now add ranking" },
          ],
        }),
      },
      model: { provider: "anthropic", id: "claude-test" },
      modelRegistry: {
        getProvider: () => ({
          streamSimple: () => {
            throw new Error("fake completion provider is not called directly");
          },
        }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
      },
      ui: { notify() {} },
      isIdle: () => false,
    };
    const deps: RenameCommandDeps = {
      runTurnCli: async () => {
        turnReads += 1;
        return { stdout: "", stderr: "" };
      },
      resolveProvider: (registry, model) =>
        registry.getProvider(model.provider),
      getAuth: (registry, model) => registry.getApiKeyAndHeaders(model),
      runCompletion: async (_model, context) => {
        completionInput = context.messages[0]?.content[0]?.text ?? "";
        return {
          stopReason: "stop",
          content: [{ type: "text", text: "Project Search Ranking" }],
        };
      },
    };

    const names: string[] = [];
    const handler = createRenameCommandHandler(
      { setSessionName: (name) => names.push(name) },
      deps,
      createRenameInvocationState(),
    );

    await handler("", ctx);

    expect(names).toEqual(["project-search-ranking"]);
    expect(turnReads).toBe(0);
    expect(completionInput).toContain("User: Build project search");
    expect(completionInput).toContain("Assistant: Implemented indexing");
    expect(completionInput).toContain("User: Now add ranking");
  });

  test("the command waits only when live context has no messages", async () => {
    const names: string[] = [];
    const notices: string[] = [];
    let completionCalls = 0;
    const state = createRenameInvocationState();
    const ctx: RenameCommandContext = {
      cwd: "/work/repo",
      sessionManager: {
        getSessionId: () => "session-1",
        getLeafId: () => "root",
        getSessionName: () => undefined,
        buildSessionContext: () => ({ messages: [] }),
      },
      model: { provider: "google", id: "gemini-test" },
      modelRegistry: {
        getProvider: () => ({
          streamSimple: () => {
            throw new Error("fake completion provider is not called directly");
          },
        }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
      },
      ui: { notify: (message) => notices.push(message) },
      isIdle: () => false,
    };
    const deps: RenameCommandDeps = {
      runTurnCli: async () => {
        throw new Error("live context must not use the fallback");
      },
      resolveProvider: (registry, model) =>
        registry.getProvider(model.provider),
      getAuth: (registry, model) => registry.getApiKeyAndHeaders(model),
      runCompletion: async () => {
        completionCalls += 1;
        return {
          stopReason: "stop",
          content: [{ type: "text", text: "unused" }],
        };
      },
    };
    const handler = createRenameCommandHandler(
      { setSessionName: (name) => names.push(name) },
      deps,
      state,
    );

    await handler("", ctx);

    expect(state.pending).not.toBeNull();
    expect(completionCalls).toBe(0);
    expect(names).toEqual([]);
    expect(notices).toEqual(["/rename: generating a session title…"]);
  });
});
