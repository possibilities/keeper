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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  boundedCodexPoolProofRecord,
  exactKeys,
} from "../../../src/codex-pool-proof-window.ts";

export const MAX_POOL_ALIASES = 8;
export const DEFAULT_ACCOUNT_ALIASES = [
  "keeper-codex-a",
  "keeper-codex-b",
] as const;
const MAX_AUTH_BYTES = 1024 * 1024;
const REFRESH_SKEW_MS = 60_000;
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5_000;

export interface StoredOAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

export interface ResolvedCredential {
  access: string;
  expires: number;
}

export interface ForcedRefreshRequest {
  schema_version: 1;
  alias: string;
}

export type ForcedRefreshOutcome =
  | { status: "inactive" }
  | { status: "rotated"; alias: string; expires: number }
  | {
      status: "inconclusive";
      alias: string;
      outcome: "already-fresh";
      reason: "credential-unchanged";
    }
  | {
      status: "failed";
      alias: string;
      reason: PoolCredentialError["code"];
    };

export interface CredentialStorage {
  read(alias: string): Promise<StoredOAuthCredential | undefined>;
  modify(
    alias: string,
    update: (
      current: StoredOAuthCredential | undefined,
    ) => Promise<StoredOAuthCredential | undefined>,
    options?: { signal?: AbortSignal; deadlineMs?: number },
  ): Promise<StoredOAuthCredential | undefined>;
}

export interface CanonicalOAuth {
  name: string;
  login(interaction: CanonicalAuthInteraction): Promise<StoredOAuthCredential>;
  refresh(
    credential: StoredOAuthCredential,
    signal?: AbortSignal,
  ): Promise<StoredOAuthCredential>;
  toAuth(credential: StoredOAuthCredential): Promise<{ apiKey?: string }>;
}

interface CanonicalPromptBase {
  message: string;
  placeholder?: string;
  signal?: AbortSignal;
}

export type CanonicalAuthPrompt =
  | (CanonicalPromptBase & { type: "text" | "secret" | "manual_code" })
  | (CanonicalPromptBase & {
      type: "select";
      options: readonly {
        id: string;
        label: string;
        description?: string;
      }[];
    });

export type CanonicalAuthEvent =
  | { type: "info"; message: string }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export interface CanonicalAuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: CanonicalAuthPrompt): Promise<string>;
  notify(event: CanonicalAuthEvent): void;
}

export interface ExtensionOAuthCallbacks {
  signal?: AbortSignal;
  onAuth(info: { url: string; instructions?: string }): void;
  onDeviceCode(info: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }): void;
  onProgress?(message: string): void;
  onPrompt(info: { message: string }): Promise<string>;
  onManualCodeInput?(): Promise<string>;
  onSelect(info: {
    message: string;
    options: readonly {
      id: string;
      label: string;
      description?: string;
    }[];
  }): Promise<string | undefined>;
}

export interface ExtensionOAuthConfig {
  name: string;
  login(callbacks: ExtensionOAuthCallbacks): Promise<{
    access: string;
    refresh: string;
    expires: number;
  }>;
  refreshToken(credentials: {
    access: string;
    refresh: string;
    expires: number;
  }): Promise<{ access: string; refresh: string; expires: number }>;
  getApiKey(credentials: { access: string }): string;
}

export class PoolCredentialError extends Error {
  readonly code:
    | "credential-aborted"
    | "credential-missing"
    | "credential-invalid"
    | "credential-login-failed"
    | "credential-refresh-failed"
    | "credential-storage-failed"
    | "credential-proof-seam-invalid";

  constructor(code: PoolCredentialError["code"]) {
    super(code);
    this.name = "PoolCredentialError";
    this.code = code;
  }
}

export function isOpaqueAlias(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^keeper-codex-[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(value)
  );
}

export function normalizeAliases(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > MAX_POOL_ALIASES
  ) {
    throw new Error("invalid-account-alias-config");
  }
  const aliases = input.map((value) => {
    if (!isOpaqueAlias(value)) throw new Error("invalid-account-alias-config");
    return value;
  });
  if (new Set(aliases).size !== aliases.length) {
    throw new Error("invalid-account-alias-config");
  }
  return aliases;
}

