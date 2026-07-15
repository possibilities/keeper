import { describe, expect, test } from "bun:test";
import {
  gumWriterHeight,
  gumWriterWidth,
  HELP,
  hasInteractiveNoteTty,
  type ProcessResult,
  type ProcessSpec,
  parseNoteArgs,
  runNoteCommand,
} from "../cli/note";
import type {
  ArchiveMetadata,
  MutationFailure,
  NoteDisposition,
  NoteDraft,
  NoteRow,
  NoteState,
  NoteStore,
} from "../src/note-store";

function note(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    note_id: "11111111-1111-4111-8111-111111111111",
    body: "hello from a note",
    state: "active",
    revision: 1,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    archived_at: null,
    archived_via: null,
    project_path: null,
    launch_triple: null,
    launch_handle: null,
    ...overrides,
  };
}

class FakeStore {
  readonly dbPath = "/tmp/notes.db";
  rows: NoteRow[] = [];
  drafts: NoteDraft[] = [];
  draftBodies = new Map<string, string>();
  creates: string[] = [];
  updates: Array<{ id: string; revision: number; body: string }> = [];
  archives: Array<{
    id: string;
    revision: number;
    disposition: NoteDisposition;
    metadata?: ArchiveMetadata;
  }> = [];
  removedDrafts: string[] = [];
  closed = false;

  close(): void {
    this.closed = true;
  }

  list(state: NoteState | "all"): NoteRow[] {
    return state === "all"
      ? [...this.rows]
      : this.rows.filter((row) => row.state === state);
  }

  get(id: string): NoteRow | null {
    return this.rows.find((row) => row.note_id === id) ?? null;
  }

  create(body: string): NoteRow {
    this.creates.push(body);
    const row = note({
      note_id: `22222222-2222-4222-8222-${String(this.rows.length + 1).padStart(12, "0")}`,
      body,
    });
    this.rows.push(row);
    return row;
  }

  update(
    id: string,
    revision: number,
    body: string,
  ):
    | { ok: true; note: NoteRow }
    | { ok: false; reason: MutationFailure["reason"] } {
    this.updates.push({ id, revision, body });
    const row = this.get(id);
    if (row === null) return { ok: false, reason: "not_found" };
    const next = { ...row, body, revision: revision + 1 };
    this.rows = this.rows.map((candidate) =>
      candidate.note_id === id ? next : candidate,
    );
    return { ok: true, note: next };
  }

  archive(
    id: string,
    revision: number,
    disposition: NoteDisposition,
    metadata?: ArchiveMetadata,
  ):
    | { ok: true; note: NoteRow }
    | { ok: false; reason: MutationFailure["reason"] } {
    this.archives.push({ id, revision, disposition, metadata });
    const row = this.get(id);
    if (row === null) return { ok: false, reason: "not_found" };
    const next: NoteRow = {
      ...row,
      state: "archived",
      revision: revision + 1,
      archived_at: 1_700_000_001_000,
      archived_via: disposition,
      project_path: metadata?.project_path ?? null,
      launch_triple: metadata?.launch_triple ?? null,
      launch_handle: metadata?.launch_handle ?? null,
    };
    this.rows = this.rows.map((candidate) =>
      candidate.note_id === id ? next : candidate,
    );
    return { ok: true, note: next };
  }

  createDraft(body = ""): NoteDraft {
    const draft: NoteDraft = {
      id: `draft-${this.drafts.length + 1}`,
      path: `/tmp/draft-${this.drafts.length + 1}.md`,
      mtime: this.drafts.length + 1,
    };
    this.drafts.push(draft);
    this.draftBodies.set(draft.id, body);
    return draft;
  }

  listDrafts(): NoteDraft[] {
    return [...this.drafts];
  }

  readDraft(id: string): string {
    const body = this.draftBodies.get(id);
    if (body === undefined) throw new Error("missing draft");
    return body;
  }

  writeDraft(id: string, body: string): void {
    if (!this.draftBodies.has(id)) throw new Error("missing draft");
    this.draftBodies.set(id, body);
  }

