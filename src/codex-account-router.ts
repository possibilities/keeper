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
import { join } from "node:path";
import {
  CODEX_FAILURE_COOLDOWN_MS,
  CODEX_MAX_ALIASES,
  CODEX_MAX_OBSERVATION_BYTES,
  CODEX_MAX_RESERVATIONS_PER_ALIAS,
  CODEX_OBSERVATION_FRESHNESS_CEILING_MS,
  CODEX_PRESSURE_LEDGER_SCHEMA_VERSION,
  CODEX_PRESSURE_PERCENT_STEP,
  CODEX_PRESSURE_TTL_MS,
  codexObservationSidecarPath,
  codexPressureLedgerLockPath,
  codexPressureLedgerPath,
  resolveCodexAccountRoutingRoot,
} from "./account-routing-config";
import {
  CODEX_PROVIDER,
  type CodexCapacityAlias,
  type CodexCapacityObservation,
  type CodexScopedAliasCapacityView,
  codexScopedAliasCapacityView,
  isCodexAccountAlias,
  isCodexAliasFresh,
  isCodexObservationFresh,
  readCodexObservationSidecar,
} from "./codex-account-observation";
import {
  CODEX_GENERIC_QUOTA_SCOPE,
  CODEX_SPARK_QUOTA_SCOPE,
  type CodexQuotaScope,
  isCodexQuotaScope,
} from "./codex-quota-scope";
import { FileLock } from "./file-lock";

export const CODEX_NATIVE_FALLBACK_WARNING =
  "[keeper-codex-pool] pool-unavailable; using native openai-codex";

export type CodexNativeFallbackReason =
  | "observation-missing"
  | "observation-stale"
  | "pool-unavailable"
  | "pressure-contended"
  | "routing-error";

export type CodexRouteVerdict =
  | {
      kind: "pooled";
      provider: typeof CODEX_PROVIDER;
      alias: string;
      reason: "selected" | "sole-candidate" | "cooldown-recovered";
    }
  | {
      kind: "native-fallback";
      provider: typeof CODEX_PROVIDER;
      reason: CodexNativeFallbackReason;
      warning: typeof CODEX_NATIVE_FALLBACK_WARNING;
    };

interface PressureEntry {
  reservations: number[];
  shared_cooldown_until_ms: number;
  quota_cooldown_until_ms: Record<CodexQuotaScope, number>;
  last_selected_at_ms: number | null;
}

interface PressureLedger {
  schema_version: number;
  provider: typeof CODEX_PROVIDER;
  config_binding: string;
  aliases: Record<string, PressureEntry>;
}

interface ScoredCodexCandidate {
  alias: CodexCapacityAlias;
  view: CodexScopedAliasCapacityView;
  entry: PressureEntry;
  authorized: boolean;
  eligible: boolean;
}

export interface CodexRouteLock {
  release(): void;
}

export type TryAcquireCodexRouteLock = (path: string) => CodexRouteLock | null;

export interface SelectCodexRouteDeps {
  stateDir?: string;
  nowMs?: number;
  maxObservationAgeMs?: number;
  tryAcquireLock?: TryAcquireCodexRouteLock;
  quotaScope?: CodexQuotaScope;
  authorizedAliases?: readonly string[];
}

export type CodexRouteOutcome =
  | "success"
  | "quota"
  | "rate"
  | "auth"
  | "transport";

export interface RecordCodexRouteOutcomeDeps extends SelectCodexRouteDeps {
  alias: string;
  outcome: CodexRouteOutcome;
}

export interface CodexRoutingCandidate {
  alias: string;
  quota_scope: CodexQuotaScope;
  used_percent: number;
  worst_used_percent: number;
  pressure: number;
  cooldown_until_ms: number;
  shared_cooldown_until_ms: number;
  quota_cooldown_until_ms: number;
  capacity_cooldown_until_ms: number;
  authorized: boolean;
  eligible: boolean;
}

export interface CodexRoutingInspection {
  provider: typeof CODEX_PROVIDER;
  health: "missing" | "stale" | "ready" | "unavailable";
  config_binding: string | null;
  observed_at_ms: number | null;
  fresh: boolean;
  quota_scope: CodexQuotaScope;
  verdict: CodexRouteVerdict;
  candidates: CodexRoutingCandidate[];
}

const realTryAcquireLock: TryAcquireCodexRouteLock = (path) =>
  FileLock.tryAcquire(path);

function fallback(reason: CodexNativeFallbackReason): CodexRouteVerdict {
  return {
    kind: "native-fallback",
    provider: CODEX_PROVIDER,
    reason,
    warning: CODEX_NATIVE_FALLBACK_WARNING,
  };
}

