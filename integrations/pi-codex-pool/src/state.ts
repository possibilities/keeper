import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  defaultAgentDir,
  isOpaqueAlias,
  normalizeAliases,
  writePrivateJsonAtomic,
} from "./auth.ts";
import { type SanitizedUsageSnapshot, worstUsedPercent } from "./usage.ts";

export const POOL_STATE_SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_SESSION_ROUTES = 256;
const PRESSURE_TTL_MS = 30_000;
const FAILURE_COOLDOWN_MS = 60_000;

export type PoolFailureClass =
  | "quota"
  | "rate"
  | "auth"
  | "transport"
  | "other";

export interface AccountState {
  alias: string;
  used_percent: number;
  usage_expires_at_ms: number;
  pressure: number;
  pressure_expires_at_ms: number;
  cooldown_until_ms: number;
  last_selected_at_ms: number;
}

export interface PersistedPoolState {
  schema_version: 1;
  config_binding: string;
  accounts: AccountState[];
}

interface SessionRoute {
  alias: string;
  touched_at_ms: number;
}

export function poolConfigBinding(aliases: readonly string[]): string {
  const normalized = normalizeAliases([...aliases]);
  return createHash("sha256")
    .update(JSON.stringify({ schema_version: 1, aliases: normalized }))
    .digest("hex");
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

function parseAccount(value: unknown): AccountState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (!isOpaqueAlias(record.alias)) return undefined;
  const used =
    typeof record.used_percent === "number" &&
    Number.isFinite(record.used_percent) &&
    record.used_percent >= 0 &&
    record.used_percent <= 100
      ? record.used_percent
      : undefined;
  const pressure = finiteInteger(record.pressure, 0, 100);
  const timestamps = [
    record.usage_expires_at_ms,
    record.pressure_expires_at_ms,
    record.cooldown_until_ms,
    record.last_selected_at_ms,
  ];
  if (
    used === undefined ||
    pressure === undefined ||
    timestamps.some(
      (entry) =>
        typeof entry !== "number" || !Number.isFinite(entry) || entry < 0,
    )
  ) {
    return undefined;
  }
  return {
    alias: record.alias,
    used_percent: used,
    pressure,
    usage_expires_at_ms: Math.floor(record.usage_expires_at_ms as number),
    pressure_expires_at_ms: Math.floor(record.pressure_expires_at_ms as number),
    cooldown_until_ms: Math.floor(record.cooldown_until_ms as number),
    last_selected_at_ms: Math.floor(record.last_selected_at_ms as number),
  };
}

function emptyAccount(alias: string): AccountState {
  return {
    alias,
    used_percent: 50,
    usage_expires_at_ms: 0,
    pressure: 0,
    pressure_expires_at_ms: 0,
    cooldown_until_ms: 0,
    last_selected_at_ms: 0,
  };
}

export class PoolStateStore {
  constructor(
    readonly path = join(defaultAgentDir(), "keeper-codex-pool-state.json"),
  ) {}

  load(
    aliases: readonly string[],
    binding = poolConfigBinding(aliases),
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
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty();
      const record = raw as Record<string, unknown>;
      if (
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
      return {
        schema_version: POOL_STATE_SCHEMA_VERSION,
        config_binding: binding,
        accounts: normalized.map(
          (alias) => byAlias.get(alias) ?? emptyAccount(alias),
        ),
      };
    } catch {
      return empty();
    }
  }

