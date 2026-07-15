#!/usr/bin/env bun
/**
 * `keeper note` — a private text inbox backed by its own notes.db.
 *
 * Interactive effects stay outside SQLite transactions: editor/fzf/clipboard/
 * agent processes run first or between short optimistic mutations. Copy/send
 * archive only after the external action acknowledges success; a failure leaves
 * the note active and visible for retry.
 */

import {
  type AgentCli,
  buildAgentLaunchArgv,
} from "../src/agent/launch-config";
import { parseTriple } from "../src/agent/triple";
import { type CopyResult, copyToClipboard } from "../src/clipboard";
import { resolveConfig, resolveKeeperAgentPath } from "../src/db";
import { validatePromptBytes } from "../src/dispatch-command";
import { backupNotesIfDue } from "../src/note-backup";
import {
  type ArchiveMetadata,
  createNoteDraft,
  listNoteDrafts,
  type NoteDraft,
  type NoteRow,
  type NoteState,
  NoteStore,
  readNoteDraft,
  removeNoteDraft,
  writeNoteDraft,
} from "../src/note-store";
import {
  decodePickerOutput,
  encodePickerChoices,
  formatWizardHeader,
  type NoteLaunchChoice,
  type NoteProjectChoice,
  type NoteSendSelection,
  noteSummary,
  type PickerChoice,
  type PickerResult,
  parseCommandWords,
  parseJsonObjectFromOutput,
  parseLaunchChoices,
  parseRankedProjects,
  sanitizePickerLabel,
  sanitizeTerminalPreview,
  shellQuote,
  uniqueOrdered,
} from "../src/note-workflow";
import { applyDispatchPromptPrefix } from "../src/prompt-prefix";

export const NOTE_CLI_SCHEMA_VERSION = 1;
const DISCOVERY_TIMEOUT_MS = 10_000;
const AGENT_LAUNCH_TIMEOUT_MS = 30_000;

export const HELP = `keeper note — capture, process, and browse private text notes

Usage:
  keeper note new [--fresh]
  keeper note browse
  keeper note list [--state active|archived|all]
  keeper note show <note-id> [--raw|--preview]
  keeper note --help

Interactive commands:
  new       Recover an unfinished draft in $EDITOR, or pass --fresh to open a
            blank Gum writer before Save / Copy / Send / Discard.
            Gum: Enter continues, Ctrl-J inserts a newline, Ctrl-E opens
            $VISUAL/$EDITOR with the current text, and Esc preserves the draft.
  browse    Browse active notes; Ctrl-T toggles view-only archived history.

Send wizard: choose project → harness → model → effort; Ctrl-B moves back.

Machine commands:
  list      Emit a JSON envelope of note summaries (default: active).
  show      Emit one JSON note; --raw is exact, --preview is terminal-safe.

Copy and Send persist a new note as active before the external action and archive
it only after success. If the external action succeeds but the archive write is
interrupted, the note can remain active and a retry can duplicate that action.

Tmux owns popup policy. Running keeper setup-tmux installs Keeper's opt-in
prefix-N fresh-capture and prefix-B browse popup drop-in when tmux.conf sources
~/.config/tmux/conf.d/*.conf.
`;

