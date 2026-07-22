import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ACCOUNT_ALIASES,
  isOpaqueAlias,
  normalizeAliases,
  writePrivateJsonAtomic,
} from "../integrations/pi-codex-pool/src/auth.ts";
import {
  aliasRoleBinding,
  classifyLiveProof,
  type ExpectedProofBindings,
  type LiveProofReport,
  QUOTA_WAIVABLE_CLAUSES,
  reportDegradedVerdict,
  reportQuotaScope,
  reportSupportedAliases,
} from "../integrations/pi-codex-pool/src/proof.ts";
import {
  type PoolAliasPolicy,
  poolAliasPolicyBinding,
  poolConfigBinding,
} from "../integrations/pi-codex-pool/src/state.ts";

export { poolAliasPolicyBinding };

import type { CodexRoutingInspection } from "./codex-account-router.ts";
import {
  CODEX_POOL_WORKFLOW_SCHEMA_VERSION,
  exactKeys,
  record,
} from "./codex-pool-proof-window.ts";
import {
  CODEX_GENERIC_QUOTA_SCOPE,
  CODEX_QUOTA_SCOPES,
  CODEX_SPARK_QUOTA_SCOPE,
  type CodexQuotaScope,
  isCodexQuotaScope,
} from "./codex-quota-scope.ts";
import { FileLock } from "./file-lock.ts";

export {
  armCodexPoolProofWindow,
  CODEX_POOL_PROOF_WINDOW_DURATION_MS,
  CODEX_POOL_PROOF_WINDOW_ENV,
  CODEX_POOL_WORKFLOW_SCHEMA_VERSION,
  type CodexPoolProofWindowState,
  codexPoolProofWindowActive,
} from "./codex-pool-proof-window.ts";

export const CODEX_POOL_MAX_REPORT_BYTES = 256 * 1024;
export const CODEX_POOL_MAX_STATE_BYTES = 32 * 1024;

export type CodexPoolActivationMode =
  | "native"
  | "active"
  | "active-degraded"
  | "active-scoped"
  | "recovery-required";

export const CODEX_POOL_DEGRADED_VERDICT = "proven-degraded-single-alias";

/**
 * The pin an `active-degraded` activation records: the classified quota cause,
 * the exact clauses the proof waived, and the single healthy alias routing is
 * pinned to while the other alias is quota-dead.
 */
export interface CodexPoolDegradedMarker {
  cause: "quota";
  waived_clauses: string[];
  pinned_alias: string;
}

/**
 * Explicit operator authorization naming the degraded verdict. Activation admits
 * a `proven-degraded-single-alias` report ONLY when this is present; absent it,
 * a degraded report is refused rather than silently activated.
 */
export interface CodexPoolActivationAuthorization {
  degraded_verdict: typeof CODEX_POOL_DEGRADED_VERDICT;
}

export interface CodexPoolScopedMarker {
  proof_scope: CodexQuotaScope;
  authorized_aliases: PoolAliasPolicy;
}

export interface CodexPoolBindings {
  revision: string;
  aliases: string[];
  alias_roles: Array<{
    alias: string;
    role: "primary" | "alternate";
  }>;
  config_binding: string;
  alias_binding: string;
}

export interface CodexPoolActivationState {
  schema_version: 1;
  mode: CodexPoolActivationMode;
  revision: string;
  config_binding: string;
  alias_binding: string;
  aliases: string[];
  degraded: CodexPoolDegradedMarker | null;
  scoped?: CodexPoolScopedMarker | null;
  updated_at_ms: number;
}

export interface CodexPoolWorkflowPaths {
  root: string;
  activation: string;
  report: string;
  transaction: string;
  lock: string;
}

export type CodexPoolProblemCode =
  | "activation-pending"
  | "activation-busy"
  | "activation-config-invalid"
  | "activation-binding-stale"
  | "companion-missing"
  | "companion-incompatible"
  | "observation-missing"
  | "observation-stale"
  | "pool-unavailable"
  | "pressure-contended"
  | "routing-error"
  | "proof-missing"
  | "proof-invalid"
  | "proof-incomplete"
  | "proof-failed"
  | "proof-degraded-unauthorized"
  | "verification-failed"
  | "rollback-complete"
  | "recovery-required";

