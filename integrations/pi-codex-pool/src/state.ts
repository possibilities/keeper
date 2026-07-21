import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CODEX_GENERIC_QUOTA_SCOPE,
  CODEX_QUOTA_SCOPES,
  CODEX_SPARK_QUOTA_SCOPE,
  type CodexQuotaScope,
  isCodexQuotaScope,
} from "../../../src/codex-quota-scope.ts";
import {
  defaultAgentDir,
  isOpaqueAlias,
  normalizeAliases,
  writePrivateJsonAtomic,
} from "./auth.ts";
import { acquireOwnerFileLock } from "./state-lock.ts";
import { type SanitizedUsageSnapshot, usageScopeView } from "./usage.ts";

export const POOL_STATE_SCHEMA_VERSION = 2;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_SESSION_ROUTES = 256;
const MAX_ALIAS_POLICY_BYTES = 2048;
const PRESSURE_TTL_MS = 30_000;
const FAILURE_COOLDOWN_MS = 60_000;
const USAGE_TTL_HORIZON_MS = 300_000;
const PROVIDER_RESET_HORIZON_MS = 45 * 24 * 60 * 60 * 1000;
const STATE_LOCK_TIMEOUT_MS = 2_000;
const STATE_LOCK_RETRY_MS = 10;
const MAX_PENDING_PRESSURE_RELEASES = 100;

export type PoolFailureClass =
  | "quota"
  | "rate"
  | "auth"
  | "transport"
  | "context"
  | "other";

export interface ScopeQuotaState {
  quota_scope: CodexQuotaScope;
  used_percent: number;
  usage_expires_at_ms: number;
  cooldown_until_ms: number;
  observed_at_ms: number;
  exhausted: boolean;
}

export interface AccountState {
  alias: string;
  quota_scopes: ScopeQuotaState[];
  pressure: number;
  pressure_expires_at_ms: number;
  cooldown_until_ms: number;
  last_selected_at_ms: number;
}

export interface PersistedPoolState {
  schema_version: 2;
  config_binding: string;
  accounts: AccountState[];
}

export type PoolAliasPolicy = Record<CodexQuotaScope, string[]>;

interface SessionRoute {
  alias: string;
  touched_at_ms: number;
}

export interface HeldFileLock {
  release(): void;
}

export type PoolStateTransactionStage = "lock" | "load" | "callback" | "save";

export type PoolStateTransactResult<T> =
  | { ok: true; state: PersistedPoolState; value: T }
  | { ok: false; stage: PoolStateTransactionStage; error: unknown };

function acquireStateLock(path: string): HeldFileLock {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  return acquireOwnerFileLock(lockPath, {
    timeoutMs: STATE_LOCK_TIMEOUT_MS,
    retryMs: STATE_LOCK_RETRY_MS,
  });
}

export function poolConfigBinding(aliases: readonly string[]): string {
  const normalized = normalizeAliases([...aliases]);
  return createHash("sha256")
    .update(JSON.stringify({ schema_version: 1, aliases: normalized }))
    .digest("hex");
}

export function poolAliasPolicyBinding(
  aliases: readonly string[],
  policy: PoolAliasPolicy,
): string {
  const enrolledAliases = normalizeAliases([...aliases]);
  const enrolled = new Set(enrolledAliases);
  const source = policy ?? emptyPolicy();
  const canonicalPolicy = emptyPolicy();
  for (const scope of CODEX_QUOTA_SCOPES) {
    const selected = new Set(
      (source[scope] ?? []).filter((alias) => enrolled.has(alias)),
    );
    canonicalPolicy[scope] = enrolledAliases.filter((alias) =>
      selected.has(alias),
    );
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema_version: 1,
        enrolled_aliases: enrolledAliases,
        alias_policy: {
          [CODEX_GENERIC_QUOTA_SCOPE]:
            canonicalPolicy[CODEX_GENERIC_QUOTA_SCOPE],
          [CODEX_SPARK_QUOTA_SCOPE]: canonicalPolicy[CODEX_SPARK_QUOTA_SCOPE],
        },
      }),
    )
    .digest("hex");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteInteger(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    return undefined;
  }
  return value;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function percent(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : undefined;
}

function emptyScopeQuota(quotaScope: CodexQuotaScope): ScopeQuotaState {
  return {
    quota_scope: quotaScope,
    used_percent: quotaScope === CODEX_SPARK_QUOTA_SCOPE ? 100 : 50,
    usage_expires_at_ms: 0,
    cooldown_until_ms: 0,
    observed_at_ms: 0,
    exhausted: false,
  };
}

function parseScopeQuota(value: unknown): ScopeQuotaState | undefined {
  const record = object(value);
  if (!record || !isCodexQuotaScope(record.quota_scope)) return undefined;
  const used = percent(record.used_percent);
  const expires = timestamp(record.usage_expires_at_ms);
  const cooldown = timestamp(record.cooldown_until_ms);
  const observed =
    record.observed_at_ms === undefined ? 0 : timestamp(record.observed_at_ms);
  const exhausted =
    record.exhausted === undefined ? used === 100 : record.exhausted;
  if (
    used === undefined ||
    expires === undefined ||
    cooldown === undefined ||
    observed === undefined ||
    typeof exhausted !== "boolean"
  ) {
    return undefined;
  }
  return {
    quota_scope: record.quota_scope,
    used_percent: used,
    usage_expires_at_ms: expires,
    cooldown_until_ms: cooldown,
    observed_at_ms: observed,
    exhausted,
  };
}

