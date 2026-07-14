import { describe, expect, test } from "bun:test";
import {
  buildRenameConversationInput,
  createRenameInvocationState,
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