export interface CodexPoolWorkflowResult {
  schema_version: 1;
  ok: boolean;
  operation:
    | "status"
    | "proof-capture"
    | "proof-verdict"
    | "activate"
    | "verify"
    | "rollback"
    | "recover";
  state: CodexPoolActivationMode;
  problem_code: CodexPoolProblemCode | null;
  proof: {
    verdict:
      | "proven"
      | "incomplete"
      | "failed"
      | "proven-degraded-single-alias";
    reasons: string[];
  } | null;
}

export interface CodexPoolActivationStore {
  readActivation(): unknown | undefined;
  writeActivation(state: CodexPoolActivationState): void;
  readReport(source?: string): unknown | undefined;
  writeReport(report: LiveProofReport): void;
  transactionExists(): boolean;
  beginTransaction(): void;
  endTransaction(): void;
  tryLock(): { release(): void } | null;
}

export interface CodexPoolActivationDeps {
  store: CodexPoolActivationStore;
  bindings: CodexPoolBindings;
  nowMs: () => number;
  reload: (candidate: CodexPoolActivationState) => boolean;
  verify: (candidate: CodexPoolActivationState) => boolean;
}

function isBinding(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{7,64}$/.test(value);
}

function parseCodexPoolDegradedMarker(
  value: unknown,
  aliases: readonly string[],
): CodexPoolDegradedMarker | null {
  const marker = record(value);
  if (marker === null) return null;
  const waived = marker.waived_clauses;
  if (
    !exactKeys(marker, ["cause", "waived_clauses", "pinned_alias"]) ||
    marker.cause !== "quota" ||
    typeof marker.pinned_alias !== "string" ||
    !isOpaqueAlias(marker.pinned_alias) ||
    !aliases.includes(marker.pinned_alias) ||
    !Array.isArray(waived) ||
    waived.length === 0 ||
    waived.length > QUOTA_WAIVABLE_CLAUSES.length ||
    new Set(waived).size !== waived.length ||
    waived.some(
      (clause) =>
        !(QUOTA_WAIVABLE_CLAUSES as readonly string[]).includes(String(clause)),
    )
  ) {
    return null;
  }
  return {
    cause: "quota",
    waived_clauses: waived.map(String),
    pinned_alias: marker.pinned_alias,
  };
}

function emptyCodexPoolAliasPolicy(): PoolAliasPolicy {
  return {
    [CODEX_GENERIC_QUOTA_SCOPE]: [],
    [CODEX_SPARK_QUOTA_SCOPE]: [],
  };
}

function parseScopedAliasList(
  value: unknown,
  aliases: readonly string[],
): string[] | null {
  if (!Array.isArray(value) || value.length > aliases.length) return null;
  const enrolled = new Set(aliases);
  const selected = new Set<string>();
  for (const alias of value) {
    if (!isOpaqueAlias(alias) || !enrolled.has(alias) || selected.has(alias)) {
      return null;
    }
    selected.add(alias);
  }
  return aliases.filter((alias) => selected.has(alias));
}

function parseCodexPoolScopedMarker(
  value: unknown,
  aliases: readonly string[],
): CodexPoolScopedMarker | null {
  const marker = record(value);
  if (marker === null) return null;
  const policy = record(marker.authorized_aliases);
  if (
    !exactKeys(marker, ["proof_scope", "authorized_aliases"]) ||
    !isCodexQuotaScope(marker.proof_scope) ||
    policy === null ||
    !exactKeys(policy, [...CODEX_QUOTA_SCOPES])
  ) {
    return null;
  }
  const authorized = emptyCodexPoolAliasPolicy();
  for (const scope of CODEX_QUOTA_SCOPES) {
    const parsed = parseScopedAliasList(policy[scope], aliases);
    if (parsed === null) return null;
    authorized[scope] = parsed;
  }
  if (
    authorized[marker.proof_scope].length === 0 ||
    authorized[CODEX_SPARK_QUOTA_SCOPE].length === 0
  ) {
    return null;
  }
  return {
    proof_scope: marker.proof_scope,
    authorized_aliases: authorized,
  };
}

