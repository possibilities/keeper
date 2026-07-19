import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ACCOUNT_ALIASES,
  normalizeAliases,
  writePrivateJsonAtomic,
} from "../integrations/pi-codex-pool/src/auth.ts";
import {
  aliasRoleBinding,
  classifyLiveProof,
  type ExpectedProofBindings,
  type LiveProofReport,
} from "../integrations/pi-codex-pool/src/proof.ts";
import { poolConfigBinding } from "../integrations/pi-codex-pool/src/state.ts";
import type { CodexRoutingInspection } from "./codex-account-router.ts";
import {
  CODEX_POOL_WORKFLOW_SCHEMA_VERSION,
  exactKeys,
  record,
} from "./codex-pool-proof-window.ts";
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

export type CodexPoolActivationMode = "native" | "active" | "recovery-required";

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
    verdict: "proven" | "incomplete" | "failed";
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

export function parseCodexPoolActivationState(
  value: unknown,
): CodexPoolActivationState | null {
  const input = record(value);
  if (
    input === null ||
    !exactKeys(input, [
      "schema_version",
      "mode",
      "revision",
      "config_binding",
      "alias_binding",
      "aliases",
      "updated_at_ms",
    ]) ||
    input.schema_version !== CODEX_POOL_WORKFLOW_SCHEMA_VERSION ||
    !["native", "active", "recovery-required"].includes(String(input.mode)) ||
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
  return {
    schema_version: CODEX_POOL_WORKFLOW_SCHEMA_VERSION,
    mode: input.mode as CodexPoolActivationMode,
    revision: input.revision,
    config_binding: input.config_binding,
    alias_binding: input.alias_binding,
    aliases,
    updated_at_ms: input.updated_at_ms as number,
  };
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
): CodexPoolActivationState {
  return {
    schema_version: CODEX_POOL_WORKFLOW_SCHEMA_VERSION,
    mode,
    revision: bindings.revision,
    config_binding: bindings.config_binding,
    alias_binding: bindings.alias_binding,
    aliases: [...bindings.aliases],
    updated_at_ms: Math.floor(nowMs),
  };
}

function matchesBindings(
  state: CodexPoolActivationState,
  bindings: CodexPoolBindings,
): boolean {
  return (
    state.revision === bindings.revision &&
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
  mode: "native" | "active";
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
  if (!matchesBindings(state, bindings)) {
    return {
      mode: "native",
      problem_code: "activation-binding-stale",
      state,
    };
  }
  if (state.mode === "active") {
    return { mode: "active", problem_code: null, state };
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
  if (effective.mode === "active" && effective.state !== null) {
    try {
      healthy = deps.verify(effective.state);
    } catch {
      healthy = false;
    }
  }
  return result(
    "status",
    healthy,
    healthy ? "active" : "native",
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

export function activateCodexPool(
  deps: CodexPoolActivationDeps,
  source?: string,
): CodexPoolWorkflowResult {
  const lock = deps.store.tryLock();
  if (lock === null) {
    return result("activate", false, "native", "activation-busy");
  }
  try {
    if (deps.store.transactionExists()) {
      return result("activate", false, "native", "recovery-required");
    }
    const proof = proofResult(
      deps.store.readReport(source),
      deps.bindings,
      deps.nowMs(),
    );
    if (proof === null) {
      return result("activate", false, "native", "proof-missing");
    }
    if (proof.verdict !== "proven") {
      return result(
        "activate",
        false,
        "native",
        proof.verdict === "incomplete" ? "proof-incomplete" : "proof-failed",
        proof,
      );
    }
    const candidate = stateFor("active", deps.bindings, deps.nowMs());
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
      !matchesBindings(persisted, deps.bindings) ||
      persisted.mode !== "active" ||
      !deps.verify(candidate)
    ) {
      return rollbackAfterFailure(deps, "activate");
    }
    deps.store.endTransaction();
    return result("activate", true, "active", null, proof);
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
  if (effective.mode !== "active" || effective.state === null) {
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
    verified ? "active" : "native",
    verified ? null : "verification-failed",
  );
}

export function codexPoolObservationVerifies(
  candidate: CodexPoolActivationState,
  inspection: CodexRoutingInspection,
): boolean {
  return (
    candidate.mode === "active" &&
    inspection.config_binding === candidate.config_binding &&
    inspection.health === "ready" &&
    inspection.fresh &&
    inspection.verdict.kind === "pooled" &&
    candidate.aliases.includes(inspection.verdict.alias) &&
    inspection.candidates.length >= 2 &&
    inspection.candidates.every((entry) =>
      candidate.aliases.includes(entry.alias),
    )
  );
}

export function codexPoolConfigDigest(state: CodexPoolActivationState): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
