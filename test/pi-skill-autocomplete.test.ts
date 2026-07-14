import { describe, expect, test } from "bun:test";
import {
  installShadowedSkillAutocomplete,
  type PiAutocompleteProvider,
} from "../plugins/keeper/pi-extension/skill-autocomplete";

const OPTIONS = { signal: new AbortController().signal };

function captureWrapper(commands: Array<{ name: string; source: string }>) {
  let wrapper:
    | ((current: PiAutocompleteProvider) => PiAutocompleteProvider)
    | undefined;
  installShadowedSkillAutocomplete(
    { getCommands: () => commands },
    {
      ui: {
        addAutocompleteProvider(next) {
          wrapper = next;
        },
      },
    },
  );
  return () => wrapper;
}

describe("Pi shadowed skill autocomplete", () => {
  test("hides skills with matching extension aliases and keeps other skills", async () => {
    const getWrapper = captureWrapper([
      { name: "hack", source: "extension" },
      { name: "plan", source: "extension" },
      { name: "skill:hack", source: "skill" },
      { name: "skill:plan", source: "skill" },
      { name: "skill:gmail", source: "skill" },
    ]);
    let fileCompletionThis: unknown;
    const completion = { lines: ["/hack"], cursorLine: 0, cursorCol: 5 };
    const base: PiAutocompleteProvider = {
      triggerCharacters: ["#"],
      async getSuggestions() {
        return {
          prefix: "/",
          items: [
            { value: "hack", label: "hack" },
            { value: "skill:hack", label: "skill:hack" },
            { value: "/skill:plan", label: "skill:plan" },
            { value: "skill:gmail", label: "skill:gmail" },
          ],
        };
      },
      applyCompletion: () => completion,
      shouldTriggerFileCompletion() {
        fileCompletionThis = this;
        return false;
      },
    };

    const wrapper = getWrapper();
    expect(wrapper).toBeDefined();
    if (wrapper === undefined) throw new Error("autocomplete wrapper missing");
    const filtered = wrapper(base);
    const suggestions = await filtered.getSuggestions(["/"], 0, 1, OPTIONS);

    expect(suggestions).toEqual({
      prefix: "/",
      items: [
        { value: "hack", label: "hack" },
        { value: "skill:gmail", label: "skill:gmail" },
      ],
    });
    expect(filtered.triggerCharacters).toEqual(["#"]);
    expect(
      filtered.applyCompletion([], 0, 0, { value: "hack", label: "hack" }, "/"),
    ).toBe(completion);
    expect(filtered.shouldTriggerFileCompletion?.([], 0, 0)).toBe(false);
    expect(fileCompletionThis).toBe(base);
  });

  test("leaves matching values alone outside command discovery", async () => {
    const getWrapper = captureWrapper([
      { name: "hack", source: "extension" },
      { name: "skill:hack", source: "skill" },
    ]);
    const wrapper = getWrapper();
    expect(wrapper).toBeDefined();
    if (wrapper === undefined) throw new Error("autocomplete wrapper missing");
    const original = {
      prefix: "skill:hack",
      items: [{ value: "skill:hack", label: "skill:hack" }],
    };
    const filtered = wrapper({
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
      await filtered.getSuggestions(
        ["/hack skill:hack"],
        0,
        "/hack skill:hack".length,
        OPTIONS,
      ),
    ).toBe(original);
  });

  test("does not install a wrapper without a shadowed skill", () => {
    const getWrapper = captureWrapper([
      { name: "hack", source: "extension" },
      { name: "skill:gmail", source: "skill" },
    ]);
    expect(getWrapper()).toBeUndefined();
  });

  test("returns no suggestions when every result is a shadowed skill", async () => {
    const getWrapper = captureWrapper([
      { name: "hack", source: "extension" },
      { name: "skill:hack", source: "skill" },
    ]);
    const wrapper = getWrapper();
    expect(wrapper).toBeDefined();
    if (wrapper === undefined) throw new Error("autocomplete wrapper missing");
    const filtered = wrapper({
      async getSuggestions() {
        return {
          prefix: "/skill:h",
          items: [{ value: "skill:hack", label: "skill:hack" }],
        };
      },
      applyCompletion: (lines, cursorLine, cursorCol) => ({
        lines,
        cursorLine,
        cursorCol,
      }),
    });

    expect(
      await filtered.getSuggestions(["/skill:h"], 0, 8, OPTIONS),
    ).toBeNull();
  });
});
