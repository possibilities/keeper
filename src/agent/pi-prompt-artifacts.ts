/**
 * Pi prompt-artifact launch preflight. The compiler stays behind the keeper CLI
 * subprocess boundary so the agent launcher never loads its dependency graph.
 */

import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

const ARGV = ["prompt", "compile", "--bundle", "plan:static", "--target", "pi"];
const TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 1024 * 1024;

export const KEEPER_AGENT_PI_PROMPT_EXECUTABLE_ENV =
  "KEEPER_AGENT_PI_PROMPT_EXECUTABLE";
export const KEEPER_AGENT_PI_PROMPT_CLI_ENV = "KEEPER_AGENT_PI_PROMPT_CLI";

export interface PiPromptCompilerPaths {
  readonly executablePath: string;
  readonly keeperCliPath: string;
}

export interface PiPromptArtifactsSpawnResult {
  readonly status: number | null;
  readonly stdout: string | Buffer | null;
  readonly stderr: string | Buffer | null;
  readonly error?: Error;
}

export interface PiPromptArtifactsSpawnOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly encoding: "utf8";
  readonly timeout: number;
  readonly maxBuffer: number;
}

export type PiPromptArtifactsSpawnSync = (
  command: string,
  argv: readonly string[],
  options: PiPromptArtifactsSpawnOptions,
) => PiPromptArtifactsSpawnResult;

export interface EnsurePiPromptArtifactsOptions extends PiPromptCompilerPaths {
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnSyncFn?: PiPromptArtifactsSpawnSync;
}

/** A launch-blocking compiler failure with an operator-oriented repair path. */
export class PiPromptArtifactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiPromptArtifactsError";
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function requireAbsolutePath(value: string, label: string): string {
  if (
    value === "" ||
    value !== value.trim() ||
    hasControlCharacters(value) ||
    !isAbsolute(value)
  ) {
    throw new PiPromptArtifactsError(
      `Pi prompt-artifact preflight requires an absolute ${label}`,
    );
  }
  return value;
}

/** Stamp the exact compiler prefix onto the Pi process environment. The
 * KEEPER_AGENT_ namespace is forwarded by detached launcher re-execs, so nested
 * Task sessions inherit the same checkout without consulting PATH. */
export function stampPiPromptCompilerEnv(
  env: NodeJS.ProcessEnv,
  paths: PiPromptCompilerPaths,
): void {
  env[KEEPER_AGENT_PI_PROMPT_EXECUTABLE_ENV] = requireAbsolutePath(
    paths.executablePath,
    "compiler executable path",
  );
  env[KEEPER_AGENT_PI_PROMPT_CLI_ENV] = requireAbsolutePath(
    paths.keeperCliPath,
    "keeper CLI path",
  );
}

interface PiCompileEnvelope {
  readonly ok: boolean;
  readonly target: "pi";
  readonly request: { readonly kind: "bundle"; readonly name: "plan:static" };
  readonly outcome: "hit" | "compiled" | "repaired";
  readonly fingerprint: string;
}

function defaultSpawnSync(
  command: string,
  argv: readonly string[],
  options: PiPromptArtifactsSpawnOptions,
): PiPromptArtifactsSpawnResult {
  const result = spawnSync(command, [...argv], options);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function text(value: string | Buffer | null): string {
  return value === null ? "" : value.toString();
}

function diagnostic(stdout: string, stderr: string): string {
  const detail = stderr.trim() || stdout.trim();
  return detail === "" ? "no diagnostic output" : detail.slice(0, 1024);
}

function repairHint(): string {
  return "Run `keeper prompt compile --bundle plan:static --target pi` to inspect and repair Pi prompt artifacts.";
}

function parseEnvelope(stdout: string): PiCompileEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new PiPromptArtifactsError(
      `Pi prompt-artifact preflight produced malformed JSON output; ${repairHint()}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PiPromptArtifactsError(
      `Pi prompt-artifact preflight produced an invalid result envelope; ${repairHint()}`,
    );
  }
  const result = parsed as Record<string, unknown>;
  if (result.ok !== true) {
    throw new PiPromptArtifactsError(
      `Pi prompt-artifact preflight reported ok:false; ${repairHint()}`,
    );
  }
  if (
    result.target !== "pi" ||
    (result.outcome !== "hit" &&
      result.outcome !== "compiled" &&
      result.outcome !== "repaired") ||
    typeof result.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(result.fingerprint) ||
    result.request === null ||
    typeof result.request !== "object" ||
    (result.request as Record<string, unknown>).kind !== "bundle" ||
    (result.request as Record<string, unknown>).name !== "plan:static"
  ) {
    throw new PiPromptArtifactsError(
      `Pi prompt-artifact preflight produced an invalid success envelope; ${repairHint()}`,
    );
  }
  return result as unknown as PiCompileEnvelope;
}

/**
 * Compile Pi's static plan artifacts before a Pi launch. `env` is passed to the
 * compiler unchanged so PI_CODING_AGENT_DIR selects the same artifact root Pi
 * will use. The executable and keeper CLI are an injected absolute prefix from
 * the launcher; this preflight never resolves a bare command through PATH.
 */
export function ensurePiPromptArtifacts(
  actionLog: string[],
  options: EnsurePiPromptArtifactsOptions,
): void {
  const env = options.env ?? process.env;
  const run = options.spawnSyncFn ?? defaultSpawnSync;
  const executable = requireAbsolutePath(
    options.executablePath,
    "compiler executable path",
  );
  const keeperCli = requireAbsolutePath(
    options.keeperCliPath,
    "keeper CLI path",
  );
  let result: PiPromptArtifactsSpawnResult;
  try {
    result = run(executable, [keeperCli, ...ARGV], {
      env,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PiPromptArtifactsError(
      `Pi prompt-artifact preflight could not start: ${detail}; ${repairHint()}`,
    );
  }
  const stdout = text(result.stdout);
  const stderr = text(result.stderr);
  if (result.error !== undefined) {
    throw new PiPromptArtifactsError(
      `Pi prompt-artifact preflight could not complete: ${result.error.message}; ${repairHint()}`,
    );
  }
  if (result.status !== 0) {
    throw new PiPromptArtifactsError(
      `Pi prompt-artifact preflight exited ${result.status ?? "without a status"}: ${diagnostic(stdout, stderr)}; ${repairHint()}`,
    );
  }
  const envelope = parseEnvelope(stdout.trim());
  actionLog.push(
    `Pi prompt artifacts ${envelope.outcome} (fingerprint: ${envelope.fingerprint})`,
  );
}
