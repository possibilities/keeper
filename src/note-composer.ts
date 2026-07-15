import type {
  BoxRenderable as BoxRenderableType,
  CliRenderer,
  TextareaRenderable as TextareaRenderableType,
  TextRenderable as TextRenderableType,
} from "@opentui/core";

export interface NoteComposerRuntime {
  readonly BoxRenderable: typeof BoxRenderableType;
  readonly TextareaRenderable: typeof TextareaRenderableType;
  readonly TextRenderable: typeof TextRenderableType;
}

export interface NoteComposerEditorResult {
  readonly body: string;
  readonly error?: string;
}

export interface NoteComposerOptions {
  readonly initialText: string;
  readonly persist: (body: string) => void;
  readonly openEditor: () => NoteComposerEditorResult;
  readonly onSubmit: (body: string) => void;
  readonly onCancel: (body: string) => void;
  readonly onFatal?: (error: unknown) => void;
}

export interface NoteComposerApp {
  readonly renderer: CliRenderer;
  readonly textarea: TextareaRenderableType;
  readonly footer: TextRenderableType;
  destroy(): void;
}

function keyIsEnter(name: string): boolean {
  return name === "return" || name === "enter" || name === "kpenter";
}

/**
 * Mount the standalone Note composer. It owns one terminal surface: no tmux
 * calls, child PTY, or overlay. Ctrl-G temporarily cedes that terminal through
 * OpenTUI's suspend/resume pair while the blocking editor runs.
 */
export function attachNoteComposer(
  renderer: CliRenderer,
  runtime: NoteComposerRuntime,
  options: NoteComposerOptions,
): NoteComposerApp {
  let destroyed = false;
  let editorActive = false;

  const root = new runtime.BoxRenderable(renderer, {
    id: "note-composer-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });
  const header = new runtime.TextRenderable(renderer, {
    id: "note-composer-header",
    width: "100%",
    height: 1,
    content: "New Note",
  });
  const textarea = new runtime.TextareaRenderable(renderer, {
    id: "note-composer-textarea",
    width: "100%",
    flexGrow: 1,
    initialValue: options.initialText,
    placeholder: "Write a note…",
    wrapMode: "word",
  });
  const footer = new runtime.TextRenderable(renderer, {
    id: "note-composer-footer",
    width: "100%",
    height: 1,
    content:
      "Enter continue  ·  Shift-Enter/Ctrl-J newline  ·  Ctrl-G $EDITOR  ·  Esc cancel",
  });
  root.add(header);
  root.add(textarea);
  root.add(footer);
  renderer.root.add(root);

  function setStatus(message: string): void {
    footer.content = message;
    renderer.requestRender();
  }

  function persist(body: string): boolean {
    try {
      options.persist(body);
      return true;
    } catch (error) {
      setStatus(`Draft write failed: ${String(error)}`);
      return false;
    }
  }

  textarea.gotoBufferEnd();
  textarea.onContentChange = () => {
    if (!destroyed && !editorActive) persist(textarea.plainText);
  };

  function consume(key: {
    preventDefault(): void;
    stopPropagation(): void;
  }): void {
    key.preventDefault();
    key.stopPropagation();
  }

  function insertNewline(key: {
    preventDefault(): void;
    stopPropagation(): void;
  }): void {
    consume(key);
    textarea.newLine();
    renderer.requestRender();
  }

  function submit(key: {
    preventDefault(): void;
    stopPropagation(): void;
  }): void {
    consume(key);
    const body = textarea.plainText;
    if (!persist(body)) return;
    options.onSubmit(body);
  }

  function cancel(key: {
    preventDefault(): void;
    stopPropagation(): void;
  }): void {
    consume(key);
    const body = textarea.plainText;
    if (!persist(body)) return;
    options.onCancel(body);
  }

  function cedeToEditor(key: {
    preventDefault(): void;
    stopPropagation(): void;
  }): void {
    consume(key);
    if (editorActive || destroyed) return;
    if (!persist(textarea.plainText)) return;

    editorActive = true;
    textarea.blur();
    let suspended = false;
    let result: NoteComposerEditorResult | null = null;
    let error: unknown = null;
    let resumeError: unknown = null;
    try {
      renderer.suspend();
      suspended = true;
      result = options.openEditor();
    } catch (caught) {
      error = caught;
    } finally {
      if (suspended) {
        try {
          renderer.resume();
        } catch (caught) {
          resumeError = caught;
        }
      }
      editorActive = false;
    }

    if (resumeError !== null) {
      if (options.onFatal !== undefined) options.onFatal(resumeError);
      else setStatus(`Editor resume failed: ${String(resumeError)}`);
      return;
    }

    if (result !== null) {
      textarea.setText(result.body);
      textarea.gotoBufferEnd();
      persist(result.body);
    }
    textarea.focus();
    if (error !== null) setStatus(`Editor handoff failed: ${String(error)}`);
    else if (result?.error !== undefined) setStatus(result.error);
    else
      setStatus(
        "Enter continue  ·  Shift-Enter/Ctrl-J newline  ·  Ctrl-G $EDITOR  ·  Esc cancel",
      );
    renderer.requestRender();
  }

  const onKeypress = (key: {
    name: string;
    ctrl: boolean;
    shift: boolean;
    meta: boolean;
    preventDefault(): void;
    stopPropagation(): void;
  }): void => {
    if (destroyed || editorActive || key.meta) return;
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      cancel(key);
      return;
    }
    if (key.ctrl && key.name === "g") {
      cedeToEditor(key);
      return;
    }
    if (
      (key.ctrl && key.name === "j") ||
      (key.name === "linefeed" && !key.shift)
    ) {
      insertNewline(key);
      return;
    }
    if (keyIsEnter(key.name)) {
      if (key.shift) insertNewline(key);
      else if (!key.ctrl) submit(key);
    }
  };

  renderer.keyInput.on("keypress", onKeypress);
  textarea.focus();
  renderer.requestRender();

  return {
    renderer,
    textarea,
    footer,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      renderer.keyInput.off("keypress", onKeypress);
      try {
        renderer.destroy();
      } catch {
        // Terminal restoration is best-effort and idempotent.
      }
    },
  };
}