export function parseCodexPoolActivationState(
  value: unknown,
): CodexPoolActivationState | null {
  const input = record(value);
  if (input === null) return null;
  const hasDegraded = "degraded" in input;
  const hasScoped = "scoped" in input;
  const allowedKeys = [
    "schema_version",
    "mode",
    "revision",
    "config_binding",
    "alias_binding",
    "aliases",
    "updated_at_ms",
  ];
  const expectedKeys = [
    ...allowedKeys,
    ...(hasDegraded ? ["degraded"] : []),
    ...(hasScoped ? ["scoped"] : []),
  ];
  if (
    !exactKeys(input, expectedKeys) ||
    input.schema_version !== CODEX_POOL_WORKFLOW_SCHEMA_VERSION ||
    ![
      "native",
      "active",
      "active-degraded",
      "active-scoped",
      "recovery-required",
    ].includes(String(input.mode)) ||
    !isRevision(input.revision) ||
    !isBinding(input.config_binding) ||
    !isBinding(input.alias_binding) ||
    !Number.isSafeInteger(input.updated_at_ms) ||
    (input.updated_at_ms as number) < 0
  ) {
    return null;
  }
  let aliases: string[];
  try {
    aliases = normalizeAliases(input.aliases);
  } catch {
    return null;
  }
  const rawDegraded = hasDegraded ? input.degraded : null;
  const rawScoped = hasScoped ? input.scoped : null;
  let degraded: CodexPoolDegradedMarker | null = null;
  if (input.mode === "active-degraded") {
    degraded = parseCodexPoolDegradedMarker(rawDegraded, aliases);
    if (degraded === null) return null;
  } else if (rawDegraded !== null && rawDegraded !== undefined) {
    return null;
  }
  let scoped: CodexPoolScopedMarker | null = null;
  if (input.mode === "active-scoped") {
    scoped = parseCodexPoolScopedMarker(rawScoped, aliases);
    if (scoped === null) return null;
  } else if (rawScoped !== null && rawScoped !== undefined) {
    return null;
  }
  const state: CodexPoolActivationState = {
    schema_version: CODEX_POOL_WORKFLOW_SCHEMA_VERSION,
    mode: input.mode as CodexPoolActivationMode,
    revision: input.revision,
    config_binding: input.config_binding,
    alias_binding: input.alias_binding,
    aliases,
    degraded,
    updated_at_ms: input.updated_at_ms as number,
  };
  if (scoped !== null) state.scoped = scoped;
  return state;
}

export function codexPoolAliasesFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.KEEPER_PI_CODEX_POOL_ALIASES?.trim();
  if (!raw) return [...DEFAULT_ACCOUNT_ALIASES];
  try {
    return normalizeAliases(JSON.parse(raw) as unknown);
  } catch {
    throw new Error("codex-pool-alias-config-invalid");
  }
}

export function codexPoolBindings(
  revision: string,
  aliases: readonly string[] = DEFAULT_ACCOUNT_ALIASES,
): CodexPoolBindings {
  if (!isRevision(revision)) throw new Error("codex-pool-revision-invalid");
  const normalized = normalizeAliases([...aliases]);
  const aliasRoles = normalized.map((alias, index) => ({
    alias,
    role: index === 0 ? ("primary" as const) : ("alternate" as const),
  }));
  return {
    revision,
    aliases: normalized,
    alias_roles: aliasRoles,
    config_binding: poolConfigBinding(normalized),
    alias_binding: aliasRoleBinding(aliasRoles),
  };
}

export function resolveCodexPoolWorkflowPaths(
  env: NodeJS.ProcessEnv = process.env,
): CodexPoolWorkflowPaths {
  const configured = env.KEEPER_PI_CODEX_POOL_CONFIG_ROOT?.trim();
  const root = configured || join(homedir(), ".config", "keeper", "codex-pool");
  return {
    root,
    activation: join(root, "activation.json"),
    report: join(root, "live-proof.json"),
    transaction: join(root, "activation.transaction.json"),
    lock: join(root, "activation.lock"),
  };
}

