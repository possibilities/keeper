import { describe, expect, test } from "bun:test";
import {
  buildRenameConversationInput,
  createRenameCommandHandler,
  createRenameInvocationState,
  isValidRenameSlug,
  type RenameCommandContext,
  type RenameCommandDeps,
  runRenameInvocation,
} from "../plugins/keeper/pi-extension/rename-command";

describe("/rename conversation input", () => {
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
      resolveModel: () => undefined,
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
      modelRegistry: {
        find: () => undefined,
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
      resolveModel: () => undefined,
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
      modelRegistry: {
        find: () => undefined,
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
      resolveModel: () => undefined,
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
      modelRegistry: {
        find: () => undefined,
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
  test("prefers Pi's full active context over the Latest-turn fallback", async () => {
    let completionInput = "";
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
      modelRegistry: {
        find: () => ({ provider: "openai-codex" }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
      },
      ui: { notify() {} },
      isIdle: () => true,
    };
    const deps: RenameCommandDeps = {
      runTurnCli: async () => ({
        stdout: JSON.stringify({
          ok: true,
          data: { turn: { prompt: "Now add ranking", response: "Done" } },
        }),
        stderr: "",
      }),
      resolveModel: (registry, provider, modelId) =>
        registry.find(provider, modelId),
      getAuth: (registry, model) => registry.getApiKeyAndHeaders(model),
      runCompletion: async (_model, context) => {
        completionInput = context.messages[0]?.content[0]?.text ?? "";
        return {
          stopReason: "stop",
          content: [{ type: "text", text: "Project Search Ranking" }],
        };
      },
    };

    const result = await runRenameInvocation(
      ctx,
      deps,
      createRenameInvocationState(),
    );

    expect(result).toEqual({
      outcome: "success",
      title: "project-search-ranking",
    });
    expect(completionInput).toContain("User: Build project search");
    expect(completionInput).toContain("Assistant: Implemented indexing");
    expect(completionInput).toContain("User: Now add ranking");
  });
});