export function aliasesFromEnvironment(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "")
    return [...DEFAULT_ACCOUNT_ALIASES];
  try {
    return normalizeAliases(JSON.parse(raw));
  } catch {
    throw new Error("invalid-account-alias-config");
  }
}

export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  return configured || join(homedir(), ".pi", "agent");
}

function isStoredOAuthCredential(
  value: unknown,
): value is StoredOAuthCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "oauth" &&
    typeof record.access === "string" &&
    record.access.length > 0 &&
    typeof record.refresh === "string" &&
    record.refresh.length > 0 &&
    typeof record.expires === "number" &&
    Number.isFinite(record.expires) &&
    record.expires > 0
  );
}

export function storedOAuthCredentialsEqual(
  left: StoredOAuthCredential,
  right: StoredOAuthCredential,
): boolean {
  return (
    left.access === right.access &&
    left.refresh === right.refresh &&
    Math.floor(left.expires) === Math.floor(right.expires)
  );
}

function privateCredential(
  value: StoredOAuthCredential,
): StoredOAuthCredential {
  if (!isStoredOAuthCredential(value))
    throw new PoolCredentialError("credential-invalid");
  return {
    type: "oauth",
    access: value.access,
    refresh: value.refresh,
    expires: Math.floor(value.expires),
  };
}

function aborted(signal: AbortSignal | undefined, deadlineMs: number): boolean {
  return signal?.aborted === true || Date.now() >= deadlineMs;
}

function waitForLock(
  signal: AbortSignal | undefined,
  deadlineMs: number,
): Promise<void> {
  if (aborted(signal, deadlineMs)) {
    return Promise.reject(new PoolCredentialError("credential-aborted"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new PoolCredentialError("credential-aborted"));
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.min(LOCK_RETRY_MS, deadlineMs - Date.now()),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function acquireFileLock(
  authPath: string,
  signal?: AbortSignal,
  requestedDeadlineMs?: number,
): Promise<() => void> {
  const deadlineMs = Math.min(
    requestedDeadlineMs ?? Number.POSITIVE_INFINITY,
    Date.now() + LOCK_TIMEOUT_MS,
  );
  const lockPath = `${authPath}.lock`;
  while (true) {
    if (aborted(signal, deadlineMs)) {
      throw new PoolCredentialError("credential-aborted");
    }
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      return () => {
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // A compromised lock fails the next operation closed.
        }
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (code !== "EEXIST") {
        throw new PoolCredentialError("credential-storage-failed");
      }
      await waitForLock(signal, deadlineMs);
    }
  }
}

function readAuthObject(authPath: string): Record<string, unknown> {
  if (!existsSync(authPath)) return {};
  const stat = statSync(authPath);
  if (!stat.isFile() || stat.size > MAX_AUTH_BYTES) {
    throw new PoolCredentialError("credential-storage-failed");
  }
  const parsed = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PoolCredentialError("credential-storage-failed");
  }
  return parsed as Record<string, unknown>;
}

export function writePrivateFileAtomic(path: string, content: string): void {
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
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The original file remains authoritative.
    }
    throw error;
  }
}

export function writePrivateJsonAtomic(path: string, value: unknown): void {
  try {
    writePrivateFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
  } catch {
    throw new PoolCredentialError("credential-storage-failed");
  }
}

export class FileCredentialStorage implements CredentialStorage {
  constructor(readonly authPath = join(defaultAgentDir(), "auth.json")) {}

  async read(alias: string): Promise<StoredOAuthCredential | undefined> {
    try {
      const value = readAuthObject(this.authPath)[alias];
      return isStoredOAuthCredential(value) ? value : undefined;
    } catch (error) {
      if (error instanceof PoolCredentialError) throw error;
      throw new PoolCredentialError("credential-storage-failed");
    }
  }