function normalizeScopeQuotas(value: unknown): ScopeQuotaState[] | undefined {
  if (!Array.isArray(value) || value.length > CODEX_QUOTA_SCOPES.length) {
    return undefined;
  }
  const parsed = value.map(parseScopeQuota);
  if (parsed.some((entry) => entry === undefined)) return undefined;
  const byScope = new Map(
    (parsed as ScopeQuotaState[]).map((entry) => [entry.quota_scope, entry]),
  );
  if (byScope.size !== parsed.length) return undefined;
  return CODEX_QUOTA_SCOPES.map(
    (quotaScope) => byScope.get(quotaScope) ?? emptyScopeQuota(quotaScope),
  );
}

function parseAccount(value: unknown): AccountState | undefined {
  const record = object(value);
  if (!record || !isOpaqueAlias(record.alias)) return undefined;
  const pressure = finiteInteger(record.pressure, 0, 100);
  const pressureExpires = timestamp(record.pressure_expires_at_ms);
  const cooldown = timestamp(record.cooldown_until_ms);
  const lastSelected = timestamp(record.last_selected_at_ms);
  const quotaScopes = normalizeScopeQuotas(record.quota_scopes);
  if (
    pressure === undefined ||
    pressureExpires === undefined ||
    cooldown === undefined ||
    lastSelected === undefined ||
    quotaScopes === undefined
  ) {
    return undefined;
  }
  return {
    alias: record.alias,
    quota_scopes: quotaScopes,
    pressure,
    pressure_expires_at_ms: pressureExpires,
    cooldown_until_ms: cooldown,
    last_selected_at_ms: lastSelected,
  };
}

function emptyAccount(alias: string): AccountState {
  return {
    alias,
    quota_scopes: CODEX_QUOTA_SCOPES.map(emptyScopeQuota),
    pressure: 0,
    pressure_expires_at_ms: 0,
    cooldown_until_ms: 0,
    last_selected_at_ms: 0,
  };
}

function emptyPolicy(): PoolAliasPolicy {
  return {
    [CODEX_GENERIC_QUOTA_SCOPE]: [],
    [CODEX_SPARK_QUOTA_SCOPE]: [],
  };
}

export function defaultPoolAliasPolicy(
  _aliases: readonly string[],
): PoolAliasPolicy {
  return emptyPolicy();
}

function parsePolicyAliasList(
  value: unknown,
  enrolled: ReadonlySet<string>,
): string[] | undefined {
  if (!Array.isArray(value) || value.length > enrolled.size) return undefined;
  const aliases = value.map((entry) => {
    if (!isOpaqueAlias(entry) || !enrolled.has(entry)) return undefined;
    return entry;
  });
  if (aliases.some((entry) => entry === undefined)) return undefined;
  const parsed = aliases as string[];
  return new Set(parsed).size === parsed.length ? parsed : undefined;
}

export function poolAliasPolicyFromEnvironment(
  raw: string | undefined,
  aliases: readonly string[],
): PoolAliasPolicy | null {
  const enrolledAliases = normalizeAliases([...aliases]);
  if (raw === undefined || raw.trim() === "") return null;
  if (Buffer.byteLength(raw, "utf8") > MAX_ALIAS_POLICY_BYTES) return null;
  try {
    const record = object(JSON.parse(raw) as unknown);
    if (!record) return null;
    const entries = Object.entries(record);
    if (entries.length > CODEX_QUOTA_SCOPES.length) return null;
    const enrolled = new Set(enrolledAliases);
    const policy = emptyPolicy();
    for (const [scope, value] of entries) {
      if (!isCodexQuotaScope(scope)) return null;
      const parsed = parsePolicyAliasList(value, enrolled);
      if (parsed === undefined) return null;
      policy[scope] = parsed;
    }
    return policy;
  } catch {
    return null;
  }
}

export function initialQuotaScopeFromEnvironment(
  raw: string | undefined,
): CodexQuotaScope | undefined {
  if (raw === undefined || raw.trim() === "") return CODEX_GENERIC_QUOTA_SCOPE;
  const trimmed = raw.trim();
  return isCodexQuotaScope(trimmed) ? trimmed : undefined;
}

function sanitizePolicy(
  aliases: readonly string[],
  policy: PoolAliasPolicy | undefined,
): PoolAliasPolicy {
  const enrolled = new Set(aliases);
  const source = policy ?? emptyPolicy();
  const sanitized = emptyPolicy();
  for (const scope of CODEX_QUOTA_SCOPES) {
    sanitized[scope] = (source[scope] ?? []).filter(
      (alias, index, values) =>
        enrolled.has(alias) && values.indexOf(alias) === index,
    );
  }
  return sanitized;
}

function routeKey(sessionId: string, quotaScope: CodexQuotaScope): string {
  return `${quotaScope}\u0000${sessionId}`;
}

