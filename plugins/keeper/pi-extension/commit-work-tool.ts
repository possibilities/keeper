import { execFile } from "node:child_process";
import { basename, isAbsolute } from "node:path";

const EXECUTABLE_ENV = "KEEPER_AGENT_PI_PROMPT_EXECUTABLE";
const CLI_ENV = "KEEPER_AGENT_PI_PROMPT_CLI";
const MAX_MESSAGE_BYTES = 65_536;
const MAX_DIRECT_ADOPTIONS = 500;
const MAX_ADOPTION_FILES = 32;
const MAX_PATH_BYTES = 4_096;
const MAX_TOTAL_PATH_BYTES = 256 * 1_024;
const TOOL_TIMEOUT_MS = 15 * 60_000;
const TOOL_MAX_BUFFER = 2 * 1_048_576;
const TOOL_TEXT_LIMIT = 50 * 1_024;

export interface PiCommitWorkParams {
  message?: string;
  message_file?: string;
  adopt?: string[];
  adopt_from?: string[];
  task_id?: string;
  preview_files?: boolean;
  max_files?: number;
  allow_stale_unstage?: boolean;
  override_jam?: boolean;
  allow_mass_reversion?: boolean;
}

export interface PiCommitWorkContext {
  cwd: string;
}

export interface PiCommitWorkResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export interface PiCommitWorkToolDefinition {
  name: string;
  label: string;
  description: string;
  executionMode: "sequential";
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: PiCommitWorkParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: PiCommitWorkContext,
  ): Promise<PiCommitWorkResult>;
}

export type CommitWorkExecFile = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    signal?: AbortSignal;
    shell: false;
  },
  callback: (
    error: {
      code?: unknown;
      signal?: unknown;
      killed?: boolean;
      message?: string;
    } | null,
    stdout: string,
    stderr: string,
  ) => void,
) => unknown;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function wrappedTaskFromEnv(env: NodeJS.ProcessEnv): string | null {
  if ((env.KEEPER_WRAPPED_CELL ?? "").trim() === "") return null;
  const leaf = basename((env.KEEPER_WRAPPED_ENVELOPE ?? "").trim());
  const taskId = leaf.endsWith(".json") ? leaf.slice(0, -5) : "";
  return /^fn-\d+-[a-z0-9-]+\.\d+$/.test(taskId) ? taskId : "";
}

function validAbsoluteProgram(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    isAbsolute(value) &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  );
}

function validatePathList(
  value: unknown,
  label: string,
  maxItems: number,
): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return `${label} must be an array of strings`;
  }
  if (value.length > maxItems) {
    return `${label} exceeds ${maxItems} entries`;
  }
  let total = 0;
  for (const path of value as string[]) {
    if (path === "" || path.includes("\0")) {
      return `${label} paths must be non-empty and contain no NUL`;
    }
    const bytes = byteLength(path);
    if (bytes > MAX_PATH_BYTES) {
      return `${label} contains a path over ${MAX_PATH_BYTES} bytes`;
    }
    total += bytes;
    if (total > MAX_TOTAL_PATH_BYTES) {
      return `${label} exceeds ${MAX_TOTAL_PATH_BYTES} total path bytes`;
    }
  }
  return null;
}

export function piCommitWorkParamError(
  params: PiCommitWorkParams,
): string | null {
  if (params.message !== undefined && params.message_file !== undefined) {
    return "pass either message or message_file, not both";
  }
  if (
    params.message !== undefined &&
    (params.message.includes("\0") ||
      byteLength(params.message) > MAX_MESSAGE_BYTES)
  ) {
    return `message must contain no NUL and be at most ${MAX_MESSAGE_BYTES} bytes`;
  }
  if (
    params.preview_files !== true &&
    params.message === undefined &&
    params.message_file === undefined
  ) {
    return "message or message_file is required unless preview_files is true";
  }
  for (const [value, label] of [
    [params.message_file, "message_file"],
    [params.task_id, "task_id"],
  ] as const) {
    if (
      value !== undefined &&
      (value === "" ||
        value.includes("\0") ||
        byteLength(value) > MAX_PATH_BYTES)
    ) {
      return `${label} must be non-empty, NUL-free, and at most ${MAX_PATH_BYTES} bytes`;
    }
  }
  const adoptError = validatePathList(
    params.adopt,
    "adopt",
    MAX_DIRECT_ADOPTIONS,
  );
  if (adoptError !== null) return adoptError;
  const manifestError = validatePathList(
    params.adopt_from,
    "adopt_from",
    MAX_ADOPTION_FILES,
  );
  if (manifestError !== null) return manifestError;
  if (
    params.max_files !== undefined &&
    (!Number.isSafeInteger(params.max_files) ||
      params.max_files < 0 ||
      params.max_files > 10_000)
  ) {
    return "max_files must be an integer from 0 through 10000";
  }
  return null;
}