  async modify(
    alias: string,
    update: (
      current: StoredOAuthCredential | undefined,
    ) => Promise<StoredOAuthCredential | undefined>,
    options: { signal?: AbortSignal; deadlineMs?: number } = {},
  ): Promise<StoredOAuthCredential | undefined> {
    if (!isOpaqueAlias(alias))
      throw new PoolCredentialError("credential-invalid");
    mkdirSync(dirname(this.authPath), { recursive: true, mode: 0o700 });
    const release = await acquireFileLock(
      this.authPath,
      options.signal,
      options.deadlineMs,
    );
    try {
      if (
        aborted(options.signal, options.deadlineMs ?? Number.POSITIVE_INFINITY)
      ) {
        throw new PoolCredentialError("credential-aborted");
      }
      const currentData = readAuthObject(this.authPath);
      const rawCurrent = currentData[alias];
      const current = isStoredOAuthCredential(rawCurrent)
        ? rawCurrent
        : undefined;
      const next = await update(current);
      if (next === undefined) return current;
      const privateNext = privateCredential(next);
      writePrivateJsonAtomic(this.authPath, {
        ...currentData,
        [alias]: privateNext,
      });
      return privateNext;
    } catch (error) {
      if (error instanceof PoolCredentialError) throw error;
      throw new PoolCredentialError("credential-storage-failed");
    } finally {
      release();
    }
  }
}

export class MemoryCredentialStorage implements CredentialStorage {
  private readonly values = new Map<string, StoredOAuthCredential>();
  private queue: Promise<void> = Promise.resolve();

  constructor(initial: Record<string, StoredOAuthCredential> = {}) {
    for (const [alias, credential] of Object.entries(initial)) {
      this.values.set(alias, privateCredential(credential));
    }
  }

  async read(alias: string): Promise<StoredOAuthCredential | undefined> {
    return this.values.get(alias);
  }

  async modify(
    alias: string,
    update: (
      current: StoredOAuthCredential | undefined,
    ) => Promise<StoredOAuthCredential | undefined>,
    options: { signal?: AbortSignal; deadlineMs?: number } = {},
  ): Promise<StoredOAuthCredential | undefined> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (
        options.signal?.aborted ||
        Date.now() >= (options.deadlineMs ?? Number.POSITIVE_INFINITY)
      ) {
        throw new PoolCredentialError("credential-aborted");
      }
      const next = await update(this.values.get(alias));
      if (next !== undefined) this.values.set(alias, privateCredential(next));
      return this.values.get(alias);
    } finally {
      release();
    }
  }
}

type CredentialRotation = "not-needed" | "rotated" | "unchanged";

interface CredentialResolution {
  credential: ResolvedCredential;
  rotation: CredentialRotation;
}

interface CredentialOperation {
  forced: boolean;
  promise: Promise<CredentialResolution>;
}

function forcedRefreshRequest(input: unknown): ForcedRefreshRequest {
  const request = boundedCodexPoolProofRecord(input);
  if (
    request === null ||
    !exactKeys(request, ["schema_version", "alias"]) ||
    request.schema_version !== 1 ||
    !isOpaqueAlias(request.alias)
  ) {
    throw new PoolCredentialError("credential-proof-seam-invalid");
  }
  return { schema_version: 1, alias: request.alias };
}

export class CredentialVault {
  private readonly refreshes = new Map<string, CredentialOperation>();
  private readonly proofRefreshAliases: ReadonlySet<string>;

  constructor(
    private readonly storage: CredentialStorage,
    private readonly refresh: (
      credential: StoredOAuthCredential,
      signal?: AbortSignal,
    ) => Promise<StoredOAuthCredential>,
    private readonly now: () => number = Date.now,
    private readonly proofRefreshActive: () => boolean = () => false,
    proofRefreshAliases: readonly string[] = [],
    private readonly onCredentialRotated?: (alias: string) => void,
  ) {
    this.proofRefreshAliases = new Set(
      proofRefreshAliases.filter(isOpaqueAlias),
    );
  }

  resolve(
    alias: string,
    options: { signal?: AbortSignal; deadlineMs?: number } = {},
  ): Promise<ResolvedCredential> {
    if (!isOpaqueAlias(alias)) {
      return Promise.reject(new PoolCredentialError("credential-invalid"));
    }
    const active = this.refreshes.get(alias);
    const operation = active ?? this.startResolution(alias, options, false);
    return this.waitForCaller(operation.promise, options).then(
      (result) => result.credential,
    );
  }