function resolveSelectArgs(
  scopeOrExcluded: CodexQuotaScope | ReadonlySet<string> | undefined,
  excluded: ReadonlySet<string> | undefined,
): { quotaScope: CodexQuotaScope; excluded: ReadonlySet<string> } {
  if (isCodexQuotaScope(scopeOrExcluded)) {
    return { quotaScope: scopeOrExcluded, excluded: excluded ?? new Set() };
  }
  return {
    quotaScope: CODEX_GENERIC_QUOTA_SCOPE,
    excluded: scopeOrExcluded ?? new Set(),
  };
}

function accountScope(
  account: AccountState,
  quotaScope: CodexQuotaScope,
): ScopeQuotaState {
  let current = account.quota_scopes.find(
    (entry) => entry.quota_scope === quotaScope,
  );
  if (current === undefined) {
    current = emptyScopeQuota(quotaScope);
    account.quota_scopes.push(current);
  }
  return current;
}

function cloneScope(scope: ScopeQuotaState): ScopeQuotaState {
  return { ...scope };
}

function cloneAccount(account: AccountState): AccountState {
  return {
    alias: account.alias,
    quota_scopes: CODEX_QUOTA_SCOPES.map((quotaScope) =>
      cloneScope(accountScope(account, quotaScope)),
    ),
    pressure: account.pressure,
    pressure_expires_at_ms: account.pressure_expires_at_ms,
    cooldown_until_ms: account.cooldown_until_ms,
    last_selected_at_ms: account.last_selected_at_ms,
  };
}

function activeUntil(value: number, now: number, horizonMs: number): number {
  return value > now && value <= now + horizonMs ? value : 0;
}

function activeMaxUntil(
  left: number,
  right: number,
  now: number,
  horizonMs: number,
): number {
  return Math.max(
    activeUntil(left, now, horizonMs),
    activeUntil(right, now, horizonMs),
  );
}

function pastOrCurrentTimestamp(value: number, now: number): number {
  return Number.isFinite(now) && now >= 0 && value <= now ? value : 0;
}

function activePressure(
  account: AccountState,
  now: number,
): { pressure: number; expiresAt: number } {
  const expiresAt = activeUntil(
    account.pressure_expires_at_ms,
    now,
    PRESSURE_TTL_MS,
  );
  return {
    pressure: expiresAt === 0 ? 0 : account.pressure,
    expiresAt,
  };
}

function sanitizeScopeQuota(
  scope: ScopeQuotaState,
  now: number,
): ScopeQuotaState {
  return {
    ...scope,
    usage_expires_at_ms: activeUntil(
      scope.usage_expires_at_ms,
      now,
      USAGE_TTL_HORIZON_MS,
    ),
    cooldown_until_ms: activeUntil(
      scope.cooldown_until_ms,
      now,
      PROVIDER_RESET_HORIZON_MS,
    ),
    observed_at_ms: pastOrCurrentTimestamp(scope.observed_at_ms, now),
  };
}

function sanitizeAccount(account: AccountState, now: number): AccountState {
  const pressure = activePressure(account, now);
  return {
    alias: account.alias,
    quota_scopes: CODEX_QUOTA_SCOPES.map((quotaScope) =>
      sanitizeScopeQuota(accountScope(account, quotaScope), now),
    ),
    pressure: pressure.pressure,
    pressure_expires_at_ms: pressure.expiresAt,
    cooldown_until_ms: activeUntil(
      account.cooldown_until_ms,
      now,
      FAILURE_COOLDOWN_MS,
    ),
    last_selected_at_ms: pastOrCurrentTimestamp(
      account.last_selected_at_ms,
      now,
    ),
  };
}

function sanitizeState(
  state: PersistedPoolState,
  now: number,
): PersistedPoolState {
  return {
    schema_version: POOL_STATE_SCHEMA_VERSION,
    config_binding: state.config_binding,
    accounts: state.accounts.map((account) => sanitizeAccount(account, now)),
  };
}

function unavailableObservation(scope: ScopeQuotaState): boolean {
  return scope.observed_at_ms > 0 && scope.usage_expires_at_ms === 0;
}

function mergeEqualObservation(
  left: ScopeQuotaState,
  right: ScopeQuotaState,
): ScopeQuotaState {
  const unavailable =
    unavailableObservation(left) || unavailableObservation(right);
  return {
    quota_scope: left.quota_scope,
    used_percent: Math.max(left.used_percent, right.used_percent),
    usage_expires_at_ms: unavailable
      ? 0
      : Math.max(left.usage_expires_at_ms, right.usage_expires_at_ms),
    cooldown_until_ms: 0,
    observed_at_ms: left.observed_at_ms,
    exhausted: left.exhausted || right.exhausted,
  };
}

function mergeScopeObservation(
  current: ScopeQuotaState,
  incoming: ScopeQuotaState,
  now: number,
): ScopeQuotaState {
  const selected =
    incoming.observed_at_ms > current.observed_at_ms
      ? cloneScope(incoming)
      : incoming.observed_at_ms < current.observed_at_ms
        ? cloneScope(current)
        : mergeEqualObservation(current, incoming);
  selected.cooldown_until_ms = activeMaxUntil(
    current.cooldown_until_ms,
    incoming.cooldown_until_ms,
    now,
    PROVIDER_RESET_HORIZON_MS,
  );
  return selected;
}

