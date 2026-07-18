import { describe, expect, test } from "bun:test";
import {
  expandSkillShorthandInput,
  installSkillShorthandAutocomplete,
  type PiAutocompleteProvider,
  SKILL_SHORTHANDS,
} from "../plugins/keeper/pi-extension/skill-autocomplete";

const OPTIONS = { signal: new AbortController().signal };

function captureWrapper() {
  let wrapper:
    | ((current: PiAutocompleteProvider) => PiAutocompleteProvider)
    | undefined;
  installSkillShorthandAutocomplete({
    ui: {
      addAutocompleteProvider(next) {
        wrapper = next;
      },
    },
  });
  return () => wrapper;
}

describe("Pi skill shorthand input transform", () => {
  test("rewrites exact slash aliases to native skill commands", () => {
    expect(expandSkillShorthandInput("/hack")).toBe("/skill:hack");
    expect(expandSkillShorthandInput("/hack fix this now")).toBe(
      "/skill:hack fix this now",
    );
    expect(expandSkillShorthandInput("/plan\nmake an epic")).toBe(
      "/skill:plan\nmake an epic",
    );
  });

  test("leaves near-misses and native skill commands unchanged", () => {
    for (const text of [
      "/hacker",
      "/hack/path",
      "/planner",
      "/skill:hack do it",
      " /hack do it",
      "hack do it",
    ]) {
      expect(expandSkillShorthandInput(text)).toBe(text);
    }
  });
});

describe("Pi skill shorthand autocomplete", () => {
  test("names exactly the canonical hack and plan shorthands", () => {
    expect(SKILL_SHORTHANDS.map((shorthand) => shorthand.name)).toEqual([
      "hack",
      "plan",
    ]);
  });

  test("does not install a wrapper when addAutocompleteProvider is unavailable", () => {
    expect(() => installSkillShorthandAutocomplete({ ui: {} })).not.toThrow();
  });

  test("prepends the short aliases ahead of the wrapped provider's own matches", async () => {
    const getWrapper = captureWrapper();
    const factory = getWrapper();
    expect(factory).toBeDefined();
    if (factory === undefined) throw new Error("autocomplete wrapper missing");

    let fileCompletionThis: unknown;
    const completion = { lines: ["/hack"], cursorLine: 0, cursorCol: 5 };
    const base: PiAutocompleteProvider = {
      triggerCharacters: ["/"],
      async getSuggestions() {
        return { prefix: "/h", items: [{ value: "/help", label: "help" }] };
      },
      applyCompletion: () => completion,
      shouldTriggerFileCompletion() {
        fileCompletionThis = this;
        return false;
      },
    };
    const provider = factory(base);
    const result = await provider.getSuggestions(["/h"], 0, 2, OPTIONS);

    expect(result).toEqual({
      prefix: "/h",
      items: [
        {
          value: "/hack",
          label: "hack",
          description: "Run the hack skill workflow on a request",
        },
        { value: "/help", label: "help" },
      ],
    });
    expect(provider.triggerCharacters).toEqual(["/"]);
    expect(
      provider.applyCompletion(
        [],
        0,
        0,
        { value: "/hack", label: "hack" },
        "/",
      ),
    ).toBe(completion);
    expect(provider.shouldTriggerFileCompletion?.([], 0, 0)).toBe(false);
    expect(fileCompletionThis).toBe(base);
  });

  test("offers aliases when the underlying provider has no matches", async () => {
    const getWrapper = captureWrapper();
    const factory = getWrapper();
    expect(factory).toBeDefined();
    if (factory === undefined) throw new Error("autocomplete wrapper missing");
    const provider = factory({
      async getSuggestions() {
        return null;
      },
      applyCompletion: (lines, cursorLine, cursorCol) => ({
        lines,
        cursorLine,
        cursorCol,
      }),
    });

    expect(await provider.getSuggestions(["/p"], 0, 2, OPTIONS)).toEqual({
      prefix: "/p",
      items: [
        {
          value: "/plan",
          label: "plan",
          description: "Run the plan skill workflow on a planning request",
        },
      ],
    });
  });

  test("leaves suggestions untouched outside command discovery", async () => {
    const getWrapper = captureWrapper();
    const factory = getWrapper();
    expect(factory).toBeDefined();
    if (factory === undefined) throw new Error("autocomplete wrapper missing");
    const original = {
      prefix: "skill:hack",
      items: [{ value: "skill:hack", label: "skill:hack" }],
    };
    const provider = factory({
      async getSuggestions() {
        return original;
      },
      applyCompletion: (lines, cursorLine, cursorCol) => ({
        lines,
        cursorLine,
        cursorCol,
      }),
    });

    expect(
      await provider.getSuggestions(
        ["/hack skill:hack"],
        0,
        "/hack skill:hack".length,
        OPTIONS,
      ),
    ).toBe(original);
  });

  test("leaves suggestions untouched on a forced (non-command-discovery) request", async () => {
    const getWrapper = captureWrapper();
    const factory = getWrapper();
    expect(factory).toBeDefined();
    if (factory === undefined) throw new Error("autocomplete wrapper missing");
    const original = {
      prefix: "/h",
      items: [{ value: "/help", label: "help" }],
    };
    const provider = factory({
      async getSuggestions() {
        return original;
      },
      applyCompletion: (lines, cursorLine, cursorCol) => ({
        lines,
        cursorLine,
        cursorCol,
      }),
    });

    expect(
      await provider.getSuggestions(["/h"], 0, 2, { ...OPTIONS, force: true }),
    ).toBe(original);
  });

  test("returns null suggestions unchanged when nothing matches the prefix", async () => {
    const getWrapper = captureWrapper();
    const factory = getWrapper();
    expect(factory).toBeDefined();
    if (factory === undefined) throw new Error("autocomplete wrapper missing");
    const provider = factory({
      async getSuggestions() {
        return null;
      },
      applyCompletion: (lines, cursorLine, cursorCol) => ({
        lines,
        cursorLine,
        cursorCol,
      }),
    });

    expect(await provider.getSuggestions(["/z"], 0, 2, OPTIONS)).toBeNull();
  });
});