  async forceRefresh(
    input: unknown,
    options: { signal?: AbortSignal; deadlineMs?: number } = {},
  ): Promise<ForcedRefreshOutcome> {
    if (!this.seamActive()) return { status: "inactive" };
    const request = forcedRefreshRequest(input);
    if (!this.proofRefreshAliases.has(request.alias)) {
      throw new PoolCredentialError("credential-proof-seam-invalid");
    }
    while (true) {
      if (!this.seamActive()) return { status: "inactive" };
      const active = this.refreshes.get(request.alias);
      if (active !== undefined && !active.forced) {
        try {
          const result = await this.waitForCaller(active.promise, options);
          if (result.rotation === "rotated") {
            return {
              status: "rotated",
              alias: request.alias,
              expires: result.credential.expires,
            };
          }
        } catch (error) {
          return {
            status: "failed",
            alias: request.alias,
            reason:
              error instanceof PoolCredentialError
                ? error.code
                : "credential-refresh-failed",
          };
        }
        continue;
      }
      const operation =
        active ?? this.startResolution(request.alias, options, true);
      try {
        const result = await this.waitForCaller(operation.promise, options);
        if (result.rotation === "rotated") {
          return {
            status: "rotated",
            alias: request.alias,
            expires: result.credential.expires,
          };
        }
        return {
          status: "inconclusive",
          alias: request.alias,
          outcome: "already-fresh",
          reason: "credential-unchanged",
        };
      } catch (error) {
        return {
          status: "failed",
          alias: request.alias,
          reason:
            error instanceof PoolCredentialError
              ? error.code
              : "credential-refresh-failed",
        };
      }
    }
  }

  private seamActive(): boolean {
    try {
      return this.proofRefreshActive();
    } catch {
      return false;
    }
  }

  private observeRotation(alias: string): void {
    try {
      this.onCredentialRotated?.(alias);
    } catch {
      // Evidence collection cannot change credential resolution.
    }
  }

  private startResolution(
    alias: string,
    options: { signal?: AbortSignal; deadlineMs?: number },
    forced: boolean,
  ): CredentialOperation {
    const entry = {} as CredentialOperation;
    const promise = this.resolveLocked(alias, options, forced).finally(() => {
      if (this.refreshes.get(alias) === entry) this.refreshes.delete(alias);
    });
    entry.forced = forced;
    entry.promise = promise;
    this.refreshes.set(alias, entry);
    return entry;
  }