function quotaScopeFor(value: unknown): CodexQuotaScope {
  return isCodexQuotaScope(value) ? value : CODEX_GENERIC_QUOTA_SCOPE;
}

function emptyQuotaCooldowns(): Record<CodexQuotaScope, number> {
  return {
    [CODEX_GENERIC_QUOTA_SCOPE]: 0,
    [CODEX_SPARK_QUOTA_SCOPE]: 0,
  };
}

function emptyEntry(): PressureEntry {
  return {
    reservations: [],
    shared_cooldown_until_ms: 0,
    quota_cooldown_until_ms: emptyQuotaCooldowns(),
    last_selected_at_ms: null,
  };
}

function emptyLedger(configBinding: string): PressureLedger {
  return {
    schema_version: CODEX_PRESSURE_LEDGER_SCHEMA_VERSION,
    provider: CODEX_PROVIDER,
    config_binding: configBinding,
    aliases: {},
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function parseQuotaCooldowns(
  value: unknown,
): Record<CodexQuotaScope, number> | null {
  const input = object(value);
  if (input === null || Object.keys(input).length !== 2) return null;
  const generic = timestamp(input[CODEX_GENERIC_QUOTA_SCOPE]);
  const spark = timestamp(input[CODEX_SPARK_QUOTA_SCOPE]);
  if (generic === null || spark === null) return null;
  return {
    [CODEX_GENERIC_QUOTA_SCOPE]: generic,
    [CODEX_SPARK_QUOTA_SCOPE]: spark,
  };
}

function parsePressureEntry(value: unknown): PressureEntry | null {
  const input = object(value);
  if (input === null || !Array.isArray(input.reservations)) return null;
  const reservations = input.reservations.map(timestamp);
  const sharedCooldown = timestamp(input.shared_cooldown_until_ms);
  const quotaCooldowns = parseQuotaCooldowns(input.quota_cooldown_until_ms);
  const last =
    input.last_selected_at_ms === null
      ? null
      : timestamp(input.last_selected_at_ms);
  if (
    reservations.some((entry) => entry === null) ||
    reservations.length > CODEX_MAX_RESERVATIONS_PER_ALIAS ||
    sharedCooldown === null ||
    quotaCooldowns === null ||
    (input.last_selected_at_ms !== null && last === null)
  ) {
    return null;
  }
  return {
    reservations: (reservations as number[]).sort(
      (left, right) => left - right,
    ),
    shared_cooldown_until_ms: sharedCooldown,
    quota_cooldown_until_ms: quotaCooldowns,
    last_selected_at_ms: last,
  };
}

function loadPressureLedger(
  stateDir: string,
  configBinding: string,
): PressureLedger {
  const path = codexPressureLedgerPath(stateDir);
  const empty = (): PressureLedger => emptyLedger(configBinding);
  try {
    if (!existsSync(path)) return empty();
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > CODEX_MAX_OBSERVATION_BYTES) {
      return empty();
    }
    const input = object(JSON.parse(readFileSync(path, "utf8")) as unknown);
    if (
      input === null ||
      input.schema_version !== CODEX_PRESSURE_LEDGER_SCHEMA_VERSION ||
      input.provider !== CODEX_PROVIDER ||
      input.config_binding !== configBinding
    ) {
      return empty();
    }
    const rawAliases = object(input.aliases);
    if (
      rawAliases === null ||
      Object.keys(rawAliases).length > CODEX_MAX_ALIASES
    ) {
      return empty();
    }
    const aliases: Record<string, PressureEntry> = {};
    for (const [alias, raw] of Object.entries(rawAliases).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    )) {
      const parsed = parsePressureEntry(raw);
      if (!isCodexAccountAlias(alias) || parsed === null) return empty();
      aliases[alias] = parsed;
    }
    return {
      schema_version: CODEX_PRESSURE_LEDGER_SCHEMA_VERSION,
      provider: CODEX_PROVIDER,
      config_binding: configBinding,
      aliases,
    };
  } catch {
    return empty();
  }
}

function activeFailureCooldownUntil(value: number, nowMs: number): number {
  return value > nowMs && value <= nowMs + CODEX_FAILURE_COOLDOWN_MS
    ? value
    : 0;
}