function boundedJsonFile(path: string, maxBytes: number): unknown | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export class FileCodexPoolActivationStore implements CodexPoolActivationStore {
  constructor(readonly paths = resolveCodexPoolWorkflowPaths()) {}

  readActivation(): unknown | undefined {
    return boundedJsonFile(this.paths.activation, CODEX_POOL_MAX_STATE_BYTES);
  }

  writeActivation(state: CodexPoolActivationState): void {
    writePrivateJsonAtomic(this.paths.activation, state);
  }

  readReport(source = this.paths.report): unknown | undefined {
    return boundedJsonFile(source, CODEX_POOL_MAX_REPORT_BYTES);
  }

  writeReport(report: LiveProofReport): void {
    writePrivateJsonAtomic(this.paths.report, report);
  }

  transactionExists(): boolean {
    return existsSync(this.paths.transaction);
  }

  beginTransaction(): void {
    writePrivateJsonAtomic(this.paths.transaction, {
      schema_version: CODEX_POOL_WORKFLOW_SCHEMA_VERSION,
      state: "native",
    });
  }

  endTransaction(): void {
    rmSync(this.paths.transaction, { force: true });
  }

  tryLock(): { release(): void } | null {
    mkdirSync(dirname(this.paths.lock), { recursive: true, mode: 0o700 });
    return FileLock.tryAcquire(this.paths.lock);
  }
}

export function resolveKeeperRevision(repoRoot?: string): string {
  const root =
    repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 1024,
  });
  const revision = result.status === 0 ? result.stdout.trim() : "";
  if (!isRevision(revision)) throw new Error("codex-pool-revision-unavailable");
  return revision;
}

function stateFor(
  mode: CodexPoolActivationMode,
  bindings: CodexPoolBindings,
  nowMs: number,
  degraded: CodexPoolDegradedMarker | null = null,
  scoped: CodexPoolScopedMarker | null = null,
): CodexPoolActivationState {
  const state: CodexPoolActivationState = {
    schema_version: CODEX_POOL_WORKFLOW_SCHEMA_VERSION,
    mode,
    revision: bindings.revision,
    config_binding: bindings.config_binding,
    alias_binding: bindings.alias_binding,
    aliases: [...bindings.aliases],
    degraded,
    updated_at_ms: Math.floor(nowMs),
  };
  if (scoped !== null) state.scoped = scoped;
  return state;
}

function canonicalPolicy(
  policy: PoolAliasPolicy,
  aliases: readonly string[],
): PoolAliasPolicy {
  const canonical = emptyCodexPoolAliasPolicy();
  for (const scope of CODEX_QUOTA_SCOPES) {
    const selected = new Set(policy[scope]);
    canonical[scope] = aliases.filter((alias) => selected.has(alias));
  }
  return canonical;
}

function sameAliasList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameAliasPolicy(
  left: PoolAliasPolicy,
  right: PoolAliasPolicy,
): boolean {
  return CODEX_QUOTA_SCOPES.every((scope) =>
    sameAliasList(left[scope], right[scope]),
  );
}

function policyIncludesSpark(policy: PoolAliasPolicy): boolean {
  return policy[CODEX_SPARK_QUOTA_SCOPE].length > 0;
}

function policyAuthorizesAllGeneric(
  policy: PoolAliasPolicy,
  aliases: readonly string[],
): boolean {
  return sameAliasList(policy[CODEX_GENERIC_QUOTA_SCOPE], aliases);
}

export function codexPoolAliasPolicyForActivation(
  state: CodexPoolActivationState,
): PoolAliasPolicy {
  if (state.mode === "active") {
    return {
      [CODEX_GENERIC_QUOTA_SCOPE]: [...state.aliases],
      [CODEX_SPARK_QUOTA_SCOPE]: [],
    };
  }
  if (state.mode === "active-degraded" && state.degraded !== null) {
    return {
      [CODEX_GENERIC_QUOTA_SCOPE]: [state.degraded.pinned_alias],
      [CODEX_SPARK_QUOTA_SCOPE]: [],
    };
  }
  if (state.mode === "active-scoped" && state.scoped != null) {
    return canonicalPolicy(state.scoped.authorized_aliases, state.aliases);
  }
  return emptyCodexPoolAliasPolicy();
}

