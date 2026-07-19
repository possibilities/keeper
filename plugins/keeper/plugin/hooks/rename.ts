#!/usr/bin/env bun

/**
 * Keeper-managed Claude `/rename` hook. Exact explicit slugs commit through
 * UserPromptSubmit's native `sessionTitle`; bare commands derive bounded input
 * from the parent transcript and ask Keeper's isolated metadata launcher for a
 * candidate. Every failure returns fixed, content-free feedback and never
 * mutates the transcript, Keeper state, or tmux directly.
 *
 * The common non-match path only parses the prompt. Transcript modules are
 * dynamically imported after an exact managed command reaches the relevant
 * branch, keeping every other UserPromptSubmit invocation free of transcript
 * and process work.
 */

import { spawn as nodeSpawn } from "node:child_process";
import {
  closeSync,
  constants as FS_CONSTANTS,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";

export const CLAUDE_RENAME_PROCESS_TIMEOUT_MS = 25_000;
export const CLAUDE_RENAME_PROCESS_MAX_OUTPUT_BYTES = 32 * 1024;

const INFERENCE_FAILURE_KINDS = [
  "invalid_input",
  "route_unavailable",
  "spawn_failed",
  "capture_failed",
  "timeout",
  "cancelled",
  "output_too_large",
  "auth_failed",
  "quota_unavailable",
  "process_failed",
  "malformed_output",
  "unusable_candidate",
] as const;

export type ClaudeRenameInferenceFailureKind =
  (typeof INFERENCE_FAILURE_KINDS)[number];

const INFERENCE_FAILURE_KIND_SET = new Set<string>(INFERENCE_FAILURE_KINDS);

export type ClaudeRenameCommand =
  | { kind: "bare" }
  | { kind: "explicit"; slug: string };

export interface ClaudeRenameHookPayload extends Record<string, unknown> {
  hook_event_name?: unknown;
  session_id?: unknown;
  session_title?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  prompt?: unknown;
}

export interface ClaudeRenameNativeState {
  sessionId: string;
  sessionTitle: string | null;
  transcriptPath: string;
  projectDir: string;
  cwd: string;
}

export interface ClaudeRenameTranscriptStat {
  dev: number | bigint;
  ino: number | bigint;
  mode: number | bigint;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface ClaudeRenameProcessResult {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
  cancelled: boolean;
  overflow: boolean;
  startFailed: boolean;
}

export interface ClaudeRenameHookOutput {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
    sessionTitle?: string;
  };
}

export interface ClaudeRenameHookDeps {
  keeperJobId: string | undefined;
  supportsNativeSessionTitle(): boolean;
  captureNativeState(
    payload: ClaudeRenameHookPayload,
  ): ClaudeRenameNativeState | null;
  statTranscript(path: string): ClaudeRenameTranscriptStat;
  readTranscript(
    path: string,
    cutoffBytes: number,
    expected: ClaudeRenameTranscriptStat,
  ): Uint8Array;
  buildInput(options: {
    transcript: string | Uint8Array;
    cutoffBytes: number;
    projectDir: string;
  }): Promise<string | null>;
  canonicalSlug(text: string): Promise<string | null>;
  runInference(
    input: string,
    signal: AbortSignal,
  ): Promise<ClaudeRenameProcessResult>;
}

export interface ClaudeRenameProcessStream {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
  removeListener(
    event: "data",
    listener: (chunk: Uint8Array | string) => void,
  ): unknown;
}

export interface ClaudeRenameProcessChild {
  pid?: number;
  stdout: ClaudeRenameProcessStream | null;
  stderr: ClaudeRenameProcessStream | null;
  once(event: "error", listener: () => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
  removeListener(event: "error", listener: () => void): unknown;
  removeListener(
    event: "close",
    listener: (code: number | null) => void,
  ): unknown;
  kill(signal: "SIGKILL"): boolean;
}

export interface ClaudeRenameProcessDeps {
  spawn(command: string, args: string[]): ClaudeRenameProcessChild;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  killTree(child: ClaudeRenameProcessChild): void;
}

/** Parse only a complete `/rename` token and, optionally, one ASCII-space-
 * separated non-whitespace argument. Outer whitespace is insignificant; extra
 * separators, arguments, newlines, and command-prefix near misses do not match. */
export function parseClaudeRenameCommand(
  prompt: unknown,
): ClaudeRenameCommand | null {
  if (typeof prompt !== "string") return null;
  const match = prompt.trim().match(/^\/rename(?: ([^\s]+))?$/u);
  if (match === null) return null;
  const slug = match[1];
  return slug === undefined ? { kind: "bare" } : { kind: "explicit", slug };
}

function nativeStateFromPayload(
  payload: ClaudeRenameHookPayload,
): ClaudeRenameNativeState | null {
  if (payload.hook_event_name !== "UserPromptSubmit") return null;
  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  const cwd = payload.cwd;
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    typeof transcriptPath !== "string" ||
    transcriptPath.length === 0 ||
    typeof cwd !== "string" ||
    cwd.length === 0
  ) {
    return null;
  }
  if (
    payload.session_title !== undefined &&
    payload.session_title !== null &&
    typeof payload.session_title !== "string"
  ) {
    return null;
  }
  const sessionTitle =
    typeof payload.session_title === "string" &&
    payload.session_title.length > 0
      ? payload.session_title
      : null;
  return {
    sessionId,
    sessionTitle,
    transcriptPath,
    projectDir: cwd,
    cwd,
  };
}

function transcriptStat(path: string): ClaudeRenameTranscriptStat {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    !Number.isSafeInteger(stat.size)
  ) {
    throw new Error("transcript is unavailable");
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameTranscriptStat(
  left: ClaudeRenameTranscriptStat,
  right: ClaudeRenameTranscriptStat,
): boolean {
  return (
    BigInt(left.dev) === BigInt(right.dev) &&
    BigInt(left.ino) === BigInt(right.ino) &&
    BigInt(left.mode) === BigInt(right.mode) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readTranscriptPrefix(
  path: string,
  cutoffBytes: number,
  expected: ClaudeRenameTranscriptStat,
): Uint8Array {
  if (
    !Number.isSafeInteger(cutoffBytes) ||
    cutoffBytes < 0 ||
    cutoffBytes !== expected.size
  ) {
    throw new Error("transcript cutoff is unavailable");
  }
  const noFollow =
    typeof FS_CONSTANTS.O_NOFOLLOW === "number" ? FS_CONSTANTS.O_NOFOLLOW : 0;
  const fd = openSync(path, FS_CONSTANTS.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    const openedStat: ClaudeRenameTranscriptStat = {
      dev: opened.dev,
      ino: opened.ino,
      mode: opened.mode,
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
    };
    if (!opened.isFile() || !sameTranscriptStat(expected, openedStat)) {
      throw new Error("transcript changed before read");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < cutoffBytes) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, cutoffBytes - total),
      );
      const count = readSync(fd, chunk, 0, chunk.byteLength, total);
      if (count <= 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    const after = fstatSync(fd);
    const afterStat: ClaudeRenameTranscriptStat = {
      dev: after.dev,
      ino: after.ino,
      mode: after.mode,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
    };
    if (total !== cutoffBytes || !sameTranscriptStat(expected, afterStat)) {
      throw new Error("transcript changed during read");
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}

function defaultKillTree(child: ClaudeRenameProcessChild): void {
  if (typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the exact child when its process group already disappeared.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The bounded process already exited.
  }
}

function defaultProcessDeps(): ClaudeRenameProcessDeps {
  return {
    spawn: (command, args) =>
      nodeSpawn(command, args, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }) as unknown as ClaudeRenameProcessChild,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    killTree: defaultKillTree,
  };
}

/** Run the already-isolated Keeper metadata mode with an independent outer
 * deadline. The child is a process-group leader so timeout/cancellation kills
 * claude-swap and Claude together rather than leaving a metadata process behind. */
export function runClaudeRenameInferenceProcess(
  input: string,
  signal: AbortSignal,
  deps: ClaudeRenameProcessDeps = defaultProcessDeps(),
): Promise<ClaudeRenameProcessResult> {
  if (signal.aborted) {
    return Promise.resolve({
      exitCode: null,
      stdout: "",
      timedOut: false,
      cancelled: true,
      overflow: false,
      startFailed: false,
    });
  }

  return new Promise((resolve) => {
    let child: ClaudeRenameProcessChild;
    try {
      child = deps.spawn("keeper", [
        "agent",
        "claude",
        "--x-metadata-inference",
        input,
      ]);
    } catch {
      resolve({
        exitCode: null,
        stdout: "",
        timedOut: false,
        cancelled: false,
        overflow: false,
        startFailed: true,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer: unknown;

    const finish = (
      result: Omit<ClaudeRenameProcessResult, "stdout">,
    ): void => {
      if (settled) return;
      settled = true;
      deps.clearTimer(timer);
      signal.removeEventListener("abort", onAbort);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      resolve({
        ...result,
        stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"),
      });
    };

    const interrupt = (kind: "timeout" | "cancelled" | "overflow"): void => {
      if (settled) return;
      deps.killTree(child);
      finish({
        exitCode: null,
        timedOut: kind === "timeout",
        cancelled: kind === "cancelled",
        overflow: kind === "overflow",
        startFailed: false,
      });
    };

    const onStdout = (chunk: Uint8Array | string): void => {
      const bytes = Buffer.from(chunk);
      const remaining = CLAUDE_RENAME_PROCESS_MAX_OUTPUT_BYTES - stdoutBytes;
      if (bytes.byteLength > remaining) {
        if (remaining > 0) stdoutChunks.push(bytes.subarray(0, remaining));
        stdoutBytes = CLAUDE_RENAME_PROCESS_MAX_OUTPUT_BYTES;
        interrupt("overflow");
        return;
      }
      stdoutChunks.push(bytes);
      stdoutBytes += bytes.byteLength;
    };
    const onStderr = (chunk: Uint8Array | string): void => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > CLAUDE_RENAME_PROCESS_MAX_OUTPUT_BYTES) {
        interrupt("overflow");
      }
    };
    const onError = (): void => {
      deps.killTree(child);
      finish({
        exitCode: null,
        timedOut: false,
        cancelled: false,
        overflow: false,
        startFailed: true,
      });
    };
    const onClose = (code: number | null): void => {
      finish({
        exitCode: code,
        timedOut: false,
        cancelled: false,
        overflow: false,
        startFailed: false,
      });
    };
    const onAbort = (): void => interrupt("cancelled");

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    timer = deps.setTimer(
      () => interrupt("timeout"),
      CLAUDE_RENAME_PROCESS_TIMEOUT_MS,
    );
    if (signal.aborted) onAbort();
  });
}

function response(
  additionalContext: string,
  sessionTitle?: string,
): ClaudeRenameHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
      ...(sessionTitle === undefined ? {} : { sessionTitle }),
    },
  };
}

function inferenceFailureNotice(
  kind: ClaudeRenameInferenceFailureKind,
): string {
  return `/rename: title unchanged (${kind})`;
}

async function parseInferenceResult(
  result: ClaudeRenameProcessResult,
  canonicalSlug: (text: string) => Promise<string | null>,
): Promise<
  | { ok: true; candidate: string }
  | { ok: false; kind: ClaudeRenameInferenceFailureKind }
> {
  if (result.cancelled) return { ok: false, kind: "cancelled" };
  if (result.timedOut) return { ok: false, kind: "timeout" };
  if (result.overflow) return { ok: false, kind: "output_too_large" };
  if (result.startFailed) return { ok: false, kind: "spawn_failed" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    return { ok: false, kind: "malformed_output" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, kind: "malformed_output" };
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.schema_version !== 1 || typeof envelope.ok !== "boolean") {
    return { ok: false, kind: "malformed_output" };
  }
  if (envelope.ok === false) {
    const error = envelope.error;
    const kind =
      error !== null && typeof error === "object" && !Array.isArray(error)
        ? (error as Record<string, unknown>).kind
        : null;
    return {
      ok: false,
      kind:
        typeof kind === "string" && INFERENCE_FAILURE_KIND_SET.has(kind)
          ? (kind as ClaudeRenameInferenceFailureKind)
          : "malformed_output",
    };
  }
  if (result.exitCode !== 0 || typeof envelope.candidate !== "string") {
    return { ok: false, kind: "malformed_output" };
  }
  const candidate = envelope.candidate;
  return (await canonicalSlug(candidate)) === candidate
    ? { ok: true, candidate }
    : { ok: false, kind: "unusable_candidate" };
}

function sameNativeState(
  left: ClaudeRenameNativeState,
  right: ClaudeRenameNativeState,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sessionTitle === right.sessionTitle &&
    left.transcriptPath === right.transcriptPath &&
    left.projectDir === right.projectDir &&
    left.cwd === right.cwd
  );
}

/** Execute one hook payload. `null` means truly inert and emits no stdout. */
export async function executeClaudeRenameHook(
  payload: ClaudeRenameHookPayload,
  deps: ClaudeRenameHookDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<ClaudeRenameHookOutput | null> {
  const command = parseClaudeRenameCommand(payload.prompt);
  if (command === null) return null;
  if ((deps.keeperJobId ?? "").trim() === "") return null;
  try {
    if (!deps.supportsNativeSessionTitle()) {
      return response("/rename: native title support is unavailable");
    }
  } catch {
    return response("/rename: native title support is unavailable");
  }

  if (
    payload.hook_event_name !== "UserPromptSubmit" ||
    typeof payload.session_id !== "string" ||
    payload.session_id.length === 0
  ) {
    return response("/rename: session state is unavailable");
  }

  if (command.kind === "explicit") {
    try {
      const canonical = await deps.canonicalSlug(command.slug);
      if (canonical !== command.slug) {
        return response("/rename: argument must be a canonical slug");
      }
      return response("/rename: Session title updated.", command.slug);
    } catch {
      return response("/rename: argument could not be validated");
    }
  }

  let initialState: ClaudeRenameNativeState | null;
  try {
    initialState = deps.captureNativeState(payload);
  } catch {
    initialState = null;
  }
  if (initialState === null) {
    return response("/rename: session state is unavailable");
  }

  if (signal.aborted) {
    return response(inferenceFailureNotice("cancelled"));
  }

  let initialStat: ClaudeRenameTranscriptStat;
  let transcript: Uint8Array;
  let input: string | null;
  try {
    initialStat = deps.statTranscript(initialState.transcriptPath);
    transcript = deps.readTranscript(
      initialState.transcriptPath,
      initialStat.size,
      initialStat,
    );
    input = await deps.buildInput({
      transcript,
      cutoffBytes: initialStat.size,
      projectDir: initialState.projectDir,
    });
  } catch {
    return response("/rename: transcript context is unavailable");
  }
  if (input === null) return response("/rename: nothing to name yet");

  let processResult: ClaudeRenameProcessResult;
  try {
    processResult = await deps.runInference(input, signal);
  } catch {
    return response(inferenceFailureNotice("process_failed"));
  }
  let inference:
    | { ok: true; candidate: string }
    | { ok: false; kind: ClaudeRenameInferenceFailureKind };
  try {
    inference = await parseInferenceResult(processResult, deps.canonicalSlug);
  } catch {
    return response(inferenceFailureNotice("unusable_candidate"));
  }
  if (!inference.ok) {
    return response(inferenceFailureNotice(inference.kind));
  }

  let currentState: ClaudeRenameNativeState | null;
  let currentStat: ClaudeRenameTranscriptStat;
  try {
    currentState = deps.captureNativeState(payload);
    if (currentState === null) throw new Error("state unavailable");
    currentStat = deps.statTranscript(currentState.transcriptPath);
  } catch {
    return response("/rename: session changed; title unchanged");
  }
  // A UserPromptSubmit hook is a one-shot process: its session/title/path/cwd
  // payload is immutable, so the live overlap sentinel is the transcript's
  // exact file identity and cutoff. The injected state probe also revalidates
  // every native field, which lets alternate hook transports supply a genuinely
  // live probe without weakening this comparison.
  let stale = true;
  try {
    stale =
      !sameNativeState(initialState, currentState) ||
      !sameTranscriptStat(initialStat, currentStat);
  } catch {
    // An uncomparable live snapshot is never positive freshness evidence.
  }
  if (stale) return response("/rename: session changed; title unchanged");

  return response("/rename: Session title updated.", inference.candidate);
}

export function defaultClaudeRenameHookDeps(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeRenameHookDeps {
  return {
    keeperJobId: env.KEEPER_JOB_ID,
    supportsNativeSessionTitle: () => true,
    captureNativeState: nativeStateFromPayload,
    statTranscript: transcriptStat,
    readTranscript: readTranscriptPrefix,
    buildInput: async (options) => {
      const module = await import("../../../../src/session-rename-input");
      return module.buildSessionRenameInput(options);
    },
    canonicalSlug: async (text) => {
      const module = await import("../../../../src/slug");
      return module.slugify(text);
    },
    runInference: (input, signal) =>
      runClaudeRenameInferenceProcess(input, signal),
  };
}

export async function main(): Promise<void> {
  let output: ClaudeRenameHookOutput | null = null;
  const cancellation = new AbortController();
  const abort = (): void => cancellation.abort();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, abort);
  }
  try {
    const raw = readFileSync(0, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      output = await executeClaudeRenameHook(
        parsed as ClaudeRenameHookPayload,
        defaultClaudeRenameHookDeps(),
        cancellation.signal,
      );
    }
  } catch {
    // Fail open. No raw exception or attacker-controlled input reaches output.
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.removeListener(signal, abort);
    }
  }
  if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (import.meta.main) {
  void main().catch(() => {});
}