function prunePressureLedger(
  ledger: PressureLedger,
  observation: CodexCapacityObservation,
  quotaScope: CodexQuotaScope,
  nowMs: number,
): { ledger: PressureLedger; recovered: Set<string> } {
  const aliases: Record<string, PressureEntry> = {};
  const recovered = new Set<string>();
  const cutoff = nowMs - CODEX_PRESSURE_TTL_MS;
  for (const observed of observation.aliases) {
    const current = ledger.aliases[observed.alias];
    if (!current) continue;
    if (
      (current.shared_cooldown_until_ms > 0 &&
        current.shared_cooldown_until_ms <= nowMs) ||
      (current.quota_cooldown_until_ms[quotaScope] > 0 &&
        current.quota_cooldown_until_ms[quotaScope] <= nowMs)
    ) {
      recovered.add(observed.alias);
    }
    aliases[observed.alias] = {
      reservations: current.reservations
        .filter((entry) => entry > cutoff && entry <= nowMs)
        .sort((left, right) => left - right)
        .slice(-CODEX_MAX_RESERVATIONS_PER_ALIAS),
      shared_cooldown_until_ms: activeFailureCooldownUntil(
        current.shared_cooldown_until_ms,
        nowMs,
      ),
      quota_cooldown_until_ms: {
        [CODEX_GENERIC_QUOTA_SCOPE]: activeFailureCooldownUntil(
          current.quota_cooldown_until_ms[CODEX_GENERIC_QUOTA_SCOPE],
          nowMs,
        ),
        [CODEX_SPARK_QUOTA_SCOPE]: activeFailureCooldownUntil(
          current.quota_cooldown_until_ms[CODEX_SPARK_QUOTA_SCOPE],
          nowMs,
        ),
      },
      last_selected_at_ms:
        current.last_selected_at_ms !== null &&
        current.last_selected_at_ms <= nowMs
          ? current.last_selected_at_ms
          : null,
    };
  }
  return {
    ledger: {
      schema_version: CODEX_PRESSURE_LEDGER_SCHEMA_VERSION,
      provider: CODEX_PROVIDER,
      config_binding: observation.config_binding,
      aliases,
    },
    recovered,
  };
}

function authorizedAliasSet(
  aliases: readonly string[] | undefined,
): Set<string> | null {
  if (aliases === undefined) return null;
  const authorized = new Set<string>();
  for (const alias of aliases) {
    if (isCodexAccountAlias(alias)) authorized.add(alias);
  }
  return authorized;
}

function aliasAuthorized(
  alias: string,
  authorized: Set<string> | null,
): boolean {
  return authorized === null || authorized.has(alias);
}

function entryFor(ledger: PressureLedger, alias: string): PressureEntry {
  return ledger.aliases[alias] ?? emptyEntry();
}

function buildCandidate(
  alias: CodexCapacityAlias,
  quotaScope: CodexQuotaScope,
  ledger: PressureLedger,
  authorizedAliases: Set<string> | null,
  nowMs: number,
): ScoredCodexCandidate {
  const view = codexScopedAliasCapacityView(alias, quotaScope, nowMs);
  const entry = entryFor(ledger, alias.alias);
  const authorized = aliasAuthorized(alias.alias, authorizedAliases);
  return {
    alias,
    view,
    entry,
    authorized,
    eligible:
      authorized &&
      isCodexAliasFresh(alias, nowMs) &&
      view.status === "healthy" &&
      view.used_percent < 100 &&
      view.cooldown_until_ms <= nowMs &&
      entry.shared_cooldown_until_ms <= nowMs &&
      entry.quota_cooldown_until_ms[quotaScope] <= nowMs,
  };
}

function compareCandidates(
  left: ScoredCodexCandidate,
  right: ScoredCodexCandidate,
): number {
  const leftScore =
    left.view.used_percent +
    left.entry.reservations.length * CODEX_PRESSURE_PERCENT_STEP;
  const rightScore =
    right.view.used_percent +
    right.entry.reservations.length * CODEX_PRESSURE_PERCENT_STEP;
  if (leftScore !== rightScore) return leftScore - rightScore;
  const leftLast = left.entry.last_selected_at_ms ?? Number.NEGATIVE_INFINITY;
  const rightLast = right.entry.last_selected_at_ms ?? Number.NEGATIVE_INFINITY;
  if (leftLast !== rightLast) return leftLast - rightLast;
  return left.alias.alias < right.alias.alias
    ? -1
    : left.alias.alias > right.alias.alias
      ? 1
      : 0;
}

function serializableEntry(entry: PressureEntry): PressureEntry {
  return {
    reservations: entry.reservations
      .filter((value) => Number.isSafeInteger(value) && value >= 0)
      .sort((left, right) => left - right)
      .slice(-CODEX_MAX_RESERVATIONS_PER_ALIAS),
    shared_cooldown_until_ms: entry.shared_cooldown_until_ms,
    quota_cooldown_until_ms: {
      [CODEX_GENERIC_QUOTA_SCOPE]:
        entry.quota_cooldown_until_ms[CODEX_GENERIC_QUOTA_SCOPE],
      [CODEX_SPARK_QUOTA_SCOPE]:
        entry.quota_cooldown_until_ms[CODEX_SPARK_QUOTA_SCOPE],
    },
    last_selected_at_ms: entry.last_selected_at_ms,
  };
}