export function codexPoolVerificationScopeForActivation(
  state: CodexPoolActivationState,
): CodexQuotaScope | null {
  if (state.mode === "active") return CODEX_GENERIC_QUOTA_SCOPE;
  if (state.mode === "active-degraded" && state.degraded !== null) {
    return CODEX_GENERIC_QUOTA_SCOPE;
  }
  if (state.mode === "active-scoped" && state.scoped != null) {
    return state.scoped.proof_scope;
  }
  return null;
}

function matchesBindings(
  state: CodexPoolActivationState,
  bindings: CodexPoolBindings,
): boolean {
  return (
    state.revision === bindings.revision &&
    matchesOperationalBindings(state, bindings)
  );
}

// Route-time reads compare only the operational identity the proof attests
// (pool config, alias roles, alias list). The stored revision is provenance,
// re-pinned by each activation — comparing it live would flip the pool to
// native on every repo commit, and the plan ledger commits continuously.
function matchesOperationalBindings(
  state: CodexPoolActivationState,
  bindings: CodexPoolBindings,
): boolean {
  return (
    state.config_binding === bindings.config_binding &&
    state.alias_binding === bindings.alias_binding &&
    JSON.stringify(state.aliases) === JSON.stringify(bindings.aliases)
  );
}

function expectedProof(
  bindings: CodexPoolBindings,
  nowMs: number,
): ExpectedProofBindings {
  return {
    revision: bindings.revision,
    config_binding: bindings.config_binding,
    alias_binding: bindings.alias_binding,
    now_ms: nowMs,
  };
}

function proofResult(
  input: unknown | undefined,
  bindings: CodexPoolBindings,
  nowMs: number,
): CodexPoolWorkflowResult["proof"] {
  if (input === undefined) return null;
  const classified = classifyLiveProof(input, expectedProof(bindings, nowMs));
  return {
    verdict: classified.verdict,
    reasons: [...classified.reasons],
  };
}

function result(
  operation: CodexPoolWorkflowResult["operation"],
  ok: boolean,
  state: CodexPoolActivationMode,
  problemCode: CodexPoolProblemCode | null,
  proof: CodexPoolWorkflowResult["proof"] = null,
): CodexPoolWorkflowResult {
  return {
    schema_version: CODEX_POOL_WORKFLOW_SCHEMA_VERSION,
    ok,
    operation,
    state,
    problem_code: problemCode,
    proof,
  };
}

export function effectiveCodexPoolActivation(
  store: Pick<CodexPoolActivationStore, "readActivation" | "transactionExists">,
  bindings: CodexPoolBindings,
): {
  mode: "native" | "active" | "active-degraded" | "active-scoped";
  problem_code: CodexPoolProblemCode | null;
  state: CodexPoolActivationState | null;
} {
  if (store.transactionExists()) {
    return {
      mode: "native",
      problem_code: "recovery-required",
      state: parseCodexPoolActivationState(store.readActivation()),
    };
  }
  const raw = store.readActivation();
  if (raw === undefined) {
    return { mode: "native", problem_code: "activation-pending", state: null };
  }
  const state = parseCodexPoolActivationState(raw);
  if (state === null) {
    return {
      mode: "native",
      problem_code: "activation-config-invalid",
      state: null,
    };
  }
  if (!matchesOperationalBindings(state, bindings)) {
    return {
      mode: "native",
      problem_code: "activation-binding-stale",
      state,
    };
  }
  if (state.mode === "active") {
    return { mode: "active", problem_code: null, state };
  }
  if (state.mode === "active-degraded" && state.degraded !== null) {
    return { mode: "active-degraded", problem_code: null, state };
  }
  if (state.mode === "active-scoped" && state.scoped != null) {
    return { mode: "active-scoped", problem_code: null, state };
  }
  return {
    mode: "native",
    problem_code:
      state.mode === "recovery-required"
        ? "recovery-required"
        : "activation-pending",
    state,
  };
}