function mergeStaleAccount(
  current: AccountState,
  incoming: AccountState,
  now: number,
): AccountState {
  const currentActivePressure = activePressure(current, now);
  const incomingActivePressure = activePressure(incoming, now);
  const pressure = Math.max(
    currentActivePressure.pressure,
    incomingActivePressure.pressure,
  );
  return {
    alias: current.alias,
    quota_scopes: CODEX_QUOTA_SCOPES.map((quotaScope) =>
      mergeScopeObservation(
        accountScope(current, quotaScope),
        accountScope(incoming, quotaScope),
        now,
      ),
    ),
    pressure,
    pressure_expires_at_ms:
      pressure === 0
        ? 0
        : Math.max(
            currentActivePressure.pressure > 0
              ? currentActivePressure.expiresAt
              : 0,
            incomingActivePressure.pressure > 0
              ? incomingActivePressure.expiresAt
              : 0,
          ),
    cooldown_until_ms: activeMaxUntil(
      current.cooldown_until_ms,
      incoming.cooldown_until_ms,
      now,
      FAILURE_COOLDOWN_MS,
    ),
    last_selected_at_ms: Math.max(
      current.last_selected_at_ms,
      incoming.last_selected_at_ms,
    ),
  };
}

function mergeStaleState(
  current: PersistedPoolState,
  incoming: PersistedPoolState,
  now: number,
): PersistedPoolState {
  const incomingByAlias = new Map(
    incoming.accounts.map((account) => [account.alias, account]),
  );
  return {
    schema_version: POOL_STATE_SCHEMA_VERSION,
    config_binding: current.config_binding,
    accounts: current.accounts.map((account) => {
      const incomingAccount = incomingByAlias.get(account.alias);
      return incomingAccount === undefined
        ? cloneAccount(account)
        : mergeStaleAccount(account, incomingAccount, now);
    }),
  };
}

export class PoolStateStore {
  constructor(
    readonly path = join(defaultAgentDir(), "keeper-codex-pool-state.json"),
  ) {}

  load(
    aliases: readonly string[],
    binding = poolConfigBinding(aliases),
    now = Date.now(),
  ): PersistedPoolState {
    return this.loadUnlocked(aliases, binding, now);
  }

  transact<T>(
    aliases: readonly string[],
    binding: string,
    mutate: (state: PersistedPoolState) => T,
    now = Date.now(),
  ): PoolStateTransactResult<T> {
    let lock: HeldFileLock;
    try {
      lock = this.acquireLock();
    } catch (error) {
      return { ok: false, stage: "lock", error };
    }
    try {
      let state: PersistedPoolState;
      try {
        state = this.loadUnlocked(aliases, binding, now);
      } catch (error) {
        return { ok: false, stage: "load", error };
      }
      let value: T;
      try {
        value = mutate(state);
      } catch (error) {
        return { ok: false, stage: "callback", error };
      }
      try {
        state = sanitizeState(state, now);
        this.saveUnlocked(state, now);
      } catch (error) {
        return { ok: false, stage: "save", error };
      }
      return { ok: true, state, value };
    } finally {
      lock.release();
    }
  }

  save(state: PersistedPoolState): void {
    const now = Date.now();
    const incoming = sanitizeState(state, now);
    const aliases = incoming.accounts.map((account) => account.alias);
    const result = this.transact(
      aliases,
      incoming.config_binding,
      (current) => {
        const merged = mergeStaleState(current, incoming, now);
        current.schema_version = merged.schema_version;
        current.config_binding = merged.config_binding;
        current.accounts = merged.accounts;
      },
      now,
    );
    if (!result.ok) {
      throw result.error instanceof Error
        ? result.error
        : new Error(`pool-state-${result.stage}-failed`);
    }
  }

  protected acquireLock(): HeldFileLock {
    return acquireStateLock(this.path);
  }

  protected loadUnlocked(
    aliases: readonly string[],
    binding = poolConfigBinding(aliases),
    now = Date.now(),
  ): PersistedPoolState {
    const normalized = normalizeAliases([...aliases]);
    const empty = (): PersistedPoolState => ({
      schema_version: POOL_STATE_SCHEMA_VERSION,
      config_binding: binding,
      accounts: normalized.map(emptyAccount),
    });
    try {
      if (!existsSync(this.path)) return empty();
      const stat = statSync(this.path);
      if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return empty();
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      const record = object(raw);
      if (
        !record ||
        record.schema_version !== POOL_STATE_SCHEMA_VERSION ||
        record.config_binding !== binding ||
        !Array.isArray(record.accounts)
      ) {
        return empty();
      }
      const parsed = record.accounts.map(parseAccount);
      if (parsed.some((entry) => entry === undefined)) return empty();
      const byAlias = new Map(
        (parsed as AccountState[]).map((account) => [account.alias, account]),
      );
      return sanitizeState(
        {
          schema_version: POOL_STATE_SCHEMA_VERSION,
          config_binding: binding,
          accounts: normalized.map((alias) =>
            cloneAccount(byAlias.get(alias) ?? emptyAccount(alias)),
          ),
        },
        now,
      );
    } catch {
      return empty();
    }
  }