export interface ProcessSpec {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  stdinMode?: "pipe" | "inherit";
  stdio?: "capture" | "inherit";
  stderrMode?: "capture" | "inherit" | "gum-filter";
  timeoutMs?: number;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type NoteProcessRunner = (spec: ProcessSpec) => Promise<ProcessResult>;

export interface NoteDraftOps {
  create: (dbPath: string, body: string) => NoteDraft;
  list: (dbPath: string) => NoteDraft[];
  read: (draft: NoteDraft) => string;
  write: (draft: NoteDraft, body: string) => void;
  remove: (draft: NoteDraft) => boolean;
}

export interface NoteCliDeps {
  openStore?: () => NoteStore;
  drafts?: NoteDraftOps;
  runProcess?: NoteProcessRunner;
  copy?: (body: string) => Promise<CopyResult>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  env?: Record<string, string | undefined>;
  isTty?: () => boolean;
  keeperBaseArgv?: readonly string[];
  promptPrefix?: string | null;
  tmuxSession?: string;
  backup?: (
    notesDbPath: string,
  ) => { verified: boolean; error: string | null } | null;
}

interface ResolvedDeps {
  openStore: () => NoteStore;
  drafts: NoteDraftOps;
  runProcess: NoteProcessRunner;
  copy: (body: string) => Promise<CopyResult>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  isTty: () => boolean;
  keeperBaseArgv: readonly string[];
  promptPrefix: string | null;
  tmuxSession: string;
  backup: (
    notesDbPath: string,
  ) => { verified: boolean; error: string | null } | null;
}

type ParsedNoteCommand =
  | { kind: "help" }
  | { kind: "new"; fresh: boolean }
  | { kind: "browse" }
  | { kind: "list"; state: NoteState | "all" }
  | { kind: "show"; noteId: string; raw: boolean; preview: boolean }
  | { kind: "error"; message: string };

interface SendTarget {
  project: NoteProjectChoice;
  choice: NoteLaunchChoice;
}

export function hasInteractiveNoteTty(
  stdinIsTty: boolean | undefined = process.stdin.isTTY,
  stdoutIsTty: boolean | undefined = process.stdout.isTTY,
  stderrIsTty: boolean | undefined = process.stderr.isTTY,
): boolean {
  return stdinIsTty === true && stdoutIsTty === true && stderrIsTty === true;
}

/** Fill the terminal while reserving rows for Gum's header and help footer. */
export function gumWriterHeight(terminalRows?: number): number {
  if (
    terminalRows === undefined ||
    !Number.isFinite(terminalRows) ||
    terminalRows <= 0
  ) {
    return 18;
  }
  return Math.max(5, Math.floor(terminalRows) - 5);
}

/** Gum loses terminal-width discovery when stderr passes through our filter. */
export function gumWriterWidth(terminalColumns?: number): number {
  if (
    terminalColumns === undefined ||
    !Number.isFinite(terminalColumns) ||
    terminalColumns <= 0
  ) {
    return 78;
  }
  return Math.max(20, Math.floor(terminalColumns) - 2);
}

function stringEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function relayGumStderr(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const holdBytes = Buffer.byteLength("not submitted\r\n");
  let pending = Buffer.alloc(0);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending = Buffer.concat([pending, Buffer.from(value)]);
    if (pending.length > holdBytes) {
      const emitLength = pending.length - holdBytes;
      process.stderr.write(pending.subarray(0, emitLength));
      pending = pending.subarray(emitLength);
    }
  }
  const tail = pending.toString("utf8");
  const cancelSuffix = tail.endsWith("not submitted\r\n")
    ? "not submitted\r\n"
    : tail.endsWith("not submitted\n")
      ? "not submitted\n"
      : null;
  if (cancelSuffix !== null) {
    const prefix = pending.subarray(
      0,
      pending.length - Buffer.byteLength(cancelSuffix),
    );
    if (prefix.length > 0) process.stderr.write(prefix);
    return "";
  }
  if (pending.length > 0) process.stderr.write(pending);
  return tail;
}