  private waitForCaller<T>(
    operation: Promise<T>,
    options: { signal?: AbortSignal; deadlineMs?: number },
  ): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(new PoolCredentialError("credential-aborted"));
    }
    const remaining =
      options.deadlineMs === undefined
        ? undefined
        : Math.max(0, options.deadlineMs - this.now());
    if (remaining === 0) {
      return Promise.reject(new PoolCredentialError("credential-aborted"));
    }
    if (!options.signal && remaining === undefined) return operation;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        reject(new PoolCredentialError("credential-aborted"));
      };
      const timer =
        remaining === undefined ? undefined : setTimeout(onAbort, remaining);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      operation.then(
        (result) => {
          if (timer !== undefined) clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          resolve(result);
        },
        (error: unknown) => {
          if (timer !== undefined) clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private async resolveLocked(
    alias: string,
    options: { signal?: AbortSignal; deadlineMs?: number },
    forced: boolean,
  ): Promise<CredentialResolution> {
    if (options.signal?.aborted) {
      throw new PoolCredentialError("credential-aborted");
    }
    let current: StoredOAuthCredential | undefined;
    try {
      current = await this.storage.read(alias);
    } catch {
      throw new PoolCredentialError("credential-storage-failed");
    }
    if (!current) throw new PoolCredentialError("credential-missing");
    if (!isStoredOAuthCredential(current)) {
      throw new PoolCredentialError("credential-invalid");
    }
    if (!forced && current.expires > this.now() + REFRESH_SKEW_MS) {
      return {
        credential: { access: current.access, expires: current.expires },
        rotation: "not-needed",
      };
    }
    let refreshed: StoredOAuthCredential | undefined;
    const refreshState: {
      prior?: StoredOAuthCredential;
      rotation: CredentialRotation;
    } = { rotation: "unchanged" };
    try {
      refreshed = await this.storage.modify(
        alias,
        async (latest) => {
          if (!latest || !isStoredOAuthCredential(latest)) {
            throw new PoolCredentialError("credential-missing");
          }
          if (!forced && latest.expires > this.now() + REFRESH_SKEW_MS) {
            refreshState.rotation = "not-needed";
            return undefined;
          }
          if (options.signal?.aborted) {
            throw new PoolCredentialError("credential-aborted");
          }
          refreshState.prior = privateCredential(latest);
          try {
            const candidate = privateCredential(
              await this.refresh({ ...refreshState.prior }, options.signal),
            );
            if (options.signal?.aborted) {
              throw new PoolCredentialError("credential-aborted");
            }
            if (storedOAuthCredentialsEqual(refreshState.prior, candidate)) {
              refreshState.rotation = "unchanged";
              return undefined;
            }
            refreshState.rotation = "rotated";
            return candidate;
          } catch (error) {
            if (
              options.signal?.aborted ||
              (error instanceof PoolCredentialError &&
                error.code === "credential-aborted")
            ) {
              throw new PoolCredentialError("credential-aborted");
            }
            throw new PoolCredentialError("credential-refresh-failed");
          }
        },
        options,
      );
    } catch (error) {
      if (error instanceof PoolCredentialError) throw error;
      throw new PoolCredentialError("credential-storage-failed");
    }
    if (!refreshed || !isStoredOAuthCredential(refreshed)) {
      throw new PoolCredentialError("credential-invalid");
    }
    if (
      refreshState.rotation === "rotated" &&
      refreshState.prior !== undefined &&
      storedOAuthCredentialsEqual(refreshState.prior, refreshed)
    ) {
      refreshState.rotation = "unchanged";
    }
    if (refreshState.rotation === "rotated") this.observeRotation(alias);
    return {
      credential: { access: refreshed.access, expires: refreshed.expires },
      rotation: refreshState.rotation,
    };
  }
}

function extensionCredential(credential: StoredOAuthCredential): {
  access: string;
  refresh: string;
  expires: number;
} {
  const value = privateCredential(credential);
  return {
    access: value.access,
    refresh: value.refresh,
    expires: value.expires,
  };
}

export function extensionOAuthFromCanonical(
  oauth: CanonicalOAuth,
): ExtensionOAuthConfig {
  return {
    name: oauth.name,
    async login(callbacks) {
      try {
        const credential = await oauth.login({
          signal: callbacks.signal,
          async prompt(prompt) {
            if (prompt.type === "select") {
              const selected = await callbacks.onSelect({
                message: prompt.message,
                options: prompt.options,
              });
              if (selected === undefined) throw new Error("login-cancelled");
              return selected;
            }
            if (prompt.type === "manual_code" && callbacks.onManualCodeInput) {
              return callbacks.onManualCodeInput();
            }
            return callbacks.onPrompt({ message: prompt.message });
          },
          notify(event) {
            if (event.type === "auth_url") {
              callbacks.onAuth({
                url: event.url,
                ...(event.instructions === undefined
                  ? {}
                  : { instructions: event.instructions }),
              });
            } else if (event.type === "device_code") {
              callbacks.onDeviceCode(event);
            } else if (event.type === "progress" || event.type === "info") {
              callbacks.onProgress?.(event.message);
            }
          },
        });
        return extensionCredential(credential);
      } catch {
        throw new PoolCredentialError("credential-login-failed");
      }
    },
    async refreshToken(credentials) {
      try {
        return extensionCredential(
          await oauth.refresh({ ...credentials, type: "oauth" }),
        );
      } catch {
        throw new PoolCredentialError("credential-refresh-failed");
      }
    },
    getApiKey(credentials) {
      return credentials.access;
    },
  };
}