  protected saveUnlocked(state: PersistedPoolState, now = Date.now()): void {
    const sanitized = sanitizeState(state, now);
    writePrivateJsonAtomic(this.path, {
      schema_version: POOL_STATE_SCHEMA_VERSION,
      config_binding: sanitized.config_binding,
      accounts: sanitized.accounts.map((account) => ({
        alias: account.alias,
        quota_scopes: CODEX_QUOTA_SCOPES.map((quotaScope) => {
          const scope = accountScope(account, quotaScope);
          return {
            quota_scope: scope.quota_scope,
            used_percent: scope.used_percent,
            usage_expires_at_ms: scope.usage_expires_at_ms,
            cooldown_until_ms: scope.cooldown_until_ms,
            observed_at_ms: scope.observed_at_ms,
            exhausted: scope.exhausted,
          };
        }),
        pressure: account.pressure,
        pressure_expires_at_ms: account.pressure_expires_at_ms,
        cooldown_until_ms: account.cooldown_until_ms,
        last_selected_at_ms: account.last_selected_at_ms,
      })),
    });
  }
}

export class PoolRouteState {
  readonly binding: string;
  private state: PersistedPoolState;
  private readonly routes = new Map<string, SessionRoute>();
  private readonly inFlight = new Map<string, Map<string, number>>();
  private readonly pendingScopeIntents = new Map<
    string,
    Map<CodexQuotaScope, ScopeQuotaState>
  >();
  private readonly pendingAccountCooldowns = new Map<string, number>();
  private readonly pendingPressureReleases = new Map<string, number>();
  private initialRoute:
    | { alias: string; quotaScope: CodexQuotaScope }
    | undefined;
  private readonly aliasPolicy: PoolAliasPolicy;

  constructor(
    readonly aliases: readonly string[],
    private readonly store: PoolStateStore | null = null,
    private readonly now: () => number = Date.now,
    initialAlias?: string,
    initialScope: CodexQuotaScope = CODEX_GENERIC_QUOTA_SCOPE,
    aliasPolicy?: PoolAliasPolicy,
  ) {
    const normalized = normalizeAliases([...aliases]);
    this.aliases = normalized;
    this.binding = poolConfigBinding(normalized);
    this.aliasPolicy = sanitizePolicy(normalized, aliasPolicy);
    this.initialRoute =
      normalized.includes(initialAlias ?? "") &&
      isCodexQuotaScope(initialScope) &&
      this.aliasPolicy[initialScope].includes(initialAlias ?? "")
        ? { alias: initialAlias as string, quotaScope: initialScope }
        : undefined;
    this.state = {
      schema_version: POOL_STATE_SCHEMA_VERSION,
      config_binding: this.binding,
      accounts: normalized.map(emptyAccount),
    };
    if (store) {
      try {
        this.state = store.load(normalized, this.binding, this.now());
      } catch {
        // Selection re-enters through the locked transaction and fails closed.
      }
    }
  }

  applyUsage(snapshot: SanitizedUsageSnapshot): void {
    const now = this.now();
    const intents = this.usageScopeIntents(snapshot, now);
    const result = this.mutatePersisted(now, (state) => {
      this.applyScopeIntentsToState(state, snapshot.alias, intents, now);
    });
    if (!result.ok) {
      this.enqueueScopeIntents(snapshot.alias, intents, now);
    }
  }