export interface NoteComposerRequest {
  readonly initialText: string;
  readonly persist: (body: string) => void;
  readonly reload: () => string;
  readonly editorArgv: readonly string[];
}

export type NoteComposerOutcome =
  | { readonly kind: "submitted"; readonly body: string }
  | { readonly kind: "cancelled"; readonly body: string };

export interface NoteComposerDeps {
  readonly buildRenderer?: () => Promise<{
    renderer: CliRenderer;
    runtime: NoteComposerRuntime;
  }>;
  readonly runEditor?: (argv: readonly string[]) => {
    exitCode: number | null;
  };
}

async function defaultBuildRenderer(): Promise<{
  renderer: CliRenderer;
  runtime: NoteComposerRuntime;
}> {
  const otui = await import("@opentui/core");
  const renderer = await otui.createCliRenderer({
    exitOnCtrlC: false,
    // The shell below owns these signals so draft persistence and teardown
    // happen before the default Unix signal is re-raised.
    exitSignals: [],
    autoFocus: false,
    screenMode: "alternate-screen",
    useKittyKeyboard: { disambiguate: true, alternateKeys: true },
  });
  return {
    renderer,
    runtime: {
      BoxRenderable: otui.BoxRenderable,
      TextareaRenderable: otui.TextareaRenderable,
      TextRenderable: otui.TextRenderable,
    },
  };
}

function defaultRunEditor(argv: readonly string[]): {
  exitCode: number | null;
} {
  return Bun.spawnSync([...argv], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

/** Run one standalone composer and resolve only after OpenTUI restores the TTY. */
export async function runNoteComposer(
  request: NoteComposerRequest,
  deps: NoteComposerDeps = {},
): Promise<NoteComposerOutcome> {
  if (
    process.stdin.isTTY !== true ||
    process.stdout.isTTY !== true ||
    process.stderr.isTTY !== true
  ) {
    throw new Error("interactive TTY required for Note composer");
  }
  const bundle = await (deps.buildRenderer ?? defaultBuildRenderer)();
  const runEditor = deps.runEditor ?? defaultRunEditor;

  return await new Promise<NoteComposerOutcome>((resolve, reject) => {
    let app: NoteComposerApp | null = null;
    let settled = false;
    const signals = ["SIGTERM", "SIGHUP", "SIGQUIT"] as const;
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const disarmSignals = (): void => {
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
      signalHandlers.clear();
    };
    const destroy = (): void => {
      if (app !== null) app.destroy();
      else {
        try {
          bundle.renderer.destroy();
        } catch {
          // Best-effort restoration while attachment is still incomplete.
        }
      }
    };
    const finish = (outcome: NoteComposerOutcome): void => {
      if (settled) return;
      settled = true;
      disarmSignals();
      destroy();
      resolve(outcome);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      disarmSignals();
      destroy();
      reject(error);
    };
    for (const signal of signals) {
      const handler = (): void => {
        if (settled) return;
        settled = true;
        disarmSignals();
        destroy();
        try {
          // Restore the default Unix disposition after the terminal is sane.
          process.kill(process.pid, signal);
        } catch (error) {
          reject(error);
        }
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }

    try {
      app = attachNoteComposer(bundle.renderer, bundle.runtime, {
        initialText: request.initialText,
        persist: request.persist,
        openEditor: () => {
          const result = runEditor(request.editorArgv);
          const body = request.reload();
          return result.exitCode === 0
            ? { body }
            : {
                body,
                error: `Editor exited ${result.exitCode ?? "by signal"}; draft preserved`,
              };
        },
        onSubmit: (body) => finish({ kind: "submitted", body }),
        onCancel: (body) => finish({ kind: "cancelled", body }),
        onFatal: fail,
      });
    } catch (error) {
      fail(error);
    }
  });
}