async function defaultRunProcess(spec: ProcessSpec): Promise<ProcessResult> {
  const inherited = spec.stdio === "inherit";
  const inheritStdin = inherited || spec.stdinMode === "inherit";
  const inheritStderr = inherited || spec.stderrMode === "inherit";
  const filterGumStderr = spec.stderrMode === "gum-filter";
  try {
    const proc = Bun.spawn(spec.argv, {
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env: { ...stringEnv(process.env), ...(spec.env ?? {}) },
      stdin: inheritStdin ? "inherit" : "pipe",
      stdout: inherited ? "inherit" : "pipe",
      stderr: inheritStderr ? "inherit" : "pipe",
    });

    if (!inheritStdin) {
      const stdin = proc.stdin;
      if (stdin === undefined) {
        throw new Error(
          "spawned process did not expose the requested stdin pipe",
        );
      }
      if (spec.stdin !== undefined) stdin.write(spec.stdin);
      await stdin.end();
    }

    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    const timer =
      spec.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            try {
              proc.kill("SIGTERM");
            } catch {
              // The process may have exited between the timer and kill.
            }
            forceKillTimer = setTimeout(() => {
              try {
                proc.kill("SIGKILL");
              } catch {
                // The process exited during the termination grace.
              }
            }, 1_000);
          }, spec.timeoutMs);

    try {
      const stdoutPromise = inherited
        ? Promise.resolve("")
        : new Response(proc.stdout).text();
      const stderrPromise = inheritStderr
        ? Promise.resolve("")
        : filterGumStderr
          ? relayGumStderr(proc.stderr)
          : new Response(proc.stderr).text();
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        stdoutPromise,
        stderrPromise,
      ]);
      return { code: timedOut ? 124 : code, stdout, stderr, timedOut };
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (forceKillTimer !== null) clearTimeout(forceKillTimer);
    }
  } catch (error) {
    return {
      code: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveDeps(deps: NoteCliDeps): ResolvedDeps {
  const env = deps.env ?? process.env;
  const keeperBaseArgv = deps.keeperBaseArgv ?? [
    process.execPath,
    resolveKeeperAgentPath(),
  ];
  const configuredPrefix =
    deps.promptPrefix === undefined
      ? (resolveConfig().dispatchPromptPrefix ?? null)
      : deps.promptPrefix;
  return {
    openStore: deps.openStore ?? (() => NoteStore.open()),
    drafts: deps.drafts ?? {
      create: (dbPath, body) => createNoteDraft(body, { dbPath }),
      list: (dbPath) => listNoteDrafts(dbPath),
      read: (draft) => readNoteDraft(draft),
      write: (draft, body) => writeNoteDraft(draft, body),
      remove: (draft) => removeNoteDraft(draft),
    },
    runProcess: deps.runProcess ?? defaultRunProcess,
    copy: deps.copy ?? copyToClipboard,
    stdout: deps.stdout ?? ((text) => process.stdout.write(text)),
    stderr: deps.stderr ?? ((text) => process.stderr.write(text)),
    env,
    isTty: deps.isTty ?? hasInteractiveNoteTty,
    keeperBaseArgv,
    promptPrefix: configuredPrefix,
    tmuxSession:
      deps.tmuxSession ??
      (typeof env.KEEPER_TMUX_SESSION === "string" &&
      env.KEEPER_TMUX_SESSION.length > 0
        ? env.KEEPER_TMUX_SESSION
        : "work"),
    backup: deps.backup ?? backupNotesIfDue,
  };
}

export function parseNoteArgs(argv: readonly string[]): ParsedNoteCommand {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === "--help" || verb === "-h") {
    return { kind: "help" };
  }
  if (verb === "new") {
    if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
      return { kind: "help" };
    }
    if (rest.length === 0) return { kind: "new", fresh: false };
    if (rest.length === 1 && rest[0] === "--fresh") {
      return { kind: "new", fresh: true };
    }
    return { kind: "error", message: "new accepts only --fresh" };
  }
  if (verb === "browse") {
    if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
      return { kind: "help" };
    }
    if (rest.length > 0) {
      return { kind: "error", message: "browse accepts no arguments" };
    }
    return { kind: "browse" };
  }
  if (verb === "list") {
    let state: NoteState | "all" = "active";
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i] as string;
      if (token === "--help" || token === "-h") return { kind: "help" };
      let value: string | undefined;
      if (token === "--state") {
        value = rest[i + 1];
        i += 1;
      } else if (token.startsWith("--state=")) {
        value = token.slice("--state=".length);
      } else {
        return { kind: "error", message: `list: unknown argument '${token}'` };
      }
      if (value !== "active" && value !== "archived" && value !== "all") {
        return {
          kind: "error",
          message: "list: --state must be active, archived, or all",
        };
      }
      state = value;
    }
    return { kind: "list", state };
  }
  if (verb === "show") {
    let raw = false;
    let preview = false;
    let noteId: string | null = null;
    for (const token of rest) {
      if (token === "--help" || token === "-h") return { kind: "help" };
      if (token === "--raw") {
        raw = true;
      } else if (token === "--preview") {
        preview = true;
      } else if (token.startsWith("-")) {
        return { kind: "error", message: `show: unknown flag '${token}'` };
      } else if (noteId === null) {
        noteId = token;
      } else {
        return { kind: "error", message: "show accepts exactly one note id" };
      }
    }
    if (raw && preview) {
      return {
        kind: "error",
        message: "show: --raw and --preview are mutually exclusive",
      };
    }
    return noteId === null
      ? { kind: "error", message: "show requires a note id" }
      : { kind: "show", noteId, raw, preview };
  }
  return { kind: "error", message: `unknown verb '${verb}'` };
}

function writeEnvelope(deps: ResolvedDeps, data: unknown): void {
  deps.stdout(
    `${JSON.stringify(
      {
        schema_version: NOTE_CLI_SCHEMA_VERSION,
        ok: true,
        error: null,
        data,
      },
      null,
      2,
    )}\n`,
  );
}

function writeErrorEnvelope(
  deps: ResolvedDeps,
  code: "note_not_found" | "notes_store_unavailable",
  message: string,
  recovery: string,
): void {
  deps.stdout(
    `${JSON.stringify(
      {
        schema_version: NOTE_CLI_SCHEMA_VERSION,
        ok: false,
        error: { code, message, recovery },
        data: null,
      },
      null,
      2,
    )}\n`,
  );
}

