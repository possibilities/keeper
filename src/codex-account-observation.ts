import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  CODEX_MAX_ALIASES,
  CODEX_MAX_OBSERVATION_BYTES,
  CODEX_MAX_OBSERVER_OUTPUT_BYTES,
  CODEX_MAX_WINDOWS_PER_ALIAS,
  CODEX_OBSERVATION_FRESHNESS_CEILING_MS,
  CODEX_OBSERVATION_SCHEMA_VERSION,
  CODEX_OBSERVER_ENVELOPE_SCHEMA_VERSION,
} from "./account-routing-config";

export const CODEX_PROVIDER = "openai-codex" as const;

export type CodexCapacityStatus = "healthy" | "exhausted" | "unavailable";
export type CodexAccountCategory =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "pro-lite"
  | "business"
  | "enterprise"
  | "edu";

export type CodexFailureClass = "auth" | "network" | "response" | "schema";
export type CodexWindowRole = "primary" | "secondary" | "additional";

export interface CodexCapacityWindow {
  role: CodexWindowRole;
  /** Optional for additive schema compatibility; producers publish both fields. */
  key?: string;
  label?: string;
  window_seconds?: number | null;
  used_percent: number;
  reset_at_ms: number | null;
}

export interface CodexCapacityAlias {
  alias: string;
  status: CodexCapacityStatus;
  account_category?: CodexAccountCategory;
  observed_at_ms: number;
  expires_at_ms: number;
  windows: CodexCapacityWindow[];
  failure_class?: CodexFailureClass;
}

export interface CodexCapacityObservation {
  schema_version: number;
  provider: typeof CODEX_PROVIDER;
  config_binding: string;
  observed_at_ms: number;
  aliases: CodexCapacityAlias[];
}

export interface CodexObserverRunOutcome {
  code: number | null;
  stdout: string;
  failure?: "timeout" | "spawn" | "aborted" | "oversize";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function isCodexAccountAlias(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^keeper-codex-[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/u.test(value)
  );
}

function isConfigBinding(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function boundedJson(text: string, maxBytes: number): unknown | null {
  if (Buffer.byteLength(text, "utf8") > maxBytes) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return depthExceeds(parsed, 12) ? null : parsed;
  } catch {
    return null;
  }
}

function depthExceeds(value: unknown, limit: number): boolean {
  const visit = (entry: unknown, depth: number): boolean => {
    if (depth > limit) return true;
    if (Array.isArray(entry)) {
      return entry.some((child) => visit(child, depth + 1));
    }
    const object = record(entry);
    return object !== null
      ? Object.values(object).some((child) => visit(child, depth + 1))
      : false;
  };
  return visit(value, 0);
}

function accountCategory(value: unknown): CodexAccountCategory | null {
  return value === "free" ||
    value === "go" ||
    value === "plus" ||
    value === "pro" ||
    value === "pro-lite" ||
    value === "business" ||
    value === "enterprise" ||
    value === "edu"
    ? value
    : null;
}

function failureClass(value: unknown): CodexFailureClass | null {
  return value === "auth" ||
    value === "network" ||
    value === "response" ||
    value === "schema"
    ? value
    : null;
}

function windowRole(value: unknown): CodexWindowRole | null {
  return value === "primary" || value === "secondary" || value === "additional"
    ? value
    : null;
}

function parseWindow(value: unknown): CodexCapacityWindow | null {
  const input = record(value);
  if (input === null) return null;
  const role = windowRole(input.role);
  const used = input.used_percent;
  const reset = input.reset_at_ms;
  const key = input.key;
  const label = input.label;
  const seconds = input.window_seconds;
  const hasIdentity = key !== undefined || label !== undefined;
  if (
    role === null ||
    typeof used !== "number" ||
    !Number.isFinite(used) ||
    used < 0 ||
    used > 100 ||
    (reset !== null && safeTimestamp(reset) === null) ||
    (hasIdentity &&
      (typeof key !== "string" ||
        !/^[a-z0-9][a-z0-9:.-]{0,127}$/u.test(key) ||
        typeof label !== "string" ||
        label.length < 1 ||
        label.length > 64 ||
        !/^[A-Za-z0-9][A-Za-z0-9 ._+:/()-]*$/u.test(label))) ||
    (seconds !== undefined &&
      seconds !== null &&
      (typeof seconds !== "number" ||
        !Number.isSafeInteger(seconds) ||
        seconds < 1 ||
        seconds > 45 * 24 * 60 * 60))
  ) {
    return null;
  }
  return {
    role,
    ...(hasIdentity ? { key: key as string, label: label as string } : {}),
    ...(seconds === undefined
      ? {}
      : { window_seconds: seconds as number | null }),
    used_percent: used,
    reset_at_ms: reset === null ? null : (reset as number),
  };
}

function parseAlias(value: unknown): CodexCapacityAlias | null {
  const input = record(value);
  if (input === null || !isCodexAccountAlias(input.alias)) return null;
  const status = input.status;
  if (
    status !== "healthy" &&
    status !== "exhausted" &&
    status !== "unavailable"
  ) {
    return null;
  }
  const observedAt = safeTimestamp(input.observed_at_ms);
  const expiresAt = safeTimestamp(input.expires_at_ms);
  const category =
    input.account_category === undefined
      ? undefined
      : accountCategory(input.account_category);
  if (
    observedAt === null ||
    expiresAt === null ||
    category === null ||
    expiresAt < observedAt ||
    !Array.isArray(input.windows) ||
    input.windows.length > CODEX_MAX_WINDOWS_PER_ALIAS
  ) {
    return null;
  }
  const windows = input.windows.map(parseWindow);
  if (windows.some((entry) => entry === null)) return null;
  const parsedWindows = windows as CodexCapacityWindow[];
  const failure = failureClass(input.failure_class);
  if (status === "unavailable") {
    if (parsedWindows.length !== 0 || failure === null) return null;
  } else if (parsedWindows.length === 0 || input.failure_class !== undefined) {
    return null;
  }
  return {
    alias: input.alias,
    status,
    ...(category === undefined ? {} : { account_category: category }),
    observed_at_ms: observedAt,
    expires_at_ms: expiresAt,
    windows: parsedWindows,
    ...(failure === null ? {} : { failure_class: failure }),
  };
}

function parseAliases(
  value: unknown,
  wrapped: boolean,
): CodexCapacityAlias[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > CODEX_MAX_ALIASES
  ) {
    return null;
  }
  const aliases: CodexCapacityAlias[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const input = record(item);
    const usage = wrapped ? record(input?.usage) : input;
    if (
      input === null ||
      usage === null ||
      (wrapped && usage.schema_version !== 1)
    ) {
      return null;
    }
    const parsed = parseAlias(usage);
    const outerAlias = wrapped ? input.alias : parsed?.alias;
    if (
      parsed === null ||
      outerAlias !== parsed.alias ||
      seen.has(parsed.alias)
    ) {
      return null;
    }
    seen.add(parsed.alias);
    aliases.push(parsed);
  }
  return aliases;
}