  save(state: PersistedPoolState): void {
    writePrivateJsonAtomic(this.path, {
      schema_version: POOL_STATE_SCHEMA_VERSION,
      config_binding: state.config_binding,
      accounts: state.accounts.map((account) => ({
        alias: account.alias,
        used_percent: account.used_percent,
        usage_expires_at_ms: account.usage_expires_at_ms,
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

  constructor(
    readonly aliases: readonly string[],
    private readonly store: PoolStateStore | null = null,
    private readonly now: () => number = Date.now,
  ) {
    const normalized = normalizeAliases([...aliases]);
    this.aliases = normalized;
    this.binding = poolConfigBinding(normalized);
    this.state = store?.load(normalized, this.binding) ?? {
      schema_version: POOL_STATE_SCHEMA_VERSION,
      config_binding: this.binding,
      accounts: normalized.map(emptyAccount),
    };
  }

  applyUsage(snapshot: SanitizedUsageSnapshot): void {
    const account = this.account(snapshot.alias);
    if (!account) return;
    account.used_percent = worstUsedPercent(snapshot);
    account.usage_expires_at_ms = snapshot.expires_at_ms;
    if (snapshot.status === "exhausted") {
      account.cooldown_until_ms = Math.max(
        account.cooldown_until_ms,
        snapshot.expires_at_ms,
        ...snapshot.windows.map((window) => window.reset_at_ms ?? 0),
      );
    } else if (snapshot.status === "healthy") {
      account.cooldown_until_ms = 0;
    }
    this.persist();
  }

  select(sessionId: string, excluded: ReadonlySet<string> = new Set()): string {
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      throw new Error("session-id-required");
    }
    const now = this.now();
    const sticky = this.routes.get(sessionId);
    if (sticky && !excluded.has(sticky.alias)) {
      sticky.touched_at_ms = now;
      this.touchRoute(sessionId, sticky);
      return sticky.alias;
    }
    const eligible = this.state.accounts.filter(
      (account) =>
        !excluded.has(account.alias) && account.cooldown_until_ms <= now,
    );
    const candidates =
      eligible.length > 0
        ? eligible
        : this.state.accounts.filter((account) => !excluded.has(account.alias));
    if (candidates.length === 0) throw new Error("account-pool-exhausted");
    const selected = [...candidates].sort((left, right) => {
      const leftPressure =
        left.pressure_expires_at_ms > now ? left.pressure : 0;
      const rightPressure =
        right.pressure_expires_at_ms > now ? right.pressure : 0;
      const leftUsage = left.usage_expires_at_ms > now ? left.used_percent : 50;
      const rightUsage =
        right.usage_expires_at_ms > now ? right.used_percent : 50;
      const score =
        leftUsage + leftPressure * 10 - (rightUsage + rightPressure * 10);
      if (score !== 0) return score;
      if (left.last_selected_at_ms !== right.last_selected_at_ms) {
        return left.last_selected_at_ms - right.last_selected_at_ms;
      }
      return left.alias.localeCompare(right.alias);
    })[0];
    selected.last_selected_at_ms = now;
    selected.pressure = Math.min(100, selected.pressure + 1);
    selected.pressure_expires_at_ms = now + PRESSURE_TTL_MS;
    this.touchRoute(sessionId, { alias: selected.alias, touched_at_ms: now });
    this.persist();
    return selected.alias;
  }

  recordSuccess(sessionId: string, alias: string): void {
    const account = this.account(alias);
    if (!account) return;
    account.pressure = Math.max(0, account.pressure - 1);
    if (account.pressure === 0) account.pressure_expires_at_ms = 0;
    account.cooldown_until_ms = 0;
    this.touchRoute(sessionId, { alias, touched_at_ms: this.now() });
    this.persist();
  }

  recordFailure(
    sessionId: string,
    alias: string,
    failureClass: PoolFailureClass,
  ): void {
    const account = this.account(alias);
    if (account) {
      account.pressure = Math.max(0, account.pressure - 1);
      account.pressure_expires_at_ms =
        account.pressure === 0 ? 0 : account.pressure_expires_at_ms;
      if (failureClass !== "other") {
        account.cooldown_until_ms = Math.max(
          account.cooldown_until_ms,
          this.now() + FAILURE_COOLDOWN_MS,
        );
      }
    }
    if (this.routes.get(sessionId)?.alias === alias)
      this.routes.delete(sessionId);
    this.persist();
  }

  snapshot(): PersistedPoolState {
    return {
      schema_version: this.state.schema_version,
      config_binding: this.state.config_binding,
      accounts: this.state.accounts.map((account) => ({ ...account })),
    };
  }

  routeFor(sessionId: string): string | undefined {
    return this.routes.get(sessionId)?.alias;
  }

  private account(alias: string): AccountState | undefined {
    return this.state.accounts.find((account) => account.alias === alias);
  }

  private touchRoute(sessionId: string, route: SessionRoute): void {
    this.routes.delete(sessionId);
    this.routes.set(sessionId, route);
    while (this.routes.size > MAX_SESSION_ROUTES) {
      const oldest = this.routes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.routes.delete(oldest);
    }
  }

  private persist(): void {
    if (!this.store) return;
    try {
      this.store.save(this.state);
    } catch {
      // Routing remains live in memory; persisted state is advisory.
    }
  }
}
