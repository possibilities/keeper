import { describe, expect, test } from "bun:test";
import {
  installPiEditorBorder,
  type LoadEditorHostModules,
  orangeEditorLabel,
  orangeEditorText,
} from "../plugins/keeper/pi-extension/editor-border";

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

class FakeEditor {
  borderColor = (text: string): string => `native(${text})`;

  render(width: number): string[] {
    const border = "─".repeat(width);
    return [this.borderColor(border), "❯ ", this.borderColor(border)];
  }
}

function fakeLoader(onLoad?: () => void): LoadEditorHostModules {
  return async () => {
    onLoad?.();
    return {
      CustomEditor: FakeEditor,
      visibleWidth: (text) => text.replace(ANSI_RE, "").length,
      truncateToWidth: (text, width) =>
        orangeEditorText(text.replace(ANSI_RE, "").slice(0, width)),
    };
  };
}

describe("Pi editor border", () => {
  test("renders a live top-right Session title with a trailing border rune", async () => {
    let name = "keeper-pi";
    let factory:
      | ((tui: unknown, theme: unknown, keybindings: unknown) => FakeEditor)
      | undefined;
    await installPiEditorBorder(
      { getSessionName: () => name },
      {
        mode: "tui",
        ui: {
          setEditorComponent(next) {
            factory = next as typeof factory;
          },
        },
      },
      fakeLoader(),
    );

    if (factory === undefined) throw new Error("editor factory not installed");
    const editor = factory({}, {}, {});
    const first = editor.render(30);
    expect(first[0]).toEndWith(
      orangeEditorLabel(" keeper-pi ") + orangeEditorText("──"),
    );
    expect(first[2]).toBe(orangeEditorText("─".repeat(30)));

    name = "renamed";
    expect(editor.render(30)[0]).toEndWith(
      orangeEditorLabel(" renamed ") + orangeEditorText("──"),
    );
  });

  test("reasserts orange after Pi replaces the mode border color", async () => {
    let factory:
      | ((tui: unknown, theme: unknown, keybindings: unknown) => FakeEditor)
      | undefined;
    await installPiEditorBorder(
      { getSessionName: () => "pi" },
      {
        ui: {
          setEditorComponent: (next) => {
            factory = next as typeof factory;
          },
        },
      },
      fakeLoader(),
    );
    if (factory === undefined) throw new Error("editor factory not installed");
    const editor = factory({}, {}, {});
    editor.borderColor = (text) => `thinking(${text})`;
    expect(editor.render(20)[2]).toBe(orangeEditorText("─".repeat(20)));
  });

  test("preserves a caller editor and skips host loading", async () => {
    let loaded = false;
    let installed = false;
    await installPiEditorBorder(
      { getSessionName: () => "pi" },
      {
        mode: "tui",
        ui: {
          getEditorComponent: () => () => "caller-editor",
          setEditorComponent: () => {
            installed = true;
          },
        },
      },
      fakeLoader(() => {
        loaded = true;
      }),
    );
    expect(loaded).toBe(false);
    expect(installed).toBe(false);
  });

  test("is a no-op outside TUI mode and swallows host loader failures", async () => {
    let installed = false;
    const context = {
      ui: {
        setEditorComponent: () => {
          installed = true;
        },
      },
    };
    await expect(
      installPiEditorBorder(
        { getSessionName: () => "pi" },
        { ...context, mode: "rpc" },
        fakeLoader(),
      ),
    ).resolves.toBeUndefined();
    await expect(
      installPiEditorBorder(
        { getSessionName: () => "pi" },
        context,
        async () => {
          throw new Error("host package unavailable");
        },
      ),
    ).resolves.toBeUndefined();
    expect(installed).toBe(false);
  });
});