  removeDraft(id: string): void {
    this.removedDrafts.push(id);
    this.drafts = this.drafts.filter((draft) => draft.id !== id);
    this.draftBodies.delete(id);
  }
}

function result(code = 0, stdout = "", stderr = ""): ProcessResult {
  return { code, stdout, stderr };
}

function picker(index: number): ProcessResult {
  return result(0, `enter\n${index}\tchoice\n`);
}

function baseDeps(store: FakeStore, overrides: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    deps: {
      openStore: () => store as unknown as NoteStore,
      drafts: {
        create: (_dbPath: string, body: string) => store.createDraft(body),
        list: () => store.listDrafts(),
        read: (draft: NoteDraft) => store.readDraft(draft.id),
        write: (draft: NoteDraft, body: string) =>
          store.writeDraft(draft.id, body),
        remove: (draft: NoteDraft) => {
          store.removeDraft(draft.id);
          return true;
        },
      },
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      env: { EDITOR: "editor --wait", KEEPER_TMUX_SESSION: "work" },
      isTty: () => true,
      keeperBaseArgv: ["bun", "/keeper.ts"],
      promptPrefix: "/hack",
      backup: () => null,
      ...overrides,
    },
    out,
    err,
  };
}

describe("keeper note grammar", () => {
  test("parses verbs and state", () => {
    expect(parseNoteArgs([])).toEqual({ kind: "help" });
    expect(parseNoteArgs(["new"])).toEqual({ kind: "new", fresh: false });
    expect(parseNoteArgs(["new", "--fresh"])).toEqual({
      kind: "new",
      fresh: true,
    });
    expect(parseNoteArgs(["browse"])).toEqual({ kind: "browse" });
    expect(parseNoteArgs(["list", "--state=archived"])).toEqual({
      kind: "list",
      state: "archived",
    });
    expect(parseNoteArgs(["show", "n-1", "--raw"])).toEqual({
      kind: "show",
      noteId: "n-1",
      raw: true,
      preview: false,
    });
    expect(parseNoteArgs(["show", "n-1", "--raw", "--preview"])).toEqual({
      kind: "error",
      message: "show: --raw and --preview are mutually exclusive",
    });
    expect(parseNoteArgs(["wat"])).toEqual({
      kind: "error",
      message: "unknown verb 'wat'",
    });
  });

  test("help is pure and never opens the store", async () => {
    let opened = false;
    const out: string[] = [];
    const code = await runNoteCommand(["--help"], {
      openStore: () => {
        opened = true;
        throw new Error("must not open");
      },
      stdout: (text) => out.push(text),
    });
    expect(code).toBe(0);
    expect(opened).toBe(false);
    expect(out.join("")).toBe(HELP);
  });

  test("interactive TTY covers the editor and fzf descriptors", () => {
    expect(hasInteractiveNoteTty(true, true, true)).toBe(true);
    expect(hasInteractiveNoteTty(true, true, false)).toBe(false);
    expect(hasInteractiveNoteTty(true, false, true)).toBe(false);
    expect(hasInteractiveNoteTty(false, true, true)).toBe(false);
  });

  test("Gum fills the terminal while reserving its header and help rows", () => {
    expect(gumWriterHeight(50)).toBe(45);
    expect(gumWriterHeight(10)).toBe(5);
    expect(gumWriterHeight(undefined)).toBe(18);
    expect(gumWriterWidth(120)).toBe(118);
    expect(gumWriterWidth(10)).toBe(20);
    expect(gumWriterWidth(undefined)).toBe(78);
  });

  test("interactive verbs refuse a non-TTY before opening notes.db", async () => {
    let opened = false;
    const err: string[] = [];
    const code = await runNoteCommand(["new"], {
      openStore: () => {
        opened = true;
        throw new Error("must not open");
      },
      isTty: () => false,
      stderr: (text) => err.push(text),
      promptPrefix: null,
      keeperBaseArgv: ["bun", "/keeper.ts"],
    });
    expect(code).toBe(1);
    expect(opened).toBe(false);
    expect(err.join("")).toContain("interactive TTY required");
  });
});