export function codexPoolStatus(
  deps: CodexPoolActivationDeps,
): CodexPoolWorkflowResult {
  const effective = effectiveCodexPoolActivation(deps.store, deps.bindings);
  const proof = proofResult(
    deps.store.readReport(),
    deps.bindings,
    deps.nowMs(),
  );
  let healthy = false;
  if (
    (effective.mode === "active" ||
      effective.mode === "active-degraded" ||
      effective.mode === "active-scoped") &&
    effective.state !== null
  ) {
    try {
      healthy = deps.verify(effective.state);
    } catch {
      healthy = false;
    }
  }
  return result(
    "status",
    healthy,
    healthy ? effective.mode : "native",
    healthy ? null : (effective.problem_code ?? "verification-failed"),
    proof,
  );
}

export function captureCodexPoolProof(
  deps: Pick<CodexPoolActivationDeps, "store" | "bindings" | "nowMs">,
  source: string,
): CodexPoolWorkflowResult {
  const input = deps.store.readReport(source);
  const proof = proofResult(input, deps.bindings, deps.nowMs());
  if (proof === null) {
    return result("proof-capture", false, "native", "proof-missing");
  }
  const unsafeReasons = new Set([
    "schema-invalid",
    "unknown-field",
    "artifact-scan-error",
    "sanitation-finding",
  ]);
  if (proof.reasons.some((reason) => unsafeReasons.has(reason))) {
    return result("proof-capture", false, "native", "proof-invalid", proof);
  }
  deps.store.writeReport(input as LiveProofReport);
  return result(
    "proof-capture",
    true,
    "native",
    proof.verdict === "proven" ? null : "proof-incomplete",
    proof,
  );
}

export function verdictCodexPoolProof(
  deps: Pick<CodexPoolActivationDeps, "store" | "bindings" | "nowMs">,
  source?: string,
): CodexPoolWorkflowResult {
  const proof = proofResult(
    deps.store.readReport(source),
    deps.bindings,
    deps.nowMs(),
  );
  if (proof === null) {
    return result("proof-verdict", false, "native", "proof-missing");
  }
  return result(
    "proof-verdict",
    proof.verdict === "proven",
    "native",
    proof.verdict === "proven"
      ? null
      : proof.verdict === "incomplete"
        ? "proof-incomplete"
        : "proof-failed",
    proof,
  );
}

function rollbackAfterFailure(
  deps: CodexPoolActivationDeps,
  operation: "activate" | "rollback" | "recover",
): CodexPoolWorkflowResult {
  try {
    deps.store.writeActivation(stateFor("native", deps.bindings, deps.nowMs()));
    deps.store.endTransaction();
    return result(
      operation,
      operation !== "activate",
      "native",
      operation === "activate" ? "rollback-complete" : null,
    );
  } catch {
    return result(operation, false, "recovery-required", "recovery-required");
  }
}

function currentlyAuthorizedAliasPolicy(
  store: Pick<CodexPoolActivationStore, "readActivation" | "transactionExists">,
  bindings: CodexPoolBindings,
): PoolAliasPolicy {
  const effective = effectiveCodexPoolActivation(store, bindings);
  return effective.problem_code === null && effective.state !== null
    ? codexPoolAliasPolicyForActivation(effective.state)
    : emptyCodexPoolAliasPolicy();
}

function stateForAliasPolicy(
  bindings: CodexPoolBindings,
  nowMs: number,
  proofScope: CodexQuotaScope,
  policy: PoolAliasPolicy,
  degraded: CodexPoolDegradedMarker | null,
): CodexPoolActivationState | null {
  const authorized = canonicalPolicy(policy, bindings.aliases);
  if (policyIncludesSpark(authorized)) {
    return stateFor("active-scoped", bindings, nowMs, null, {
      proof_scope: proofScope,
      authorized_aliases: authorized,
    });
  }
  if (
    degraded !== null &&
    sameAliasList(authorized[CODEX_GENERIC_QUOTA_SCOPE], [
      degraded.pinned_alias,
    ])
  ) {
    return stateFor("active-degraded", bindings, nowMs, degraded);
  }
  if (policyAuthorizesAllGeneric(authorized, bindings.aliases)) {
    return stateFor("active", bindings, nowMs);
  }
  return null;
}

