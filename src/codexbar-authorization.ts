/**
 * Keeper-owned authorization for unattended CodexBar observation.
 *
 * A receipt proves that one exact CodexBar executable completed a deliberate,
 * foreground provider check. The observer runs only receipt-authorized providers;
 * a changed executable or a provider-process failure removes that authority before
 * another unattended cycle can prompt. Receipts contain only a binary digest,
 * provider names, timestamps, and PII-free failure classes.
 *
 * DB-free leaf: node:* + account-routing helpers + FileLock only.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  type ObservationHealth,
  type ProviderRunFailure,
  type ProviderRunOutcome,
  parseCodexBar,
  parseCodexBarCodex,
} from "./account-observation";
import {
  codexBarClaudeUsageArgv,
  codexBarCodexUsageArgv,
  resolveCodexBarCommand,
} from "./account-routing-config";
import { FileLock } from "./file-lock";

export const CODEXBAR_AUTHORIZATION_SCHEMA_VERSION = 1;
export const CODEXBAR_AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
const MAX_RECEIPT_BYTES = 32 * 1024;
const PROVIDERS = ["claude", "codex"] as const;

export type CodexBarAuthorizationProvider = (typeof PROVIDERS)[number];
export type CodexBarAuthorizationBlockReason =
  | "authorization-required"
  | "provider-failure";

export interface CodexBarAuthorizationBlock {
  reason: CodexBarAuthorizationBlockReason;
  at_ms: number;
}

export interface CodexBarAuthorizationReceipt {
  schema_version: number;
  binary_sha256: string;
  /** Non-repeating identity for this digest's current authorization lifetime. */
  generation_nonce: string;
  authorized_providers: CodexBarAuthorizationProvider[];
  blocked_providers: Partial<
    Record<CodexBarAuthorizationProvider, CodexBarAuthorizationBlock>
  >;
  /** Monotonic per-provider CAS token for one foreground/observer attempt. */
  provider_revisions: Record<CodexBarAuthorizationProvider, number>;
  updated_at_ms: number;
}

export interface CodexBarBinaryFingerprint {
  path: string;
  sha256: string;
}

export interface CodexBarAuthorizationProviderResult {
  authorized: boolean;
  health: ObservationHealth;
  failure: ProviderRunFailure | null;
}

export interface CodexBarAuthorizationResult {
  schema_version: number;
  binary_sha256: string | null;
  providers: Record<
    CodexBarAuthorizationProvider,
    CodexBarAuthorizationProviderResult
  >;
  ok: boolean;
}

export type CodexBarRunner = (argv: string[]) => Promise<ProviderRunOutcome>;

export function codexBarAuthorizationPath(stateDir: string): string {
  return join(stateDir, "codexbar-authorization.json");
}