describe("keeper note machine reads", () => {
  test("list emits summaries without bodies and closes the store", async () => {
    const store = new FakeStore();
    store.rows.push(note());
    const { deps, out } = baseDeps(store);
    const code = await runNoteCommand(["list"], deps);
    expect(code).toBe(0);
    const envelope = JSON.parse(out.join(""));
    expect(envelope.data.notes[0].summary).toBe("hello from a note");
    expect(envelope.data.notes[0].body).toBeUndefined();
    expect(store.closed).toBe(true);
  });

  test("show --raw writes the exact body", async () => {
    const store = new FakeStore();
    store.rows.push(note({ body: "exact\nbody\n" }));
    const { deps, out } = baseDeps(store);
    expect(
      await runNoteCommand(["show", store.rows[0].note_id, "--raw"], deps),
    ).toBe(0);
    expect(out.join("")).toBe("exact\nbody\n");
  });

  test("show --preview neutralizes terminal control bytes", async () => {
    const store = new FakeStore();
    store.rows.push(note({ body: "safe\u001b]52;c;payload\u0007\rnext\n" }));
    const { deps, out } = baseDeps(store);
    expect(
      await runNoteCommand(["show", store.rows[0].note_id, "--preview"], deps),
    ).toBe(0);
    expect(out.join("")).toBe("safe�]52;c;payload�\nnext\n");
  });

  test("a missing note emits the stable failure envelope", async () => {
    const store = new FakeStore();
    const { deps, out } = baseDeps(store);
    expect(await runNoteCommand(["show", "missing", "--raw"], deps)).toBe(1);
    expect(JSON.parse(out.join(""))).toMatchObject({
      ok: false,
      error: { code: "note_not_found" },
      data: null,
    });
  });
});

describe("keeper note browser", () => {
  test("keeps note ids hidden while passing them to the preview command", async () => {
    const store = new FakeStore();
    const note = store.create("preview body");
    const calls: ProcessSpec[] = [];
    const { deps } = baseDeps(store, {
      runProcess: async (spec: ProcessSpec) => {
        calls.push(spec);
        return result(130);
      },
    });

    expect(await runNoteCommand(["browse"], deps)).toBe(0);
    expect(calls[0].argv).toContain("--with-nth=2");
    expect(calls[0].argv).toContain("--no-popup");
    expect(calls[0].stderrMode).toBe("inherit");
    expect(
      calls[0].argv.some((arg) => arg.includes("note show {3} --preview")),
    ).toBe(true);
    expect(calls[0].stdin).toContain(`\t${note.note_id}\n`);
  });
});

