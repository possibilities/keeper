import { describe, expect, test } from "bun:test";
import {
  decodePickerOutput,
  encodePickerChoices,
  formatWizardHeader,
  noteSummary,
  parseCommandWords,
  parseJsonObjectFromOutput,
  parseLaunchChoices,
  parseRankedProjects,
  sanitizePickerLabel,
  sanitizeTerminalPreview,
  shellQuote,
  uniqueOrdered,
} from "../src/note-workflow";

describe("note workflow discovery parsers", () => {
  test("parses ranked projects in server order", () => {
    const rows = parseRankedProjects(
      JSON.stringify({
        schema_version: 1,
        ok: true,
        error: null,
        data: {
          projects: [
            { name: "keeper", path: "/code/keeper", root_name: "code" },
            { name: "other", path: "/work/other", root_name: "work" },
          ],
        },
      }),
    );
    expect(rows).toEqual([
      { name: "keeper", path: "/code/keeper", rootName: "code" },
      { name: "other", path: "/work/other", rootName: "work" },
    ]);
  });

  test("rejects malformed project envelopes", () => {
    expect(parseRankedProjects("{}")).toEqual([]);
    expect(parseRankedProjects("not json")).toEqual([]);
  });

  test("parses the v2 launch cube and preserves exact triples", () => {
    const choices = parseLaunchChoices(
      JSON.stringify({
        kind: "presets-list",
        harnesses: [
          {
            harness: "pi",
            triples: [
              {
                triple: "pi::openai-codex/gpt-5.4::high",
                capability: "gpt-5.4",
                native_id: "openai-codex/gpt-5.4",
                effort: "high",
                cell: true,
              },
            ],
          },
          {
            harness: "hermes",
            triples: [
              {
                triple: "hermes::nous/hermes-3::na",
                capability: "hermes-3",
                native_id: "nous/hermes-3",
                effort: "na",
                cell: false,
              },
            ],
          },
        ],
      }),
    );
    expect(choices).toEqual([
      {
        triple: "pi::openai-codex/gpt-5.4::high",
        harness: "pi",
        capability: "gpt-5.4",
        nativeId: "openai-codex/gpt-5.4",
        effort: "high",
      },
      {
        triple: "hermes::nous/hermes-3::na",
        harness: "hermes",
        capability: "hermes-3",
        nativeId: "nous/hermes-3",
        effort: "na",
      },
    ]);
  });

  test("drops stale named-preset and malformed triple rows", () => {
    expect(
      parseLaunchChoices(
        JSON.stringify({ kind: "presets-list", presets: [{ name: "old" }] }),
      ),
    ).toEqual([]);
    expect(
      parseLaunchChoices(
        JSON.stringify({
          kind: "presets-list",
          harnesses: [
            {
              harness: "pi",
              triples: [
                {
                  triple: "claude::opus::high",
                  capability: "opus",
                  native_id: "opus",
                  effort: "high",
                },
                {
                  triple: "pi::actual-model::high",
                  capability: "display-model",
                  native_id: "different-model",
                  effort: "high",
                },
                {
                  triple: "pi::actual-model::high",
                  capability: "actual-model",
                  native_id: "actual-model",
                  effort: "low",
                },
              ],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("accepts a final one-line JSON object after diagnostics", () => {
    expect(parseJsonObjectFromOutput('diagnostic\n{"kind":"ok"}\n')).toEqual({
      kind: "ok",
    });
  });
});

describe("note picker helpers", () => {
  test("encodes opaque numeric keys and sanitizes labels", () => {
    const encoded = encodePickerChoices(
      [
        { value: { id: 1 }, label: "one\nline" },
        {
          value: { id: 2 },
          label: "two\tcolumns",
          preview: "note\n2",
        },
      ],
      { back: true },
    );
    expect(encoded.input).toBe(
      "0\tone line\n1\ttwo columns\tnote 2\n__back__\t← Back\n",
    );
    expect(encoded.values.get("1")).toEqual({ id: 2 });
  });

  test("decodes expected keys, rows, and cancellation", () => {
    const values = new Map([["0", "picked"]]);
    expect(decodePickerOutput(0, "ctrl-b\n", values)).toEqual({
      kind: "back",
    });
    expect(decodePickerOutput(0, "ctrl-t\n", values)).toEqual({
      kind: "toggle",
    });
    expect(decodePickerOutput(0, "enter\n0\trow\n", values)).toEqual({
      kind: "selected",
      value: "picked",
    });
    expect(decodePickerOutput(130, "", values)).toEqual({ kind: "cancel" });
    expect(decodePickerOutput(0, "enter\n__back__\tBack\n", values)).toEqual({
      kind: "back",
    });
  });

  test("formats compact summaries and wizard breadcrumbs", () => {
    expect(noteSummary("\n  hello   world\nsecond")).toBe("hello world");
    expect(noteSummary("x".repeat(20), 10)).toBe("xxxxxxxxx…");
    expect(sanitizePickerLabel("a\tb\nc")).toBe("a b c");
    expect(sanitizePickerLabel("safe\u001b]52;c;x\u0007")).toBe(
      "safe�]52;c;x�",
    );
    expect(sanitizeTerminalPreview("a\r\nb\rc\u001b[2J")).toBe("a\nb\nc�[2J");
    expect(
      formatWizardHeader(
        {
          project: { name: "keeper", path: "/code/keeper", rootName: "code" },
          harness: "pi",
          model: "gpt-5.4",
          effort: null,
          triple: null,
        },
        "effort",
      ),
    ).toContain("Project: keeper (/code/keeper)\nHarness: pi\nModel: gpt-5.4");
  });

  test("preserves first-seen unique order", () => {
    expect(uniqueOrdered(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
  });
});

describe("editor and shell token helpers", () => {
  test("parses quoted editor command words without eval", () => {
    expect(parseCommandWords("code --wait --reuse-window")).toEqual([
      "code",
      "--wait",
      "--reuse-window",
    ]);
    expect(parseCommandWords('"/Applications/My Editor" --flag="a b"')).toEqual(
      ["/Applications/My Editor", "--flag=a b"],
    );
    expect(parseCommandWords("nvim 'a b' c\\ d")).toEqual([
      "nvim",
      "a b",
      "c d",
    ]);
    expect(() => parseCommandWords("'oops")).toThrow(/unterminated quote/);
  });

  test("shellQuote protects embedded single quotes", () => {
    expect(shellQuote("/tmp/a b")).toBe("'/tmp/a b'");
    expect(shellQuote("it's")).toBe("'it'\"'\"'s'");
  });
});