export function parseCodexObserverEnvelope(
  data: unknown,
): CodexCapacityObservation | null {
  const input = record(data);
  if (
    input === null ||
    input.schema_version !== CODEX_OBSERVER_ENVELOPE_SCHEMA_VERSION ||
    input.truncated !== false ||
    !isConfigBinding(input.config_binding)
  ) {
    return null;
  }
  const observedAt = safeTimestamp(input.observed_at_ms);
  const aliases = parseAliases(input.aliases, true);
  if (observedAt === null || aliases === null) return null;
  return {
    schema_version: CODEX_OBSERVATION_SCHEMA_VERSION,
    provider: CODEX_PROVIDER,
    config_binding: input.config_binding,
    observed_at_ms: observedAt,
    aliases,
  };
}

export function parseCodexObserverOutcome(
  outcome: CodexObserverRunOutcome,
): CodexCapacityObservation | null {
  if (outcome.code !== 0 || outcome.failure !== undefined) return null;
  const parsed = boundedJson(outcome.stdout, CODEX_MAX_OBSERVER_OUTPUT_BYTES);
  return parsed === null ? null : parseCodexObserverEnvelope(parsed);
}

export function validateCodexObservation(
  data: unknown,
): CodexCapacityObservation | null {
  const input = record(data);
  if (
    input === null ||
    input.schema_version !== CODEX_OBSERVATION_SCHEMA_VERSION ||
    input.provider !== CODEX_PROVIDER ||
    !isConfigBinding(input.config_binding)
  ) {
    return null;
  }
  const observedAt = safeTimestamp(input.observed_at_ms);
  const aliases = parseAliases(input.aliases, false);
  if (observedAt === null || aliases === null) return null;
  return {
    schema_version: CODEX_OBSERVATION_SCHEMA_VERSION,
    provider: CODEX_PROVIDER,
    config_binding: input.config_binding,
    observed_at_ms: observedAt,
    aliases,
  };
}

export function serializeCodexObservation(
  observation: CodexCapacityObservation,
): string {
  return `${JSON.stringify(observation, null, 2)}\n`;
}

export function writeCodexObservationSidecar(
  path: string,
  observation: CodexCapacityObservation,
): void {
  const validated = validateCodexObservation(observation);
  if (validated === null) throw new Error("invalid Codex observation");
  const content = serializeCodexObservation(validated);
  if (Buffer.byteLength(content, "utf8") > CODEX_MAX_OBSERVATION_BYTES) {
    throw new Error("Codex observation exceeds size limit");
  }
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const temporary = join(
    parent,
    `.${path.split("/").pop()}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    writeFileSync(fd, content, "utf8");
    closeSync(fd);
    fd = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function readCodexObservationSidecar(
  path: string,
): CodexCapacityObservation | null {
  try {
    if (!existsSync(path)) return null;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > CODEX_MAX_OBSERVATION_BYTES) return null;
    const parsed = boundedJson(
      readFileSync(path, "utf8"),
      CODEX_MAX_OBSERVATION_BYTES,
    );
    return parsed === null ? null : validateCodexObservation(parsed);
  } catch {
    return null;
  }
}

export function isCodexObservationFresh(
  observation: CodexCapacityObservation,
  nowMs: number,
  maxAgeMs: number = CODEX_OBSERVATION_FRESHNESS_CEILING_MS,
): boolean {
  const age = nowMs - observation.observed_at_ms;
  return age >= 0 && maxAgeMs >= 0 && age <= maxAgeMs;
}

export function isCodexAliasFresh(
  alias: CodexCapacityAlias,
  nowMs: number,
): boolean {
  return (
    nowMs >= alias.observed_at_ms &&
    nowMs <= alias.expires_at_ms &&
    alias.status !== "unavailable"
  );
}