describe("keeper note capture lifecycle", () => {
  test("new -> editor -> save persists active and removes the draft", async () => {
    const store = new FakeStore();
    const calls: ProcessSpec[] = [];
    const { deps, out } = baseDeps(store, {
      runProcess: async (spec: ProcessSpec) => {
        calls.push(spec);
        if (spec.argv[0] === "editor") {
          const draft = store.drafts[0];
          store.draftBodies.set(draft.id, "captured text");
          return result();
        }
        return picker(0);
      },
    });
    expect(await runNoteCommand(["new"], deps)).toBe(0);
    expect(calls[0].argv).toEqual(["editor", "--wait", "/tmp/draft-1.md"]);
    expect(store.creates).toEqual(["captured text"]);
    expect(store.removedDrafts).toEqual(["draft-1"]);
    expect(store.archives).toEqual([]);
    expect(out.join("")).toContain("Saved active note");
  });

  test("new --fresh opens Gum before any draft recovery menu", async () => {
    const store = new FakeStore();
    store.createDraft("unfinished older draft");
    const calls: ProcessSpec[] = [];
    const { deps } = baseDeps(store, {
      runProcess: async (spec: ProcessSpec) => {
        calls.push(spec);
        if (spec.argv[0] === "gum") return result(0, "fresh capture\n");
        return picker(0);
      },
    });

    expect(await runNoteCommand(["new", "--fresh"], deps)).toBe(0);
    expect(calls[0].argv.slice(0, 2)).toEqual(["gum", "write"]);
    expect(calls[0].argv).toContain(
      "--header=New Note · Enter: continue · Ctrl-E: open $EDITOR · Esc: cancel",
    );
    expect(calls[0].stdinMode).toBe("inherit");
    expect(calls[0].stderrMode).toBe("gum-filter");
    expect(store.creates).toEqual(["fresh capture"]);
    expect(store.removedDrafts).toEqual(["draft-2"]);
    expect(store.drafts.map((draft) => draft.id)).toEqual(["draft-1"]);
  });

  test("canceling Gum preserves the fresh draft without opening an action picker", async () => {
    const store = new FakeStore();
    const calls: ProcessSpec[] = [];
    const { deps, err } = baseDeps(store, {
      runProcess: async (spec: ProcessSpec) => {
        calls.push(spec);
        return result(1);
      },
    });

    expect(await runNoteCommand(["new", "--fresh"], deps)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].argv.slice(0, 2)).toEqual(["gum", "write"]);
    expect(store.drafts).toHaveLength(1);
    expect(store.creates).toEqual([]);
    expect(err).toEqual([]);
  });

  test("a backup exception does not turn a committed save into a failure", async () => {
    const store = new FakeStore();
    const { deps, out, err } = baseDeps(store, {
      runProcess: async (spec: ProcessSpec) => {
        if (spec.argv[0] === "editor") {
          store.draftBodies.set(store.drafts[0].id, "durable first");
          return result();
        }
        return picker(0);
      },
      backup: () => {
        throw new Error("backup disk unavailable");
      },
    });

    expect(await runNoteCommand(["new"], deps)).toBe(0);
    expect(store.creates).toEqual(["durable first"]);
    expect(out.join("")).toContain("Saved active note");
    expect(err.join("")).toContain("note committed, but backup threw");
  });

  test("send wizard Back returns to the prior step without losing the draft", async () => {
    const store = new FakeStore();
    const fzf = [
      picker(2),
      picker(0),
      result(0, "ctrl-b\n"),
      result(130),
      picker(4),
    ];
    const calls: ProcessSpec[] = [];
    const { deps } = baseDeps(store, {
      runProcess: async (spec: ProcessSpec) => {
        calls.push(spec);
        if (spec.argv[0] === "editor") {
          store.draftBodies.set(store.drafts[0].id, "backtrack me");
          return result();
        }
        if (spec.argv[0] === "fzf") return fzf.shift() ?? result(130);
        if (spec.argv.includes("projects")) {
          return result(
            0,
            JSON.stringify({
              ok: true,
              data: {
                projects: [{ name: "keeper", path: "/code/keeper" }],
              },
            }),
          );
        }
        if (spec.argv.includes("presets")) {
          return result(
            0,
            JSON.stringify({
              kind: "presets-list",
              harnesses: [
                {
                  harness: "pi",
                  triples: [
                    {
                      triple: "pi::model::high",
                      capability: "model",
                      native_id: "model",
                      effort: "high",
                    },
                  ],
                },
              ],
            }),
          );
        }
        return result(1, "", "unexpected process");
      },
    });

    expect(await runNoteCommand(["new"], deps)).toBe(0);
    const projectPickers = calls.filter((call) =>
      call.argv.includes("--prompt=Project> "),
    );
    expect(projectPickers).toHaveLength(2);
    expect(store.creates).toEqual([]);
    expect(store.removedDrafts).toEqual(["draft-1"]);
  });

  test("clipboard failure leaves the newly persisted note active", async () => {
    const store = new FakeStore();
    const { deps, err } = baseDeps(store, {
      runProcess: async (spec: ProcessSpec) => {
        if (spec.argv[0] === "editor") {
          store.draftBodies.set(store.drafts[0].id, "copy me");
          return result();
        }
        return picker(1);
      },
      copy: async () => ({ ok: false as const, error: "pbcopy broke" }),
    });
    expect(await runNoteCommand(["new"], deps)).toBe(1);
    expect(store.creates).toEqual(["copy me"]);
    expect(store.archives).toEqual([]);
    expect(store.rows[0].state).toBe("active");
    expect(err.join("")).toContain("note remains active");
  });

  test("an archive conflict after copy leaves the note active and warns of duplication", async () => {
    const store = new FakeStore();
    const { deps, err } = baseDeps(store, {
      runProcess: async (spec: ProcessSpec) => {
        if (spec.argv[0] === "editor") {
          store.draftBodies.set(store.drafts[0].id, "copy raced");
          return result();
        }
        return picker(1);
      },
      copy: async () => ({ ok: true as const }),
    });
    store.archive = () => ({ ok: false, reason: "conflict" });

    expect(await runNoteCommand(["new"], deps)).toBe(1);
    expect(store.rows[0].state).toBe("active");
    expect(err.join("")).toContain("retrying may copy twice");
  });

  test("clipboard success archives after the copy acknowledgment", async () => {
    const store = new FakeStore();
    const order: string[] = [];
    const { deps } = baseDeps(store, {
      runProcess: async (spec: ProcessSpec) => {
        if (spec.argv[0] === "editor") {
          store.draftBodies.set(store.drafts[0].id, "copy me");
          return result();
        }
        return picker(1);
      },
      copy: async () => {
        order.push("copy");
        return { ok: true as const };
      },
    });
    const originalArchive = store.archive.bind(store);
    store.archive = (...args: Parameters<FakeStore["archive"]>) => {
      order.push("archive");
      return originalArchive(...args);
    };
    expect(await runNoteCommand(["new"], deps)).toBe(0);
    expect(order).toEqual(["copy", "archive"]);
    expect(store.rows[0].state).toBe("archived");
    expect(store.rows[0].archived_via).toBe("clipboard");
  });

  test("send wizard carries exact project/triple into detached launch and archive", async () => {
    const store = new FakeStore();
    const calls: ProcessSpec[] = [];
    const fzf = [
      picker(2),
      picker(0),
      picker(0),
      picker(0),
      picker(0),
      picker(0),
    ];
    const projects = JSON.stringify({
      schema_version: 1,
      ok: true,
      error: null,
      data: {
        projects: [{ name: "keeper", path: "/code/keeper", root_name: "code" }],
      },
    });
    const triples = JSON.stringify({
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
      ],
    });
    const { deps } = baseDeps(store, {
      runProcess: async (spec: ProcessSpec) => {
        calls.push(spec);
        if (spec.argv[0] === "editor") {
          store.draftBodies.set(store.drafts[0].id, "ship this");
          return result();
        }
        if (spec.argv[0] === "fzf") return fzf.shift() ?? result(130);
        if (spec.argv.includes("projects")) return result(0, projects);
        if (spec.argv.includes("presets")) return result(0, triples);
        return result(
          0,
          JSON.stringify({
            schema_version: 1,
            id: "tmux-handle-1",
            agent: "pi",
            cwd: "/code/keeper",
          }),
        );
      },
    });
    expect(await runNoteCommand(["new"], deps)).toBe(0);
    const launch = calls.find(
      (call) => call.argv.includes("agent") && call.argv.includes("--x-preset"),
    );
    expect(launch).toBeDefined();
    expect(launch?.cwd).toBe("/code/keeper");
    expect(launch?.env?.PWD).toBe("/code/keeper");
    expect(launch?.argv).toContain("pi::openai-codex/gpt-5.4::high");
    expect(launch?.argv.at(-1)).toBe("/skill:hack ship this");
    const pickerCalls = calls.filter((call) => call.argv[0] === "fzf");
    expect(pickerCalls[3].argv.join("\n")).toContain(
      "Project: keeper (/code/keeper)\nHarness: pi\nModel: —",
    );
    expect(pickerCalls[5].argv.join("\n")).toContain(
      "Model: openai-codex/gpt-5.4\nEffort: high\nChoosing: confirm",
    );
    expect(store.archives[0]).toMatchObject({
      disposition: "agent",
      metadata: {
        project_path: "/code/keeper",
        launch_triple: "pi::openai-codex/gpt-5.4::high",
        launch_handle: "tmux-handle-1",
      },
    });
  });
});