function noteListRow(note: NoteRow): Record<string, unknown> {
  return {
    note_id: note.note_id,
    state: note.state,
    revision: note.revision,
    summary: noteSummary(note.body),
    created_at: note.created_at,
    updated_at: note.updated_at,
    archived_at: note.archived_at,
    archived_via: note.archived_via,
    project_path: note.project_path,
    launch_triple: note.launch_triple,
    launch_handle: note.launch_handle,
  };
}

async function runEditor(
  deps: ResolvedDeps,
  draft: NoteDraft,
): Promise<ProcessResult> {
  const command =
    [deps.env.VISUAL, deps.env.EDITOR].find(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    ) ?? "vi";
  let argv: string[];
  try {
    argv = [...parseCommandWords(command), draft.path];
  } catch (error) {
    return {
      code: 2,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  return deps.runProcess({ argv, stdio: "inherit" });
}

/**
 * Capture a fresh Note with Gum's multiline writer. Gum renders on stderr and
 * returns the submitted value on stdout; its native Ctrl-E binding suspends the
 * textarea into $VISUAL/$EDITOR and restores the edited content on return.
 */
async function runGumWriter(
  deps: ResolvedDeps,
  draft: NoteDraft,
): Promise<ProcessResult> {
  const result = await deps.runProcess({
    argv: [
      "gum",
      "write",
      `--width=${gumWriterWidth(process.stderr.columns)}`,
      `--height=${gumWriterHeight(process.stderr.rows)}`,
      "--show-line-numbers",
      "--header=New Note · Enter: continue · Ctrl-E: open $EDITOR · Esc: cancel",
      "--placeholder=Write a note…",
    ],
    stdinMode: "inherit",
    stderrMode: "gum-filter",
  });
  if (result.code === 0) {
    // `gum write` prints the value with one framing newline. Remove that one
    // byte only; any newline already present in the textarea remains intact.
    const body = result.stdout.endsWith("\n")
      ? result.stdout.slice(0, -1)
      : result.stdout;
    deps.drafts.write(draft, body);
  }
  return result;
}

interface PickerOptions {
  header?: string;
  back?: boolean;
  toggle?: boolean;
  previewCommand?: string;
}

async function runPicker<T>(
  deps: ResolvedDeps,
  prompt: string,
  choices: readonly PickerChoice<T>[],
  options: PickerOptions = {},
): Promise<PickerResult<T>> {
  const encoded = encodePickerChoices(choices, { back: options.back });
  const expect = ["enter"];
  if (options.back === true) expect.push("ctrl-b");
  if (options.toggle === true) expect.push("ctrl-t");
  const argv = [
    "fzf",
    "--no-multi",
    "--layout=reverse",
    "--border",
    // Keep fzf inside the caller's terminal/popup even when a user-wide
    // FZF_DEFAULT_OPTS requests its own nested tmux popup.
    "--no-popup",
    "--delimiter=\\t",
    "--with-nth=2",
    `--prompt=${prompt}> `,
    `--expect=${expect.join(",")}`,
  ];
  if (options.header !== undefined) argv.push(`--header=${options.header}`);
  if (options.previewCommand !== undefined) {
    argv.push(
      `--preview=${options.previewCommand}`,
      "--preview-window=right:60%:wrap",
    );
  }
  // fzf reads choices from stdin and returns its selection on stdout, while
  // drawing the interactive interface on the inherited terminal stderr.
  const result = await deps.runProcess({
    argv,
    stdin: encoded.input,
    stderrMode: "inherit",
  });
  if (result.code !== 0 && result.code !== 1 && result.code !== 130) {
    throw new Error(
      `fzf failed (${result.code}): ${result.stderr.trim() || "no stderr"}`,
    );
  }
  return decodePickerOutput(result.code, result.stdout, encoded.values);
}

async function chooseDraft(
  deps: ResolvedDeps,
  store: NoteStore,
): Promise<NoteDraft | null> {
  const drafts = deps.drafts.list(store.dbPath);
  if (drafts.length === 0) return deps.drafts.create(store.dbPath, "");
  const choices: PickerChoice<
    { kind: "new" } | { kind: "draft"; draft: NoteDraft }
  >[] = [{ value: { kind: "new" }, label: "Create a new blank draft" }];
  for (const draft of drafts) {
    let summary = "(unreadable draft)";
    try {
      summary = noteSummary(deps.drafts.read(draft));
    } catch {
      // Keep the recovery row visible even when its body cannot be read.
    }
    choices.push({
      value: { kind: "draft", draft },
      label: `Resume ${summary}`,
    });
  }
  const picked = await runPicker(deps, "Draft", choices, {
    header:
      "Recover an unfinished draft or start a new one · Esc: leave drafts untouched",
  });
  if (picked.kind !== "selected") return null;
  return picked.value.kind === "new"
    ? deps.drafts.create(store.dbPath, "")
    : picked.value.draft;
}

function draftBody(deps: ResolvedDeps, draft: NoteDraft): string {
  return deps.drafts.read(draft);
}

function backupAfterMutation(deps: ResolvedDeps, store: NoteStore): void {
  try {
    const result = deps.backup(store.dbPath);
    if (result !== null && !result.verified) {
      deps.stderr(
        `keeper note: note committed, but verified backup failed: ${result.error ?? "unknown error"}\n`,
      );
    }
  } catch (error) {
    deps.stderr(
      `keeper note: note committed, but backup threw: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

function removeCommittedDraft(deps: ResolvedDeps, draft: NoteDraft): void {
  try {
    deps.drafts.remove(draft);
  } catch (error) {
    deps.stderr(
      `keeper note: note was persisted, but draft cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

async function copyAndArchive(
  deps: ResolvedDeps,
  store: NoteStore,
  note: NoteRow,
): Promise<boolean> {
  const copied = await deps.copy(note.body);
  if (!copied.ok) {
    deps.stderr(
      `keeper note: clipboard failed; note remains active: ${copied.error}\n`,
    );
    backupAfterMutation(deps, store);
    return false;
  }
  const archived = store.archive(note.note_id, note.revision, "clipboard");
  if (!archived.ok) {
    deps.stderr(
      "keeper note: clipboard succeeded, but archival did not; the note remains active and retrying may copy twice\n",
    );
    backupAfterMutation(deps, store);
    return false;
  }
  backupAfterMutation(deps, store);
  deps.stdout(`Copied and archived note ${note.note_id}.\n`);
  return true;
}

async function discoverSendChoices(
  deps: ResolvedDeps,
): Promise<{ projects: NoteProjectChoice[]; launches: NoteLaunchChoice[] }> {
  const projectsResult = await deps.runProcess({
    argv: [...deps.keeperBaseArgv, "projects", "ranked", "--limit", "0"],
    timeoutMs: DISCOVERY_TIMEOUT_MS,
  });
  if (projectsResult.code !== 0) {
    throw new Error(
      `project discovery failed (${projectsResult.code}): ${
        projectsResult.stderr.trim() || "no stderr"
      }`,
    );
  }
  const projects = parseRankedProjects(projectsResult.stdout);
  if (projects.length === 0) throw new Error("no keeper projects found");

  const launchResult = await deps.runProcess({
    argv: [...deps.keeperBaseArgv, "agent", "presets", "list", "--json"],
    timeoutMs: DISCOVERY_TIMEOUT_MS,
  });
  if (launchResult.code !== 0) {
    throw new Error(
      `matrix discovery failed (${launchResult.code}): ${
        launchResult.stderr.trim() || "no stderr"
      }`,
    );
  }
  const launches = parseLaunchChoices(launchResult.stdout);
  if (launches.length === 0) throw new Error("no launch triples found");
  return { projects, launches };
}

async function chooseSendTarget(
  deps: ResolvedDeps,
): Promise<SendTarget | null> {
  const { projects, launches } = await discoverSendChoices(deps);
  const selection: NoteSendSelection = {
    project: null,
    harness: null,
    model: null,
    effort: null,
    triple: null,
  };
  let step: "project" | "harness" | "model" | "effort" | "confirm" = "project";

  while (true) {
    if (step === "project") {
      const result = await runPicker(
        deps,
        "Project",
        projects.map((project) => ({
          value: project,
          label: `${project.name} · ${project.path}`,
        })),
        { header: formatWizardHeader(selection, step) },
      );
      if (result.kind !== "selected") return null;
      selection.project = result.value;
      selection.harness = null;
      selection.model = null;
      selection.effort = null;
      selection.triple = null;
      step = "harness";
      continue;
    }

    if (step === "harness") {
      const harnesses = uniqueOrdered(launches.map((choice) => choice.harness));
      const result = await runPicker(
        deps,
        "Harness",
        harnesses.map((harness) => ({ value: harness, label: harness })),
        { back: true, header: formatWizardHeader(selection, step) },
      );
      if (result.kind === "cancel") return null;
      if (result.kind === "back") {
        step = "project";
        continue;
      }
      if (result.kind !== "selected") continue;
      selection.harness = result.value;
      selection.model = null;
      selection.effort = null;
      selection.triple = null;
      step = "model";
      continue;
    }

    if (step === "model") {
      const modelRows = launches.filter(
        (choice) => choice.harness === selection.harness,
      );
      const models = uniqueOrdered(modelRows.map((choice) => choice.nativeId));
      const result = await runPicker(
        deps,
        "Model",
        models.map((nativeId) => {
          const row = modelRows.find(
            (candidate) => candidate.nativeId === nativeId,
          );
          const label =
            row === undefined || row.capability === nativeId
              ? nativeId
              : `${row.capability} · ${nativeId}`;
          return { value: nativeId, label };
        }),
        { back: true, header: formatWizardHeader(selection, step) },
      );
      if (result.kind === "cancel") return null;
      if (result.kind === "back") {
        step = "harness";
        continue;
      }
      if (result.kind !== "selected") continue;
      selection.model = result.value;
      selection.effort = null;
      selection.triple = null;
      step = "effort";
      continue;
    }

    if (step === "effort") {
      const rows = launches.filter(
        (choice) =>
          choice.harness === selection.harness &&
          choice.nativeId === selection.model,
      );
      const result = await runPicker(
        deps,
        "Effort",
        rows.map((choice) => ({ value: choice, label: choice.effort })),
        { back: true, header: formatWizardHeader(selection, step) },
      );
      if (result.kind === "cancel") return null;
      if (result.kind === "back") {
        step = "model";
        continue;
      }
      if (result.kind !== "selected") continue;
      selection.effort = result.value.effort;
      selection.triple = result.value.triple;
      step = "confirm";
      continue;
    }

    const selected = launches.find(
      (choice) => choice.triple === selection.triple,
    );
    if (selected === undefined || selection.project === null) {
      throw new Error(
        "send wizard reached confirmation without a launch triple",
      );
    }
    const result = await runPicker(
      deps,
      "Confirm",
      [
        {
          value: "launch" as const,
          label: `Launch ${selected.harness} in ${selection.project.name}`,
        },
      ],
      { back: true, header: formatWizardHeader(selection, step) },
    );
    if (result.kind === "cancel") return null;
    if (result.kind === "back") {
      step = "effort";
      continue;
    }
    if (result.kind === "selected") {
      return { project: selection.project, choice: selected };
    }
  }
}

async function launchAndArchive(
  deps: ResolvedDeps,
  store: NoteStore,
  note: NoteRow,
  target: SendTarget,
): Promise<boolean> {
  const parsed = parseTriple(target.choice.triple);
  if (!parsed.ok) {
    deps.stderr(`keeper note: invalid selected triple: ${parsed.error}\n`);
    backupAfterMutation(deps, store);
    return false;
  }
  const prompt = applyDispatchPromptPrefix(
    deps.promptPrefix ?? undefined,
    note.body,
    parsed.triple.harness,
  );
  const validPrompt = validatePromptBytes(prompt);
  if (!validPrompt.ok) {
    deps.stderr(
      `keeper note: agent prompt is not launchable; note remains active: ${validPrompt.error}\n`,
    );
    backupAfterMutation(deps, store);
    return false;
  }
  const launcherPrefix = [...deps.keeperBaseArgv, "agent"];
  const argv = buildAgentLaunchArgv({
    launcherArgvPrefix: launcherPrefix,
    cli: parsed.triple.harness as AgentCli,
    prompt,
    preset: target.choice.triple,
    session: deps.tmuxSession,
  });
  const env = {
    PWD: target.project.path,
  };
  const result = await deps.runProcess({
    argv,
    cwd: target.project.path,
    env,
    timeoutMs: AGENT_LAUNCH_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    deps.stderr(
      `keeper note: agent launch was not acknowledged (${result.code}); note remains active; inspect tmux before retrying because a window may exist: ${
        result.stderr.trim() || "no stderr"
      }\n`,
    );
    backupAfterMutation(deps, store);
    return false;
  }
  const handle = parseJsonObjectFromOutput(result.stdout);
  const handleId =
    handle !== null && typeof handle.id === "string" && handle.id.length > 0
      ? handle.id
      : null;
  if (handleId === null) {
    deps.stderr(
      "keeper note: agent launch returned no handle; note remains active because success is ambiguous\n",
    );
    backupAfterMutation(deps, store);
    return false;
  }
  const metadata: ArchiveMetadata = {
    project_path: target.project.path,
    launch_triple: target.choice.triple,
    launch_handle: handleId,
  };
  const archived = store.archive(
    note.note_id,
    note.revision,
    "agent",
    metadata,
  );
  if (!archived.ok) {
    deps.stderr(
      "keeper note: agent launched, but archival did not; the note remains active and retrying may launch twice\n",
    );
    backupAfterMutation(deps, store);
    return false;
  }
  backupAfterMutation(deps, store);
  deps.stdout(
    `Sent and archived note ${note.note_id} as ${handleId} in ${target.project.name}.\n`,
  );
  return true;
}

async function captureNewNote(
  deps: ResolvedDeps,
  store: NoteStore,
  fresh: boolean,
): Promise<number> {
  const draft = fresh
    ? deps.drafts.create(store.dbPath, "")
    : await chooseDraft(deps, store);
  if (draft === null) return 0;
  let inputMode: "gum" | "editor" | null = fresh ? "gum" : "editor";
  while (true) {
    if (inputMode !== null) {
      const mode = inputMode;
      const edited =
        mode === "gum"
          ? await runGumWriter(deps, draft)
          : await runEditor(deps, draft);
      if (edited.code !== 0) {
        if (mode === "gum" && edited.code === 1) {
          // Gum treats Escape as `not submitted`; the process adapter filters
          // that post-TUI line so tmux can close without exposing an error frame.
          return 0;
        }
        deps.stderr(
          `keeper note: ${mode === "gum" ? "writer" : "editor"} exited ${edited.code}; draft preserved at ${draft.path}\n`,
        );
        return 1;
      }
      inputMode = null;
    }

    const body = draftBody(deps, draft);
    const empty = body.trim().length === 0;
    const actions: PickerChoice<
      "save" | "copy" | "send" | "edit" | "discard"
    >[] = empty
      ? [
          { value: "edit", label: "Open in $EDITOR" },
          { value: "discard", label: "Discard empty draft" },
        ]
      : [
          { value: "save", label: "Save for later" },
          { value: "copy", label: "Copy to clipboard and archive" },
          { value: "send", label: "Send to a fresh agent and archive" },
          { value: "edit", label: "Open in $EDITOR" },
          { value: "discard", label: "Discard" },
        ];
    const picked = await runPicker(deps, "Action", actions, {
      header: "New note · Esc preserves the draft",
    });
    if (picked.kind !== "selected") {
      deps.stderr(`keeper note: draft preserved at ${draft.path}\n`);
      return 0;
    }
    if (picked.value === "edit") {
      inputMode = "editor";
      continue;
    }
    if (picked.value === "discard") {
      deps.drafts.remove(draft);
      deps.stdout("Discarded draft.\n");
      return 0;
    }
    if (picked.value === "save") {
      const note = store.create(body);
      removeCommittedDraft(deps, draft);
      backupAfterMutation(deps, store);
      deps.stdout(`Saved active note ${note.note_id}.\n`);
      return 0;
    }
    if (picked.value === "copy") {
      const note = store.create(body);
      removeCommittedDraft(deps, draft);
      return (await copyAndArchive(deps, store, note)) ? 0 : 1;
    }

    let target: SendTarget | null;
    try {
      target = await chooseSendTarget(deps);
    } catch (error) {
      deps.stderr(
        `keeper note: send setup failed; draft preserved: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return 1;
    }
    if (target === null) continue;
    const note = store.create(body);
    removeCommittedDraft(deps, draft);
    return (await launchAndArchive(deps, store, note, target)) ? 0 : 1;
  }
}

function formatNoteChoice(note: NoteRow): string {
  const updated = new Date(note.updated_at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${updated.getFullYear()}-${pad(updated.getMonth() + 1)}-${pad(
    updated.getDate(),
  )} ${pad(updated.getHours())}:${pad(updated.getMinutes())}`;
  const disposition =
    note.state === "archived" && note.archived_via !== null
      ? ` · ${note.archived_via}`
      : "";
  return `${stamp}${disposition} · ${noteSummary(note.body)}`;
}

function previewCommand(deps: ResolvedDeps): string {
  const prefix = deps.keeperBaseArgv.map(shellQuote).join(" ");
  return `${prefix} note show {3} --preview`;
}

async function editActiveNote(
  deps: ResolvedDeps,
  store: NoteStore,
  note: NoteRow,
): Promise<boolean> {
  const draft = deps.drafts.create(store.dbPath, note.body);
  const edited = await runEditor(deps, draft);
  if (edited.code !== 0) {
    deps.stderr(
      `keeper note: editor exited ${edited.code}; draft preserved at ${draft.path}\n`,
    );
    return false;
  }
  const result = store.update(
    note.note_id,
    note.revision,
    deps.drafts.read(draft),
  );
  if (!result.ok) {
    deps.stderr(
      `keeper note: edit was not saved (${result.reason}); draft preserved at ${draft.path}\n`,
    );
    return false;
  }
  removeCommittedDraft(deps, draft);
  backupAfterMutation(deps, store);
  deps.stdout(`Updated active note ${note.note_id}.\n`);
  return true;
}

async function browseNotes(
  deps: ResolvedDeps,
  store: NoteStore,
): Promise<number> {
  let state: NoteState = "active";
  while (true) {
    const notes = store.list(state);
    const choices: PickerChoice<string>[] = notes.map((note) => ({
      value: note.note_id,
      label: formatNoteChoice(note),
      preview: note.note_id,
    }));
    if (choices.length === 0) {
      choices.push({ value: "__empty__", label: `(no ${state} notes)` });
    }
    const selected = await runPicker(
      deps,
      state === "active" ? "Active" : "Archived",
      choices,
      {
        toggle: true,
        header:
          state === "active"
            ? "Active notes · Ctrl-T: archived · Enter: actions · Esc: exit"
            : "Archived history · Ctrl-T: active · Enter: preview only · Esc: exit",
        previewCommand: previewCommand(deps),
      },
    );
    if (selected.kind === "cancel") return 0;
    if (selected.kind === "toggle") {
      state = state === "active" ? "archived" : "active";
      continue;
    }
    if (selected.kind !== "selected" || selected.value === "__empty__")
      continue;
    const note = store.get(selected.value);
    if (note === null || note.state !== state) continue;
    if (state === "archived") continue;

    const action = await runPicker(
      deps,
      "Action",
      [
        { value: "edit" as const, label: "Edit" },
        { value: "copy" as const, label: "Copy to clipboard and archive" },
        { value: "send" as const, label: "Send to a fresh agent and archive" },
      ],
      { back: true, header: sanitizePickerLabel(noteSummary(note.body)) },
    );
    if (action.kind !== "selected") continue;
    if (action.value === "edit") {
      await editActiveNote(deps, store, note);
      continue;
    }
    if (action.value === "copy") {
      await copyAndArchive(deps, store, note);
      continue;
    }
    try {
      const target = await chooseSendTarget(deps);
      if (target !== null) await launchAndArchive(deps, store, note, target);
    } catch (error) {
      deps.stderr(
        `keeper note: send setup failed; note remains active: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
}

export async function runNoteCommand(
  argv: readonly string[],
  suppliedDeps: NoteCliDeps = {},
): Promise<number> {
  const parsed = parseNoteArgs(argv);
  if (parsed.kind === "help") {
    (suppliedDeps.stdout ?? ((text) => process.stdout.write(text)))(HELP);
    return 0;
  }
  const deps = resolveDeps(suppliedDeps);
  if (parsed.kind === "error") {
    deps.stderr(`keeper note: ${parsed.message}\n\n${HELP}`);
    return 2;
  }
  if ((parsed.kind === "new" || parsed.kind === "browse") && !deps.isTty()) {
    deps.stderr(`keeper note ${parsed.kind}: interactive TTY required\n`);
    return 1;
  }

  let store: NoteStore;
  try {
    store = deps.openStore();
  } catch (error) {
    if (parsed.kind === "list" || parsed.kind === "show") {
      writeErrorEnvelope(
        deps,
        "notes_store_unavailable",
        "notes.db could not be opened",
        "Check the private Keeper state directory and retry; this read did not mutate notes.",
      );
    } else {
      deps.stderr(
        `keeper note: cannot open notes.db: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    return 1;
  }

  try {
    if (parsed.kind === "list") {
      writeEnvelope(deps, {
        state: parsed.state,
        notes: store.list(parsed.state).map(noteListRow),
      });
      return 0;
    }
    if (parsed.kind === "show") {
      const note = store.get(parsed.noteId);
      if (note === null) {
        writeErrorEnvelope(
          deps,
          "note_not_found",
          "No note matched the supplied id",
          "Choose an id from `keeper note list --state all` and retry.",
        );
        return 1;
      }
      if (parsed.raw) {
        deps.stdout(note.body);
      } else if (parsed.preview) {
        deps.stdout(sanitizeTerminalPreview(note.body));
      } else {
        writeEnvelope(deps, { note });
      }
      return 0;
    }
    if (parsed.kind === "new") {
      return await captureNewNote(deps, store, parsed.fresh);
    }
    return await browseNotes(deps, store);
  } catch (error) {
    if (parsed.kind === "list" || parsed.kind === "show") {
      writeErrorEnvelope(
        deps,
        "notes_store_unavailable",
        "notes.db could not be read",
        "Check the private Keeper state directory and retry; this read did not mutate notes.",
      );
    } else {
      deps.stderr(
        `keeper note: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    return 1;
  } finally {
    store.close();
  }
}

export async function main(argv: string[]): Promise<void> {
  const code = await runNoteCommand(argv);
  if (code !== 0) process.exit(code);
}