export function piCommitWorkArgv(params: PiCommitWorkParams): string[] {
  const args = ["commit-work"];
  if (params.preview_files === true) args.push("--preview-files");
  if (params.allow_stale_unstage === true) args.push("--allow-stale-unstage");
  if (params.override_jam === true) args.push("--override-jam");
  if (params.allow_mass_reversion === true) args.push("--allow-mass-reversion");
  if (params.max_files !== undefined)
    args.push("--max-files", String(params.max_files));
  if (params.message_file !== undefined)
    args.push("--message-file", params.message_file);
  if (params.task_id !== undefined) args.push("--task-id", params.task_id);
  for (const path of params.adopt ?? []) args.push("--adopt", path);
  for (const path of params.adopt_from ?? []) args.push("--adopt-from", path);
  if (params.message !== undefined) args.push("--", params.message);
  return args;
}

function boundedText(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= TOOL_TEXT_LIMIT) return value;
  return `${bytes.subarray(0, TOOL_TEXT_LIMIT - 64).toString("utf8")}\n[commit-work tool output truncated]`;
}

function compactValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string") return value.slice(0, 2_048);
  if (depth >= 4) return "[nested value omitted]";
  if (Array.isArray(value))
    return value.slice(0, 10).map((item) => compactValue(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      if (key === "identities") continue;
      result[key] = compactValue(item, depth + 1);
    }
    return result;
  }
  return undefined;
}

function compactEnvelope(parsed: Record<string, unknown>): string {
  const compact = {
    schema_version: parsed.schema_version,
    kind: parsed.kind,
    outcome: parsed.outcome,
    success: parsed.success,
    identity: parsed.identity,
    committed: parsed.committed,
    pushed: parsed.pushed,
    commit_sha: parsed.commit_sha,
    file_total: parsed.file_total,
    files_truncated: parsed.files_truncated,
    selection: compactValue(parsed.selection),
    surface: compactValue(parsed.surface),
    commit: compactValue(parsed.commit),
    push: compactValue(parsed.push),
    error: compactValue(parsed.error),
    hint: compactValue(parsed.hint),
    reason: compactValue(parsed.reason),
    request_release: compactValue(parsed.request_release),
    stderr_sample: compactValue(parsed.stderr_sample),
  };
  const rendered = JSON.stringify(compact);
  if (Buffer.byteLength(rendered, "utf8") <= TOOL_TEXT_LIMIT) return rendered;
  return JSON.stringify({
    schema_version: parsed.schema_version,
    kind: parsed.kind,
    outcome: parsed.outcome,
    success: parsed.success,
    committed: parsed.committed,
    pushed: parsed.pushed,
    commit_sha: parsed.commit_sha,
    file_total: parsed.file_total,
    output_truncated: true,
  });
}

