/**
 * Headless OpenTUI contract for Keeper's multiline Note composer.
 *
 * SERIAL-SAFE CHAIN MAINTENANCE: this file imports `@opentui/core` runtime
 * values, so it MUST remain in `OPEN_TUI_FILES` and package.json's serialized
 * `test:opentui` chain.
 */

import { afterEach, beforeAll, expect, test } from "bun:test";
import {
  BoxRenderable,
  TextareaRenderable,
  TextRenderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { attachNoteComposer, type NoteComposerApp } from "../src/note-composer";
import { retryUntil } from "./helpers/retry-until";

const RUNTIME = {
  BoxRenderable,
  TextareaRenderable,
  TextRenderable,
} as const;

beforeAll(() => {
  process.env.OTUI_USE_CONSOLE = "false";
});

const pendingApps: NoteComposerApp[] = [];
afterEach(() => {
  while (pendingApps.length > 0) pendingApps.pop()?.destroy();
});

async function boot(initialText = "") {
  const setup = await createTestRenderer({
    width: 80,
    height: 20,
    exitSignals: [],
    kittyKeyboard: true,
    otherModifiersMode: true,
  });
  const persisted: string[] = [];
  const persistAttempts: string[] = [];
  const submitted: string[] = [];
  const cancelled: string[] = [];
  const fatal: unknown[] = [];
  let persistError: Error | null = null;
  let editorBody = "edited outside\nwith exact bytes\n";
  let editorHook = (): void => {};
  const app = attachNoteComposer(setup.renderer, RUNTIME, {
    initialText,
    persist: (body) => {
      persistAttempts.push(body);
      if (persistError !== null) throw persistError;
      persisted.push(body);
    },
    openEditor: () => {
      editorHook();
      return { body: editorBody };
    },
    onSubmit: (body) => submitted.push(body),
    onCancel: (body) => cancelled.push(body),
    onFatal: (error) => fatal.push(error),
  });
  pendingApps.push(app);
  return {
    setup,
    app,
    persisted,
    persistAttempts,
    submitted,
    cancelled,
    fatal,
    setEditorBody: (body: string) => {
      editorBody = body;
    },
    setEditorHook: (hook: () => void) => {
      editorHook = hook;
    },
    setPersistError: (error: Error | null) => {
      persistError = error;
    },
  };
}

test("Enter submits while Shift-Enter and Ctrl-J insert exact newlines", async () => {
  const { setup, app, persisted, submitted } = await boot("alpha");

  setup.mockInput.pressEnter({ shift: true });
  await setup.mockInput.typeText("beta");
  setup.mockInput.pressKey("j", { ctrl: true });
  await setup.mockInput.typeText("gamma");
  expect(app.textarea.plainText).toBe("alpha\nbeta\ngamma");

  setup.mockInput.pressEnter();
  expect(submitted).toEqual(["alpha\nbeta\ngamma"]);
  expect(persisted.at(-1)).toBe("alpha\nbeta\ngamma");
});

test("Ctrl-G persists, suspends, edits, resumes, reloads, and refocuses", async () => {
  const { setup, app, persisted, setEditorBody, setEditorHook } =
    await boot("before");
  const order: string[] = [];
  const suspend = setup.renderer.suspend.bind(setup.renderer);
  const resume = setup.renderer.resume.bind(setup.renderer);
  setup.renderer.suspend = () => {
    order.push(`suspend:${persisted.at(-1)}`);
  };
  setup.renderer.resume = () => {
    order.push("resume");
  };
  setEditorBody("from $EDITOR\n");
  setEditorHook(() => order.push(`editor:${persisted.at(-1)}`));

  setup.mockInput.pressKey("g", { ctrl: true });

  expect(order).toEqual(["suspend:before", "editor:before", "resume"]);
  expect(app.textarea.plainText).toBe("from $EDITOR\n");
  expect(app.textarea.focused).toBe(true);
  expect(persisted.at(-1)).toBe("from $EDITOR\n");

  setup.renderer.suspend = suspend;
  setup.renderer.resume = resume;
});

test("Esc quietly cancels with the latest draft preserved", async () => {
  const { setup, app, persisted, cancelled } = await boot();
  await setup.mockInput.typeText("keep this");
  setup.mockInput.pressEscape();
  await retryUntil(() => (cancelled.length === 1 ? true : null), 1_000, 5);

  expect(cancelled).toEqual(["keep this"]);
  expect(persisted.at(-1)).toBe("keep this");
  expect(app.textarea.plainText).toBe("keep this");
});

test("Esc refuses to settle when the latest draft write fails", async () => {
  const { setup, app, persistAttempts, cancelled, setPersistError } =
    await boot("older");
  setPersistError(new Error("disk full"));
  await setup.mockInput.typeText("x");
  setup.mockInput.pressEscape();
  await retryUntil(
    () =>
      persistAttempts.filter((body) => body === "olderx").length >= 2
        ? true
        : null,
    1_000,
    5,
  );

  expect(cancelled).toEqual([]);
  expect(app.textarea.plainText).toBe("olderx");
});

test("a failed resume is fatal instead of leaving an unreachable composer", async () => {
  const { setup, fatal } = await boot("safe draft");
  const failure = new Error("resume failed");
  setup.renderer.suspend = () => {};
  setup.renderer.resume = () => {
    throw failure;
  };

  setup.mockInput.pressKey("g", { ctrl: true });

  expect(fatal).toEqual([failure]);
});