function activationStateMatchesCandidate(
  persisted: CodexPoolActivationState,
  candidate: CodexPoolActivationState,
  bindings: CodexPoolBindings,
): boolean {
  return (
    matchesBindings(persisted, bindings) &&
    persisted.mode === candidate.mode &&
    codexPoolVerificationScopeForActivation(persisted) ===
      codexPoolVerificationScopeForActivation(candidate) &&
    JSON.stringify(persisted.degraded) === JSON.stringify(candidate.degraded) &&
    sameAliasPolicy(
      codexPoolAliasPolicyForActivation(persisted),
      codexPoolAliasPolicyForActivation(candidate),
    )
  );
}

export function activateCodexPool(
  deps: CodexPoolActivationDeps,
  source?: string,
  authorization?: CodexPoolActivationAuthorization | null,
): CodexPoolWorkflowResult {
  const lock = deps.store.tryLock();
  if (lock === null) {
    return result("activate", false, "native", "activation-busy");
  }
  try {
    if (deps.store.transactionExists()) {
      return result("activate", false, "native", "recovery-required");
    }
    const input = deps.store.readReport(source);
    const nowMs = deps.nowMs();
    const proof = proofResult(input, deps.bindings, nowMs);
    if (proof === null) {
      return result("activate", false, "native", "proof-missing");
    }
    const proofScope = reportQuotaScope(input);
    if (proofScope === null) {
      return result("activate", false, "native", "proof-failed", proof);
    }
    // A full proven report replaces authorization for its quota scope with the
    // capability subset attested by that report. A degraded verdict replaces
    // only that scope with the explicitly authorized pin. Other effective scopes
    // are preserved only when their stored activation still matches the
    // operational bindings.
    const policy = currentlyAuthorizedAliasPolicy(deps.store, deps.bindings);
    let degraded: CodexPoolDegradedMarker | null = null;
    if (proof.verdict === "proven") {
      const supportedAliases = reportSupportedAliases(input);
      if (supportedAliases === null || supportedAliases.length === 0) {
        return result("activate", false, "native", "proof-failed", proof);
      }
      policy[proofScope] = supportedAliases;
    } else if (proof.verdict === CODEX_POOL_DEGRADED_VERDICT) {
      if (authorization?.degraded_verdict !== CODEX_POOL_DEGRADED_VERDICT) {
        return result(
          "activate",
          false,
          "native",
          "proof-degraded-unauthorized",
          proof,
        );
      }
      const degradedVerdict = reportDegradedVerdict(input);
      const pinnedAlias = degradedVerdict?.pinned_alias;
      if (
        degradedVerdict === null ||
        pinnedAlias === undefined ||
        !deps.bindings.aliases.includes(pinnedAlias)
      ) {
        return result("activate", false, "native", "proof-failed", proof);
      }
      degraded = {
        cause: degradedVerdict.cause,
        waived_clauses: [...degradedVerdict.waived_clauses],
        pinned_alias: pinnedAlias,
      };
      policy[proofScope] = [pinnedAlias];
    } else {
      return result(
        "activate",
        false,
        "native",
        proof.verdict === "incomplete" ? "proof-incomplete" : "proof-failed",
        proof,
      );
    }
    const candidate = stateForAliasPolicy(
      deps.bindings,
      nowMs,
      proofScope,
      policy,
      degraded,
    );
    if (candidate === null) {
      return result("activate", false, "native", "proof-failed", proof);
    }
    try {
      deps.store.beginTransaction();
    } catch {
      return result("activate", false, "native", "rollback-complete", proof);
    }
    if (!deps.reload(candidate)) {
      return rollbackAfterFailure(deps, "activate");
    }
    try {
      deps.store.writeActivation(candidate);
    } catch {
      return rollbackAfterFailure(deps, "activate");
    }
    const persisted = parseCodexPoolActivationState(
      deps.store.readActivation(),
    );
    if (
      persisted === null ||
      !activationStateMatchesCandidate(persisted, candidate, deps.bindings) ||
      !deps.verify(candidate)
    ) {
      return rollbackAfterFailure(deps, "activate");
    }
    deps.store.endTransaction();
    return result("activate", true, candidate.mode, null, proof);
  } catch {
    if (deps.store.transactionExists()) {
      return rollbackAfterFailure(deps, "activate");
    }
    return result("activate", false, "native", "proof-failed");
  } finally {
    lock.release();
  }
}