function authorizationLockPath(stateDir: string): string {
  return `${codexBarAuthorizationPath(stateDir)}.lock`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProvider(value: unknown): value is CodexBarAuthorizationProvider {
  return value === "claude" || value === "codex";
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function validateReceipt(value: unknown): CodexBarAuthorizationReceipt | null {
  if (!isRecord(value)) return null;
  if (value.schema_version !== CODEXBAR_AUTHORIZATION_SCHEMA_VERSION) {
    return null;
  }
  if (!isSha256(value.binary_sha256) || !isUuid(value.generation_nonce)) {
    return null;
  }
  if (
    typeof value.updated_at_ms !== "number" ||
    !Number.isFinite(value.updated_at_ms) ||
    !Array.isArray(value.authorized_providers) ||
    !isRecord(value.blocked_providers) ||
    !isRecord(value.provider_revisions)
  ) {
    return null;
  }

  const authorized = value.authorized_providers;
  if (
    !authorized.every(isProvider) ||
    new Set(authorized).size !== authorized.length
  ) {
    return null;
  }
  const providerRevisions = value.provider_revisions;
  const revisionKeys = Object.keys(providerRevisions);
  if (
    revisionKeys.length !== PROVIDERS.length ||
    !PROVIDERS.every((provider) =>
      Number.isSafeInteger(providerRevisions[provider]),
    ) ||
    !PROVIDERS.every((provider) => (providerRevisions[provider] as number) >= 0)
  ) {
    return null;
  }
  const blocked: CodexBarAuthorizationReceipt["blocked_providers"] = {};
  for (const [provider, rawBlock] of Object.entries(value.blocked_providers)) {
    if (!isProvider(provider) || !isRecord(rawBlock)) return null;
    if (
      (rawBlock.reason !== "authorization-required" &&
        rawBlock.reason !== "provider-failure") ||
      typeof rawBlock.at_ms !== "number" ||
      !Number.isFinite(rawBlock.at_ms)
    ) {
      return null;
    }
    if (authorized.includes(provider)) return null;
    blocked[provider] = {
      reason: rawBlock.reason,
      at_ms: rawBlock.at_ms,
    };
  }

  return {
    schema_version: CODEXBAR_AUTHORIZATION_SCHEMA_VERSION,
    binary_sha256: value.binary_sha256,
    generation_nonce: value.generation_nonce,
    authorized_providers: [...authorized].sort(),
    blocked_providers: blocked,
    provider_revisions: {
      claude: providerRevisions.claude as number,
      codex: providerRevisions.codex as number,
    },
    updated_at_ms: value.updated_at_ms,
  };
}

export function readCodexBarAuthorization(
  stateDir: string,
): CodexBarAuthorizationReceipt | null {
  const path = codexBarAuthorizationPath(stateDir);
  try {
    const data = readFileSync(path);
    if (data.byteLength > MAX_RECEIPT_BYTES) return null;
    return validateReceipt(JSON.parse(data.toString("utf8")));
  } catch {
    return null;
  }
}

function writeCodexBarAuthorization(
  stateDir: string,
  receipt: CodexBarAuthorizationReceipt,
): void {
  const path = codexBarAuthorizationPath(stateDir);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(receipt, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(temporary, path);
    const parentFd = openSync(parent, "r");
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    try {
      unlinkSync(temporary);
    } catch {
      // already renamed or absent
    }
    throw error;
  }
}

function receiptForFingerprint(
  current: CodexBarAuthorizationReceipt | null,
  fingerprint: CodexBarBinaryFingerprint,
  nowMs: number,
): CodexBarAuthorizationReceipt {
  if (current?.binary_sha256 === fingerprint.sha256) {
    return current;
  }
  return {
    schema_version: CODEXBAR_AUTHORIZATION_SCHEMA_VERSION,
    binary_sha256: fingerprint.sha256,
    generation_nonce: randomUUID(),
    authorized_providers: [],
    blocked_providers: {},
    provider_revisions: { claude: 0, codex: 0 },
    updated_at_ms: nowMs,
  };
}

type ReplaceDifferentGeneration = boolean | (() => boolean);

interface ReceiptMutation<T> {
  receipt: CodexBarAuthorizationReceipt;
  result: T;
}

interface CodexBarAttemptToken {
  generationNonce: string;
  revision: number;
}

function mutateReceipt<T>(
  stateDir: string,
  fingerprint: CodexBarBinaryFingerprint,
  nowMs: number,
  mutate: (receipt: CodexBarAuthorizationReceipt) => ReceiptMutation<T> | null,
  replaceDifferentGeneration: ReplaceDifferentGeneration,
): T | null {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = FileLock.acquire(authorizationLockPath(stateDir));
  try {
    const persisted = readCodexBarAuthorization(stateDir);
    if (persisted !== null && persisted.binary_sha256 !== fingerprint.sha256) {
      const mayReplace =
        typeof replaceDifferentGeneration === "function"
          ? replaceDifferentGeneration()
          : replaceDifferentGeneration;
      if (!mayReplace) return null;
    }
    const current = receiptForFingerprint(persisted, fingerprint, nowMs);
    const mutation = mutate(current);
    if (mutation === null) return null;
    writeCodexBarAuthorization(stateDir, mutation.receipt);
    return mutation.result;
  } finally {
    lock.release();
  }
}

function providerState(
  receipt: CodexBarAuthorizationReceipt,
  provider: CodexBarAuthorizationProvider,
  authorized: boolean,
  reason: CodexBarAuthorizationBlockReason,
  nowMs: number,
  revision: number,
): CodexBarAuthorizationReceipt {
  const authorizedProviders = new Set(receipt.authorized_providers);
  const blockedProviders = { ...receipt.blocked_providers };
  if (authorized) {
    authorizedProviders.add(provider);
    delete blockedProviders[provider];
  } else {
    authorizedProviders.delete(provider);
    blockedProviders[provider] = { reason, at_ms: nowMs };
  }
  return {
    ...receipt,
    authorized_providers: [...authorizedProviders].sort(),
    blocked_providers: blockedProviders,
    provider_revisions: {
      ...receipt.provider_revisions,
      [provider]: revision,
    },
    updated_at_ms: nowMs,
  };
}

function beginCodexBarAttempt(
  stateDir: string,
  fingerprint: CodexBarBinaryFingerprint,
  provider: CodexBarAuthorizationProvider,
  nowMs: number,
  requireAuthorized: boolean,
  replaceDifferentGeneration: ReplaceDifferentGeneration,
): CodexBarAttemptToken | null {
  return mutateReceipt(
    stateDir,
    fingerprint,
    nowMs,
    (receipt) => {
      if (
        requireAuthorized &&
        !receipt.authorized_providers.includes(provider)
      ) {
        return null;
      }
      const revision = receipt.provider_revisions[provider] + 1;
      return {
        receipt: providerState(
          receipt,
          provider,
          false,
          "authorization-required",
          nowMs,
          revision,
        ),
        result: {
          generationNonce: receipt.generation_nonce,
          revision,
        },
      };
    },
    replaceDifferentGeneration,
  );
}

function completeCodexBarAttempt(
  stateDir: string,
  fingerprint: CodexBarBinaryFingerprint,
  provider: CodexBarAuthorizationProvider,
  attempt: CodexBarAttemptToken,
  authorized: boolean,
  nowMs: number,
): boolean {
  return (
    mutateReceipt(
      stateDir,
      fingerprint,
      nowMs,
      (receipt) => {
        if (
          receipt.generation_nonce !== attempt.generationNonce ||
          receipt.provider_revisions[provider] !== attempt.revision
        ) {
          return null;
        }
        return {
          receipt: providerState(
            receipt,
            provider,
            authorized,
            authorized ? "authorization-required" : "provider-failure",
            nowMs,
            attempt.revision + 1,
          ),
          result: true,
        };
      },
      false,
    ) ?? false
  );
}

export function grantCodexBarAuthorization(
  stateDir: string,
  fingerprint: CodexBarBinaryFingerprint,
  provider: CodexBarAuthorizationProvider,
  nowMs: number,
): void {
  mutateReceipt(
    stateDir,
    fingerprint,
    nowMs,
    (receipt) => {
      const revision = receipt.provider_revisions[provider] + 1;
      return {
        receipt: providerState(
          receipt,
          provider,
          true,
          "authorization-required",
          nowMs,
          revision,
        ),
        result: true,
      };
    },
    true,
  );
}

export function isCodexBarProviderAuthorized(
  stateDir: string,
  fingerprint: CodexBarBinaryFingerprint,
  provider: CodexBarAuthorizationProvider,
): boolean {
  const receipt = readCodexBarAuthorization(stateDir);
  return (
    receipt?.binary_sha256 === fingerprint.sha256 &&
    receipt.authorized_providers.includes(provider)
  );
}

/** Verify that a sidecar digest still names the current executable. */
export function isCodexBarObservationCurrent(input: {
  binarySha256: string | null;
  codexbarBin?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}): boolean {
  if (input.binarySha256 === null) return false;
  const fingerprint = makeCodexBarFingerprintResolver(
    input.codexbarBin ?? resolveCodexBarCommand(),
    input.environment,
    input.cwd,
  )();
  return fingerprint?.sha256 === input.binarySha256;
}

/** Verify that a sidecar digest still names the current authorized executable. */
export function isCodexBarObservationAuthorized(input: {
  stateDir: string;
  binarySha256: string | null;
  provider: CodexBarAuthorizationProvider;
  codexbarBin?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}): boolean {
  if (input.binarySha256 === null) return false;
  const fingerprint = makeCodexBarFingerprintResolver(
    input.codexbarBin ?? resolveCodexBarCommand(),
    input.environment,
    input.cwd,
  )();
  return (
    fingerprint?.sha256 === input.binarySha256 &&
    isCodexBarProviderAuthorized(input.stateDir, fingerprint, input.provider)
  );
}

function resolveExecutablePath(
  command: string,
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string | null {
  const candidates = command.includes("/")
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : (environment.PATH ?? "")
        .split(delimiter)
        .map((entry) => join(entry || ".", command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      const path = realpathSync(candidate);
      if (statSync(path).isFile()) return path;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

export function makeCodexBarFingerprintResolver(
  command: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): () => CodexBarBinaryFingerprint | null {
  let cached:
    | { key: string; fingerprint: CodexBarBinaryFingerprint }
    | undefined;
  return () => {
    const path = resolveExecutablePath(command, environment, cwd);
    if (path === null || !existsSync(path)) return null;
    try {
      const stat = statSync(path);
      const key = [
        path,
        stat.dev,
        stat.ino,
        stat.size,
        stat.mtimeMs,
        stat.ctimeMs,
      ].join(":");
      if (cached?.key === key) return cached.fingerprint;
      const fingerprint = {
        path,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      };
      cached = { key, fingerprint };
      return fingerprint;
    } catch {
      return null;
    }
  };
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((token, index) => token === right[index])
  );
}

/** Bind foreground CodexBar calls to one fingerprinted generation. */
export function makeGenerationBoundCodexBarRunner(input: {
  codexbarBin: string;
  runner: CodexBarRunner;
  environment?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}): CodexBarRunner {
  const claudeArgv = codexBarClaudeUsageArgv(input.codexbarBin);
  const codexArgv = codexBarCodexUsageArgv(input.codexbarBin);
  const fingerprint = makeCodexBarFingerprintResolver(
    input.codexbarBin,
    input.environment,
    input.cwd,
  );
  return async (argv) => {
    const isCodexBar = sameArgv(argv, claudeArgv) || sameArgv(argv, codexArgv);
    if (!isCodexBar) return input.runner(argv);
    const current = fingerprint();
    if (current === null) {
      return { code: null, stdout: "", failure: "spawn" };
    }
    const outcome = await input.runner([current.path, ...argv.slice(1)]);
    return { ...outcome, binary_sha256: current.sha256 };
  };
}

/**
 * Wrap the production observer runner. Non-CodexBar calls pass through. An
 * unauthorized generation/provider is never spawned; any authorized provider
 * process failure durably removes its authority before the next cycle.
 */
export function makeAuthorizedCodexBarRunner(input: {
  stateDir: string;
  codexbarBin: string;
  runner: CodexBarRunner;
  nowMs?: () => number;
  environment?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  onBlocked?: (
    provider: CodexBarAuthorizationProvider,
    failure: ProviderRunFailure | null,
  ) => void;
}): CodexBarRunner {
  const claudeArgv = codexBarClaudeUsageArgv(input.codexbarBin);
  const codexArgv = codexBarCodexUsageArgv(input.codexbarBin);
  const fingerprint = makeCodexBarFingerprintResolver(
    input.codexbarBin,
    input.environment,
    input.cwd,
  );
  const nowMs = input.nowMs ?? (() => Date.now());

  return async (argv) => {
    const provider = sameArgv(argv, claudeArgv)
      ? "claude"
      : sameArgv(argv, codexArgv)
        ? "codex"
        : null;
    if (provider === null) return input.runner(argv);

    const current = fingerprint();
    if (current === null) {
      return {
        code: null,
        stdout: "",
        failure: "authorization-required",
      };
    }

    // Atomically consume this provider's authority before spawn. Concurrent
    // observer calls cannot both acquire an attempt, and a crash, timeout,
    // rejected prompt, or receipt-I/O failure leaves the durable state blocked.
    let attempt: CodexBarAttemptToken | null;
    try {
      attempt = beginCodexBarAttempt(
        input.stateDir,
        current,
        provider,
        nowMs(),
        true,
        false,
      );
    } catch {
      attempt = null;
    }
    if (attempt === null) {
      return {
        code: null,
        stdout: "",
        failure: "authorization-required",
        binary_sha256: current.sha256,
      };
    }

    // Fingerprinting resolves through `current` into an immutable 0555 managed
    // generation, which the installer never replaces in place. Spawn that exact
    // path so an atomic `current` swap cannot authorize different bytes.
    const outcome = await input.runner([current.path, ...argv.slice(1)]);
    const parsed =
      provider === "claude"
        ? parseCodexBar(outcome)
        : parseCodexBarCodex(outcome);
    const providerHealthy = parsed.health === "ok";
    let completed = false;
    try {
      completed = completeCodexBarAttempt(
        input.stateDir,
        current,
        provider,
        attempt,
        providerHealthy,
        nowMs(),
      );
    } catch {
      // The pre-spawn disarm remains the durable fail-closed state.
    }
    if (!completed) {
      return {
        code: null,
        stdout: "",
        failure: "authorization-required",
        binary_sha256: current.sha256,
      };
    }
    if (!providerHealthy) {
      input.onBlocked?.(provider, outcome.failure ?? null);
    }
    return { ...outcome, binary_sha256: current.sha256 };
  };
}

/**
 * Deliberately exercise both provider commands in the foreground, serially.
 * Raw output is parsed in-memory and never returned or persisted.
 */
export async function authorizeCodexBar(input: {
  stateDir: string;
  codexbarBin: string;
  runner: CodexBarRunner;
  nowMs?: () => number;
  environment?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}): Promise<CodexBarAuthorizationResult> {
  const nowMs = input.nowMs ?? (() => Date.now());
  const resolveFingerprint = makeCodexBarFingerprintResolver(
    input.codexbarBin,
    input.environment,
    input.cwd,
  );
  const fingerprint = resolveFingerprint();
  const unavailable: CodexBarAuthorizationProviderResult = {
    authorized: false,
    health: "absent",
    failure: "spawn",
  };
  if (fingerprint === null) {
    return {
      schema_version: CODEXBAR_AUTHORIZATION_SCHEMA_VERSION,
      binary_sha256: null,
      providers: { claude: unavailable, codex: unavailable },
      ok: false,
    };
  }

  const results = {} as Record<
    CodexBarAuthorizationProvider,
    CodexBarAuthorizationProviderResult
  >;
  let initializedReceipt = false;
  for (const provider of PROVIDERS) {
    const liveFingerprint = resolveFingerprint();
    if (liveFingerprint?.sha256 !== fingerprint.sha256) {
      results[provider] = {
        authorized: false,
        health: "absent",
        failure: "authorization-required",
      };
      continue;
    }

    const attempt = beginCodexBarAttempt(
      input.stateDir,
      fingerprint,
      provider,
      nowMs(),
      false,
      initializedReceipt
        ? false
        : () => resolveFingerprint()?.sha256 === fingerprint.sha256,
    );
    if (attempt === null) {
      results[provider] = {
        authorized: false,
        health: "absent",
        failure: "authorization-required",
      };
      continue;
    }
    initializedReceipt = true;

    const outcome = await input.runner(
      provider === "claude"
        ? codexBarClaudeUsageArgv(fingerprint.path)
        : codexBarCodexUsageArgv(fingerprint.path),
    );
    const parsed =
      provider === "claude"
        ? parseCodexBar(outcome)
        : parseCodexBarCodex(outcome);
    const providerHealthy = parsed.health === "ok";
    const completed = completeCodexBarAttempt(
      input.stateDir,
      fingerprint,
      provider,
      attempt,
      providerHealthy,
      nowMs(),
    );
    results[provider] = {
      authorized: providerHealthy && completed,
      health: completed ? parsed.health : "absent",
      failure: completed ? (outcome.failure ?? null) : "authorization-required",
    };
  }

  const current = resolveFingerprint();
  return {
    schema_version: CODEXBAR_AUTHORIZATION_SCHEMA_VERSION,
    binary_sha256: fingerprint.sha256,
    providers: results,
    ok:
      current?.sha256 === fingerprint.sha256 &&
      PROVIDERS.every((provider) => results[provider].authorized),
  };
}