  select(
    sessionId: string,
    quotaScopeOrExcluded?: CodexQuotaScope | ReadonlySet<string>,
    maybeExcluded?: ReadonlySet<string>,
  ): string {
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      throw new Error("session-id-required");
    }
    const { quotaScope, excluded } = resolveSelectArgs(
      quotaScopeOrExcluded,
      maybeExcluded,
    );
    const now = this.now();
    const key = routeKey(sessionId, quotaScope);
    const result = this.mutatePersisted(now, (state) => {
      const sticky = this.routes.get(key);
      if (
        sticky &&
        !excluded.has(sticky.alias) &&
        this.isEligibleIn(state, sticky.alias, quotaScope, excluded, now)
      ) {
        const account = this.accountIn(state, sticky.alias);
        if (!account) throw new Error("account-pool-exhausted");
        this.chargeSelection(account, now);
        return {
          alias: sticky.alias,
          consumeInitial: false,
          route: { alias: sticky.alias, touched_at_ms: now },
        };
      }

      const candidates = state.accounts.filter((account) =>
        this.isEligibleIn(state, account.alias, quotaScope, excluded, now),
      );
      if (candidates.length === 0) throw new Error("account-pool-exhausted");
      const initialRoute = this.initialRoute;
      const ranked = this.rankCandidates(candidates, quotaScope, now);
      const selected =
        initialRoute?.quotaScope === quotaScope
          ? (candidates.find(
              (account) => account.alias === initialRoute.alias,
            ) ?? ranked[0])
          : ranked[0];
      if (!selected) throw new Error("account-pool-exhausted");
      this.chargeSelection(selected, now);
      return {
        alias: selected.alias,
        consumeInitial: initialRoute?.quotaScope === quotaScope,
        route: { alias: selected.alias, touched_at_ms: now },
      };
    });
    if (!result.ok) this.throwTransactFailure(result);
    this.touchRoute(key, result.value.route);
    this.incrementInFlight(key, result.value.alias);
    if (result.value.consumeInitial) this.initialRoute = undefined;
    return result.value.alias;
  }

  hasEligibleRoute(
    quotaScopeOrExcluded?: CodexQuotaScope | ReadonlySet<string>,
    maybeExcluded?: ReadonlySet<string>,
  ): boolean {
    const { quotaScope, excluded } = resolveSelectArgs(
      quotaScopeOrExcluded,
      maybeExcluded,
    );
    const now = this.now();
    const result = this.mutatePersisted(now, (state) =>
      state.accounts.some((account) =>
        this.isEligibleIn(state, account.alias, quotaScope, excluded, now),
      ),
    );
    if (!result.ok) this.throwTransactFailure(result);
    return result.value;
  }

  recordSuccess(
    sessionId: string,
    alias: string,
    quotaScope: CodexQuotaScope = CODEX_GENERIC_QUOTA_SCOPE,
  ): void {
    const now = this.now();
    const key = routeKey(sessionId, quotaScope);
    const charged = this.hasInFlight(key, alias);
    const result = this.mutatePersisted(now, (state) => {
      const account = this.accountIn(state, alias);
      if (!account) return { charged: false };
      if (charged) this.decrementPressure(account, now);
      return { charged };
    });
    if (!result.ok) {
      if (charged) {
        this.enqueuePressureRelease(alias);
        this.consumeInFlight(key, alias);
      }
      return;
    }
    if (charged) this.consumeInFlight(key, alias);
    this.touchRoute(key, { alias, touched_at_ms: now });
  }

  releaseSelection(
    sessionId: string,
    alias: string,
    quotaScope: CodexQuotaScope = CODEX_GENERIC_QUOTA_SCOPE,
  ): void {
    const now = this.now();
    const key = routeKey(sessionId, quotaScope);
    const charged = this.hasInFlight(key, alias);
    const result = this.mutatePersisted(now, (state) => {
      const account = this.accountIn(state, alias);
      if (!account || !charged) return { charged: false };
      this.decrementPressure(account, now);
      return { charged: true };
    });
    if (!result.ok) {
      if (charged) {
        this.enqueuePressureRelease(alias);
        this.consumeInFlight(key, alias);
      }
      return;
    }
    if (charged) this.consumeInFlight(key, alias);
  }

  recordFailure(
    sessionId: string,
    alias: string,
    failureClass: PoolFailureClass,
    quotaScope: CodexQuotaScope = CODEX_GENERIC_QUOTA_SCOPE,
  ): void {
    const now = this.now();
    const key = routeKey(sessionId, quotaScope);
    const charged = this.hasInFlight(key, alias);
    const result = this.mutatePersisted(now, (state) => {
      const account = this.accountIn(state, alias);
      if (account) {
        if (charged) this.decrementPressure(account, now);
        this.applyFailureIntent(account, failureClass, quotaScope, now);
      }
      return { charged: account !== undefined && charged };
    });
    if (!result.ok) {
      if (charged) {
        this.enqueuePressureRelease(alias);
        this.consumeInFlight(key, alias);
      }
      this.enqueueFailureIntent(alias, failureClass, quotaScope, now);
      this.recordFailureRoute(key, alias, failureClass, now);
      return;
    }
    if (charged) this.consumeInFlight(key, alias);
    this.recordFailureRoute(key, alias, failureClass, now);
  }

  snapshot(): PersistedPoolState {
    this.refresh();
    const now = this.now();
    const snapshot = {
      schema_version: this.state.schema_version,
      config_binding: this.state.config_binding,
      accounts: this.state.accounts.map(cloneAccount),
    };
    this.applyPendingIntents(snapshot, now);
    return sanitizeState(snapshot, now);
  }

  routeFor(
    sessionId: string,
    quotaScope: CodexQuotaScope = CODEX_GENERIC_QUOTA_SCOPE,
  ): string | undefined {
    return this.routes.get(routeKey(sessionId, quotaScope))?.alias;
  }

  authorizedAliases(quotaScope: CodexQuotaScope): readonly string[] {
    return this.aliasPolicy[quotaScope];
  }

  private knownAlias(alias: string): boolean {
    return this.aliases.includes(alias);
  }

  private usageScopeIntents(
    snapshot: SanitizedUsageSnapshot,
    now: number,
  ): ScopeQuotaState[] {
    return CODEX_QUOTA_SCOPES.map((quotaScope) => {
      const view = usageScopeView(snapshot, quotaScope, now);
      return {
        quota_scope: quotaScope,
        used_percent:
          view.status === "unavailable"
            ? quotaScope === CODEX_SPARK_QUOTA_SCOPE
              ? 100
              : 50
            : view.used_percent,
        usage_expires_at_ms:
          view.status === "unavailable" ? 0 : view.expires_at_ms,
        cooldown_until_ms:
          view.status === "exhausted" ? view.cooldown_until_ms : 0,
        observed_at_ms: view.observed_at_ms,
        exhausted: view.status === "exhausted",
      };
    });
  }

  private applyScopeIntentsToState(
    state: PersistedPoolState,
    alias: string,
    intents: readonly ScopeQuotaState[],
    now: number,
  ): void {
    const account = this.accountIn(state, alias);
    if (!account) return;
    for (const incoming of intents) {
      const scope = accountScope(account, incoming.quota_scope);
      Object.assign(scope, mergeScopeObservation(scope, incoming, now));
    }
  }

  private enqueueScopeIntents(
    alias: string,
    intents: readonly ScopeQuotaState[],
    now: number,
  ): void {
    for (const intent of intents) {
      this.enqueueScopeIntent(alias, intent, now);
    }
  }

  private enqueueScopeIntent(
    alias: string,
    intent: ScopeQuotaState,
    now: number,
  ): void {
    if (!this.knownAlias(alias)) return;
    let scopes = this.pendingScopeIntents.get(alias);
    if (!scopes) {
      scopes = new Map();
      this.pendingScopeIntents.set(alias, scopes);
    }
    const current = scopes.get(intent.quota_scope);
    scopes.set(
      intent.quota_scope,
      current === undefined
        ? cloneScope(intent)
        : mergeScopeObservation(current, intent, now),
    );
  }

  private enqueuePressureRelease(alias: string): void {
    if (!this.knownAlias(alias)) return;
    this.pendingPressureReleases.set(
      alias,
      Math.min(
        MAX_PENDING_PRESSURE_RELEASES,
        (this.pendingPressureReleases.get(alias) ?? 0) + 1,
      ),
    );
  }

  private failureScopeIntent(
    quotaScope: CodexQuotaScope,
    now: number,
  ): ScopeQuotaState {
    return {
      quota_scope: quotaScope,
      used_percent: 100,
      usage_expires_at_ms: 0,
      cooldown_until_ms: now + FAILURE_COOLDOWN_MS,
      observed_at_ms: now,
      exhausted: true,
    };
  }

  private applyFailureIntent(
    account: AccountState,
    failureClass: PoolFailureClass,
    quotaScope: CodexQuotaScope,
    now: number,
  ): void {
    if (failureClass === "quota") {
      const scope = accountScope(account, quotaScope);
      Object.assign(
        scope,
        mergeScopeObservation(
          scope,
          this.failureScopeIntent(quotaScope, now),
          now,
        ),
      );
      return;
    }
    if (
      failureClass === "rate" ||
      failureClass === "auth" ||
      failureClass === "transport"
    ) {
      account.cooldown_until_ms = activeMaxUntil(
        account.cooldown_until_ms,
        now + FAILURE_COOLDOWN_MS,
        now,
        FAILURE_COOLDOWN_MS,
      );
    }
  }

  private enqueueFailureIntent(
    alias: string,
    failureClass: PoolFailureClass,
    quotaScope: CodexQuotaScope,
    now: number,
  ): void {
    if (!this.knownAlias(alias)) return;
    if (failureClass === "quota") {
      this.enqueueScopeIntent(
        alias,
        this.failureScopeIntent(quotaScope, now),
        now,
      );
      return;
    }
    if (
      failureClass === "rate" ||
      failureClass === "auth" ||
      failureClass === "transport"
    ) {
      this.pendingAccountCooldowns.set(
        alias,
        activeMaxUntil(
          this.pendingAccountCooldowns.get(alias) ?? 0,
          now + FAILURE_COOLDOWN_MS,
          now,
          FAILURE_COOLDOWN_MS,
        ),
      );
    }
  }

  private recordFailureRoute(
    key: string,
    alias: string,
    failureClass: PoolFailureClass,
    now: number,
  ): void {
    if (failureClass === "context") {
      this.touchRoute(key, { alias, touched_at_ms: now });
    } else if (this.routes.get(key)?.alias === alias) {
      this.routes.delete(key);
    }
  }

  private applyPendingIntents(state: PersistedPoolState, now: number): void {
    for (const [alias, count] of this.pendingPressureReleases) {
      const account = this.accountIn(state, alias);
      if (!account) continue;
      for (let index = 0; index < count; index += 1) {
        this.decrementPressure(account, now);
      }
    }
    for (const [alias, scopes] of this.pendingScopeIntents) {
      this.applyScopeIntentsToState(state, alias, [...scopes.values()], now);
    }
    for (const [alias, cooldownUntilMs] of this.pendingAccountCooldowns) {
      const account = this.accountIn(state, alias);
      if (!account) continue;
      account.cooldown_until_ms = activeMaxUntil(
        account.cooldown_until_ms,
        cooldownUntilMs,
        now,
        FAILURE_COOLDOWN_MS,
      );
    }
  }

  private clearPendingIntents(): void {
    this.pendingScopeIntents.clear();
    this.pendingAccountCooldowns.clear();
    this.pendingPressureReleases.clear();
  }

  private accountIn(
    state: PersistedPoolState,
    alias: string,
  ): AccountState | undefined {
    return state.accounts.find((account) => account.alias === alias);
  }

  private isEligibleIn(
    state: PersistedPoolState,
    alias: string,
    quotaScope: CodexQuotaScope,
    excluded: ReadonlySet<string>,
    now: number,
  ): boolean {
    if (excluded.has(alias) || !this.aliasPolicy[quotaScope].includes(alias)) {
      return false;
    }
    const account = this.accountIn(state, alias);
    if (
      !account ||
      activeUntil(account.cooldown_until_ms, now, FAILURE_COOLDOWN_MS) > now
    ) {
      return false;
    }
    const scope = accountScope(account, quotaScope);
    if (
      activeUntil(scope.cooldown_until_ms, now, PROVIDER_RESET_HORIZON_MS) > now
    ) {
      return false;
    }
    if (quotaScope === CODEX_SPARK_QUOTA_SCOPE) {
      return scope.usage_expires_at_ms > now && !scope.exhausted;
    }
    return scope.usage_expires_at_ms <= now || !scope.exhausted;
  }

  private chargeSelection(account: AccountState, now: number): void {
    const pressure = activePressure(account, now).pressure;
    account.pressure = Math.min(100, pressure + 1);
    account.pressure_expires_at_ms = now + PRESSURE_TTL_MS;
    account.last_selected_at_ms = now;
  }

  private decrementPressure(account: AccountState, now: number): void {
    const pressure = activePressure(account, now);
    if (pressure.expiresAt === 0) {
      account.pressure = 0;
      account.pressure_expires_at_ms = 0;
      return;
    }
    account.pressure = Math.max(0, pressure.pressure - 1);
    account.pressure_expires_at_ms = pressure.expiresAt;
    if (account.pressure === 0) account.pressure_expires_at_ms = 0;
  }

  private rankCandidates(
    candidates: AccountState[],
    quotaScope: CodexQuotaScope,
    now: number,
  ): AccountState[] {
    return [...candidates].sort((left, right) => {
      const leftPressure = activePressure(left, now).pressure;
      const rightPressure = activePressure(right, now).pressure;
      const leftScope = accountScope(left, quotaScope);
      const rightScope = accountScope(right, quotaScope);
      const leftUsage =
        leftScope.usage_expires_at_ms > now ? leftScope.used_percent : 50;
      const rightUsage =
        rightScope.usage_expires_at_ms > now ? rightScope.used_percent : 50;
      const score =
        leftUsage + leftPressure * 10 - (rightUsage + rightPressure * 10);
      if (score !== 0) return score;
      if (left.last_selected_at_ms !== right.last_selected_at_ms) {
        return left.last_selected_at_ms - right.last_selected_at_ms;
      }
      return left.alias.localeCompare(right.alias);
    });
  }

  private touchRoute(key: string, route: SessionRoute): void {
    this.routes.delete(key);
    this.routes.set(key, route);
    while (this.routes.size > MAX_SESSION_ROUTES) {
      const oldest = this.routes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.routes.delete(oldest);
    }
  }

  private hasInFlight(key: string, alias: string): boolean {
    return (this.inFlight.get(key)?.get(alias) ?? 0) > 0;
  }

  private incrementInFlight(key: string, alias: string): void {
    let counts = this.inFlight.get(key);
    if (!counts) {
      counts = new Map();
      this.inFlight.set(key, counts);
    }
    counts.set(alias, (counts.get(alias) ?? 0) + 1);
  }

  private consumeInFlight(key: string, alias: string): void {
    const counts = this.inFlight.get(key);
    if (!counts) return;
    const next = (counts.get(alias) ?? 0) - 1;
    if (next > 0) counts.set(alias, next);
    else counts.delete(alias);
    if (counts.size === 0) this.inFlight.delete(key);
  }

  private refresh(): void {
    if (!this.store) return;
    try {
      this.state = this.store.load(this.aliases, this.binding, this.now());
    } catch {
      // Selection re-enters through the locked transaction and fails closed.
    }
  }

  private mutatePersisted<T>(
    now: number,
    mutate: (state: PersistedPoolState) => T,
  ): PoolStateTransactResult<T> {
    const mutateWithPending = (state: PersistedPoolState): T => {
      this.applyPendingIntents(state, now);
      return mutate(state);
    };
    if (!this.store) {
      try {
        this.state = sanitizeState(this.state, now);
        const value = mutateWithPending(this.state);
        this.state = sanitizeState(this.state, now);
        this.clearPendingIntents();
        return { ok: true, state: this.state, value };
      } catch (error) {
        return { ok: false, stage: "callback", error };
      }
    }
    const result = this.store.transact(
      this.aliases,
      this.binding,
      mutateWithPending,
      now,
    );
    if (result.ok) {
      this.state = result.state;
      this.clearPendingIntents();
    }
    return result;
  }

  private throwTransactFailure(
    result: Extract<PoolStateTransactResult<unknown>, { ok: false }>,
  ): never {
    if (result.stage === "callback") {
      throw result.error instanceof Error
        ? result.error
        : new Error(String(result.error));
    }
    throw new Error("pool-state-unavailable");
  }
}