function writePressureLedger(stateDir: string, ledger: PressureLedger): void {
  const path = codexPressureLedgerPath(stateDir);
  const aliases = Object.fromEntries(
    Object.entries(ledger.aliases)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([alias, entry]) => [alias, serializableEntry(entry)]),
  );
  const content = `${JSON.stringify({ ...ledger, aliases }, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > CODEX_MAX_OBSERVATION_BYTES) {
    throw new Error("Codex pressure ledger exceeds size limit");
  }
  const temporary = join(
    stateDir,
    `.pressure.json.${process.pid}.${crypto.randomUUID()}.tmp`,
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

function readFreshObservation(
  stateDir: string,
  nowMs: number,
  maxAgeMs: number,
):
  | { observation: CodexCapacityObservation; failure: null }
  | {
      observation: CodexCapacityObservation | null;
      failure: CodexNativeFallbackReason;
    } {
  const observation = readCodexObservationSidecar(
    codexObservationSidecarPath(stateDir),
  );
  if (observation === null) {
    return { observation: null, failure: "observation-missing" };
  }
  if (!isCodexObservationFresh(observation, nowMs, maxAgeMs)) {
    return { observation, failure: "observation-stale" };
  }
  return { observation, failure: null };
}

export function selectCodexRoute(
  deps: SelectCodexRouteDeps = {},
): CodexRouteVerdict {
  const stateDir = deps.stateDir ?? resolveCodexAccountRoutingRoot();
  const nowMs = deps.nowMs ?? Date.now();
  const maxAgeMs =
    deps.maxObservationAgeMs ?? CODEX_OBSERVATION_FRESHNESS_CEILING_MS;
  const quotaScope = quotaScopeFor(deps.quotaScope);
  const authorizedAliases = authorizedAliasSet(deps.authorizedAliases);
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const lock = (deps.tryAcquireLock ?? realTryAcquireLock)(
      codexPressureLedgerLockPath(stateDir),
    );
    if (lock === null) return fallback("pressure-contended");
    try {
      const current = readFreshObservation(stateDir, nowMs, maxAgeMs);
      if (current.failure !== null) return fallback(current.failure);
      const observation = current.observation;
      const pruned = prunePressureLedger(
        loadPressureLedger(stateDir, observation.config_binding),
        observation,
        quotaScope,
        nowMs,
      );
      const eligible = observation.aliases
        .map((alias) =>
          buildCandidate(
            alias,
            quotaScope,
            pruned.ledger,
            authorizedAliases,
            nowMs,
          ),
        )
        .filter((candidate) => candidate.eligible);
      if (eligible.length === 0) return fallback("pool-unavailable");
      const selected = [...eligible].sort(compareCandidates)[0];
      const entry = entryFor(pruned.ledger, selected.alias.alias);
      entry.reservations = [...entry.reservations, nowMs]
        .sort((left, right) => left - right)
        .slice(-CODEX_MAX_RESERVATIONS_PER_ALIAS);
      entry.last_selected_at_ms = nowMs;
      pruned.ledger.aliases[selected.alias.alias] = entry;
      writePressureLedger(stateDir, pruned.ledger);
      return {
        kind: "pooled",
        provider: CODEX_PROVIDER,
        alias: selected.alias.alias,
        reason: pruned.recovered.has(selected.alias.alias)
          ? "cooldown-recovered"
          : eligible.length === 1
            ? "sole-candidate"
            : "selected",
      };
    } finally {
      lock.release();
    }
  } catch {
    return fallback("routing-error");
  }
}

export const selectCodexAccount = selectCodexRoute;

export function recordCodexRouteOutcome(
  deps: RecordCodexRouteOutcomeDeps,
): boolean {
  if (!isCodexAccountAlias(deps.alias)) return false;
  const quotaScope = quotaScopeFor(deps.quotaScope);
  const authorizedAliases = authorizedAliasSet(deps.authorizedAliases);
  if (!aliasAuthorized(deps.alias, authorizedAliases)) return false;
  const stateDir = deps.stateDir ?? resolveCodexAccountRoutingRoot();
  const nowMs = deps.nowMs ?? Date.now();
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const lock = (deps.tryAcquireLock ?? realTryAcquireLock)(
      codexPressureLedgerLockPath(stateDir),
    );
    if (lock === null) return false;
    try {
      const observation = readCodexObservationSidecar(
        codexObservationSidecarPath(stateDir),
      );
      if (
        observation === null ||
        !observation.aliases.some((alias) => alias.alias === deps.alias)
      ) {
        return false;
      }
      const pruned = prunePressureLedger(
        loadPressureLedger(stateDir, observation.config_binding),
        observation,
        quotaScope,
        nowMs,
      ).ledger;
      const entry = entryFor(pruned, deps.alias);
      entry.reservations = entry.reservations.slice(1);
      if (deps.outcome === "quota") {
        entry.quota_cooldown_until_ms[quotaScope] =
          nowMs + CODEX_FAILURE_COOLDOWN_MS;
      } else if (deps.outcome !== "success") {
        entry.shared_cooldown_until_ms = nowMs + CODEX_FAILURE_COOLDOWN_MS;
      }
      pruned.aliases[deps.alias] = entry;
      writePressureLedger(stateDir, pruned);
      return true;
    } finally {
      lock.release();
    }
  } catch {
    return false;
  }
}

function inspectCandidate(
  candidate: ScoredCodexCandidate,
): CodexRoutingCandidate {
  const quotaCooldown =
    candidate.entry.quota_cooldown_until_ms[candidate.view.quota_scope];
  return {
    alias: candidate.alias.alias,
    quota_scope: candidate.view.quota_scope,
    used_percent: candidate.view.used_percent,
    worst_used_percent: candidate.view.used_percent,
    pressure: candidate.entry.reservations.length,
    cooldown_until_ms: Math.max(
      candidate.view.cooldown_until_ms,
      candidate.entry.shared_cooldown_until_ms,
      quotaCooldown,
    ),
    shared_cooldown_until_ms: candidate.entry.shared_cooldown_until_ms,
    quota_cooldown_until_ms: quotaCooldown,
    capacity_cooldown_until_ms: candidate.view.cooldown_until_ms,
    authorized: candidate.authorized,
    eligible: candidate.eligible,
  };
}

export function inspectCodexRouting(
  deps: Omit<SelectCodexRouteDeps, "tryAcquireLock"> = {},
): CodexRoutingInspection {
  const stateDir = deps.stateDir ?? resolveCodexAccountRoutingRoot();
  const nowMs = deps.nowMs ?? Date.now();
  const maxAgeMs =
    deps.maxObservationAgeMs ?? CODEX_OBSERVATION_FRESHNESS_CEILING_MS;
  const quotaScope = quotaScopeFor(deps.quotaScope);
  const authorizedAliases = authorizedAliasSet(deps.authorizedAliases);
  try {
    const current = readFreshObservation(stateDir, nowMs, maxAgeMs);
    if (current.failure !== null) {
      return {
        provider: CODEX_PROVIDER,
        health: current.failure === "observation-missing" ? "missing" : "stale",
        config_binding: current.observation?.config_binding ?? null,
        observed_at_ms: current.observation?.observed_at_ms ?? null,
        fresh: false,
        quota_scope: quotaScope,
        verdict: fallback(current.failure),
        candidates: [],
      };
    }
    const observation = current.observation;
    const pruned = prunePressureLedger(
      loadPressureLedger(stateDir, observation.config_binding),
      observation,
      quotaScope,
      nowMs,
    ).ledger;
    const scored =
      authorizedAliases !== null && authorizedAliases.size === 0
        ? []
        : observation.aliases.map((alias) =>
            buildCandidate(alias, quotaScope, pruned, authorizedAliases, nowMs),
          );
    const candidates = scored.map(inspectCandidate);
    const available = scored.filter((candidate) => candidate.eligible);
    let verdict: CodexRouteVerdict;
    if (available.length === 0) {
      verdict = fallback("pool-unavailable");
    } else {
      const selected = [...available].sort(compareCandidates)[0];
      verdict = {
        kind: "pooled",
        provider: CODEX_PROVIDER,
        alias: selected.alias.alias,
        reason: available.length === 1 ? "sole-candidate" : "selected",
      };
    }
    return {
      provider: CODEX_PROVIDER,
      health: available.length > 0 ? "ready" : "unavailable",
      config_binding: observation.config_binding,
      observed_at_ms: observation.observed_at_ms,
      fresh: true,
      quota_scope: quotaScope,
      verdict,
      candidates,
    };
  } catch {
    return {
      provider: CODEX_PROVIDER,
      health: "unavailable",
      config_binding: null,
      observed_at_ms: null,
      fresh: false,
      quota_scope: quotaScope,
      verdict: fallback("routing-error"),
      candidates: [],
    };
  }
}