function resetCodexPool(
  deps: CodexPoolActivationDeps,
  operation: "rollback" | "recover",
): CodexPoolWorkflowResult {
  const lock = deps.store.tryLock();
  if (lock === null) {
    return result(operation, false, "native", "activation-busy");
  }
  try {
    if (!deps.store.transactionExists()) deps.store.beginTransaction();
    return rollbackAfterFailure(deps, operation);
  } finally {
    lock.release();
  }
}

export function rollbackCodexPool(
  deps: CodexPoolActivationDeps,
): CodexPoolWorkflowResult {
  return resetCodexPool(deps, "rollback");
}

export function recoverCodexPool(
  deps: CodexPoolActivationDeps,
): CodexPoolWorkflowResult {
  return resetCodexPool(deps, "recover");
}

export function verifyCodexPool(
  deps: CodexPoolActivationDeps,
): CodexPoolWorkflowResult {
  const effective = effectiveCodexPoolActivation(deps.store, deps.bindings);
  if (
    (effective.mode !== "active" &&
      effective.mode !== "active-degraded" &&
      effective.mode !== "active-scoped") ||
    effective.state === null
  ) {
    return result(
      "verify",
      false,
      "native",
      effective.problem_code ?? "verification-failed",
    );
  }
  let verified = false;
  try {
    verified = deps.verify(effective.state);
  } catch {
    verified = false;
  }
  return result(
    "verify",
    verified,
    verified ? effective.mode : "native",
    verified ? null : "verification-failed",
  );
}

function inspectionHasExactAuthorizedAliases(
  inspection: CodexRoutingInspection,
  enrolledAliases: readonly string[],
  authorizedAliases: readonly string[],
): boolean {
  const enrolled = new Set(enrolledAliases);
  const expected = new Set(authorizedAliases);
  if (expected.size !== authorizedAliases.length || expected.size === 0) {
    return false;
  }
  const authorized = new Set<string>();
  const supported = new Set<string>();
  for (const entry of inspection.candidates) {
    if (
      entry.quota_scope !== inspection.quota_scope ||
      !enrolled.has(entry.alias)
    ) {
      return false;
    }
    if (entry.supported) {
      if (supported.has(entry.alias)) return false;
      supported.add(entry.alias);
    }
    if (entry.authorized) {
      if (authorized.has(entry.alias)) return false;
      authorized.add(entry.alias);
    }
  }
  return (
    authorized.size === expected.size &&
    [...expected].every(
      (alias) => authorized.has(alias) && supported.has(alias),
    )
  );
}

export function codexPoolObservationVerifies(
  candidate: CodexPoolActivationState,
  inspection: CodexRoutingInspection,
  explicitVerificationScope?: CodexQuotaScope,
): boolean {
  const verificationScope =
    explicitVerificationScope ??
    codexPoolVerificationScopeForActivation(candidate);
  if (
    verificationScope === null ||
    inspection.config_binding !== candidate.config_binding ||
    inspection.quota_scope !== verificationScope ||
    inspection.health !== "ready" ||
    !inspection.fresh ||
    inspection.verdict.kind !== "pooled"
  ) {
    return false;
  }
  const policy = codexPoolAliasPolicyForActivation(candidate);
  const authorizedAliases = policy[verificationScope];
  if (
    !inspectionHasExactAuthorizedAliases(
      inspection,
      candidate.aliases,
      authorizedAliases,
    ) ||
    !authorizedAliases.includes(inspection.verdict.alias)
  ) {
    return false;
  }
  if (candidate.mode === "active") {
    return (
      verificationScope === CODEX_GENERIC_QUOTA_SCOPE &&
      authorizedAliases.length >= 2
    );
  }
  if (candidate.mode === "active-degraded") {
    return (
      verificationScope === CODEX_GENERIC_QUOTA_SCOPE &&
      authorizedAliases.length === 1 &&
      authorizedAliases[0] === candidate.degraded?.pinned_alias
    );
  }
  return candidate.mode === "active-scoped" && authorizedAliases.length > 0;
}

export function codexPoolConfigDigest(state: CodexPoolActivationState): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