function parseEnvelope(stdout: string): Record<string, unknown> | null {
  const line = stdout.trim();
  if (line === "") return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).kind === "commit-work-result"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function executePiCommitWork(
  params: PiCommitWorkParams,
  context: PiCommitWorkContext,
  signal: AbortSignal | undefined,
  env: NodeJS.ProcessEnv = process.env,
  run: CommitWorkExecFile = execFile as unknown as CommitWorkExecFile,
): Promise<PiCommitWorkResult> {
  const invalid = piCommitWorkParamError(params);
  if (invalid !== null) {
    return {
      content: [
        { type: "text", text: `keeper commit-work rejected: ${invalid}` },
      ],
      details: { rejected: invalid },
    };
  }
  if (signal?.aborted === true) {
    return {
      content: [
        { type: "text", text: "keeper commit-work cancelled before launch" },
      ],
      details: { cancelled: true, exit_code: null },
    };
  }
  const wrappedTask = wrappedTaskFromEnv(env);
  if (wrappedTask !== null && params.task_id !== wrappedTask) {
    const reason =
      wrappedTask === ""
        ? "wrapped launch task identity is unavailable"
        : `wrapped commit-work requires task_id ${wrappedTask}`;
    return {
      content: [
        { type: "text", text: `keeper commit-work rejected: ${reason}` },
      ],
      details: { rejected: reason },
    };
  }
  const executable = env[EXECUTABLE_ENV];
  const cli = env[CLI_ENV];
  if (!validAbsoluteProgram(executable) || !validAbsoluteProgram(cli)) {
    const reason = "Keeper's pinned Pi CLI launch paths are unavailable";
    return {
      content: [
        { type: "text", text: `keeper commit-work unavailable: ${reason}` },
      ],
      details: { unavailable: reason },
    };
  }
  const args = [cli, ...piCommitWorkArgv(params)];
  return await new Promise((resolve) => {
    run(
      executable,
      args,
      {
        cwd: context.cwd,
        env,
        encoding: "utf8",
        timeout: TOOL_TIMEOUT_MS,
        maxBuffer: TOOL_MAX_BUFFER,
        ...(signal === undefined ? {} : { signal }),
        shell: false,
      },
      (error, stdout, stderr) => {
        const envelope = parseEnvelope(stdout);
        if (envelope !== null) {
          resolve({
            content: [{ type: "text", text: compactEnvelope(envelope) }],
            details: {
              exit_code: error?.code ?? 0,
              outcome: envelope.outcome ?? null,
              success: envelope.success === true,
              committed: "committed" in envelope ? envelope.committed : false,
              pushed: "pushed" in envelope ? envelope.pushed : false,
            },
          });
          return;
        }
        const detail = boundedText(
          (
            stderr.trim() ||
            stdout.trim() ||
            error?.message ||
            "no result envelope"
          ).slice(0, TOOL_TEXT_LIMIT),
        );
        resolve({
          content: [
            {
              type: "text",
              text:
                "keeper commit-work state is unknown because no complete result envelope was returned; inspect the repository before retrying. " +
                detail,
            },
          ],
          details: {
            exit_code: error?.code ?? null,
            signal: error?.signal ?? null,
            killed: error?.killed === true,
            indeterminate: true,
          },
        });
      },
    );
  });
}

const PARAMETERS: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string", maxLength: MAX_MESSAGE_BYTES },
    message_file: { type: "string" },
    adopt: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_DIRECT_ADOPTIONS,
    },
    adopt_from: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_ADOPTION_FILES,
    },
    task_id: { type: "string" },
    preview_files: { type: "boolean" },
    max_files: { type: "integer", minimum: 0, maximum: 10_000 },
    allow_stale_unstage: { type: "boolean" },
    override_jam: { type: "boolean" },
    allow_mass_reversion: { type: "boolean" },
  },
};

export function createPiCommitWorkTool(
  env: NodeJS.ProcessEnv = process.env,
  run: CommitWorkExecFile = execFile as unknown as CommitWorkExecFile,
): PiCommitWorkToolDefinition {
  return {
    name: "keeper_commit_work",
    label: "Keeper Commit Work",
    description:
      "Preview or atomically commit only this tracked Pi session's ownership-backed or explicitly adopted work. Returns a bounded commit-work result with local and remote publication state.",
    // A sibling write/edit must finish and emit its receipt before discovery.
    executionMode: "sequential",
    promptSnippet:
      "Preview and atomically commit this tracked Pi session's exact work through Keeper.",
    promptGuidelines: [
      "Use keeper_commit_work instead of raw Git staging or commit commands. Preview first, explicitly adopt only exact unattributed paths you authored, and pass the literal active task_id for Plan work. Treat committed:true as final even when push fails, and inspect any indeterminate local or remote state before retrying.",
    ],
    parameters: PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      try {
        return await executePiCommitWork(params, context, signal, env, run);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `keeper commit-work unavailable: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          details: { exit_code: null, indeterminate: true },
        };
      }
    },
  };
}
