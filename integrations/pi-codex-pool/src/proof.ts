import { createHash } from "node:crypto";
import { isOpaqueAlias, writePrivateJsonAtomic } from "./auth.ts";

export const LIVE_PROOF_SCHEMA_VERSION = 1;
export const LIVE_PROOF_MAX_AGE_MS = 15 * 60 * 1000;
const MAX_ARTIFACTS = 64;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_SCAN_FINDING_CLASSES = 12;
const MAX_REASONS = 16;

export const LIVE_PROOF_CLAUSES = [
  "independent_credentials",
  "sanitized_observer",
  "deterministic_routing",
  "session_stickiness",
  "pressure_cooldown",
  "single_retry",
  "substantive_cutoff",
  "abort_preserved",
  "request_contract",
  "native_fallback",
  "compat_root_delegate",
  "root_child_sessions",
  "transport_isolation",
] as const;

export type LiveProofClause = (typeof LIVE_PROOF_CLAUSES)[number];
export type ProofClassification = "proven" | "incomplete" | "failed";
export type ArtifactSurface =
  | "observer"
  | "state"
  | "proof"
  | "log"
  | "error"
  | "session"
  | "tool";
export type ScanFindingClass =
  | "bearer-token"
  | "jwt"
  | "token-field"
  | "authorization-header"
  | "account-header"
  | "account-pii"
  | "raw-auth-object"
  | "provider-headers"
  | "forbidden-value";

export interface ArtifactScanResult {
  status: "clean" | "findings" | "error";
  scanned_count: number;
  scanned_bytes: number;
  finding_classes: ScanFindingClass[];
}

export interface LiveProofReport {
  schema_version: 1;
  revision: string;
  config_binding: string;
  alias_binding: string;
  started_at_ms: number;
  completed_at_ms: number;
  interrupted: boolean;
  alias_roles: Array<{
    alias: string;
    role: "primary" | "alternate";
  }>;
  clauses: Record<LiveProofClause, boolean>;
  routes: Array<{
    session_role: "root" | "child";
    attempts: number;
    failure_class: "none" | "quota" | "rate" | "auth" | "transport";
    substantive_output: boolean;
    restored: boolean;
  }>;
  restoration: {
    required: boolean;
    completed: boolean;
  };
  artifact_scan: ArtifactScanResult;
  verdict: ProofClassification;
}

export interface ProofVerdict {
  verdict: ProofClassification;
  reasons: Array<
    | "schema-invalid"
    | "unknown-field"
    | "binding-mismatch"
    | "stale"
    | "interrupted"
    | "clause-incomplete"
    | "route-incomplete"
    | "restoration-incomplete"
    | "artifact-scan-error"
    | "sanitation-finding"
    | "declared-verdict-mismatch"
  >;
}

export interface ExpectedProofBindings {
  revision: string;
  config_binding: string;
  alias_binding: string;
  now_ms: number;
  max_age_ms?: number;
}

const REPORT_KEYS = [
  "schema_version",
  "revision",
  "config_binding",
  "alias_binding",
  "started_at_ms",
  "completed_at_ms",
  "interrupted",
  "alias_roles",
  "clauses",
  "routes",
  "restoration",
  "artifact_scan",
  "verdict",
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function hasUnknownKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).some((key) => !allowed.has(key));
}

function finiteTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function hexBinding(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function revision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{7,64}$/.test(value);
}

function addReason(
  reasons: ProofVerdict["reasons"],
  reason: ProofVerdict["reasons"][number],
): void {
  if (reasons.length < MAX_REASONS && !reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function schemaShape(input: unknown): {
  report?: LiveProofReport;
  unknown: boolean;
} {
  const top = record(input);
  if (!top) return { unknown: false };
  let unknown = hasUnknownKeys(top, REPORT_KEYS);
  if (!hasExactKeys(top, REPORT_KEYS)) return { unknown };
  const roles = top.alias_roles;
  const clauses = record(top.clauses);
  const routes = top.routes;
  const restoration = record(top.restoration);
  const scan = record(top.artifact_scan);
  if (
    top.schema_version !== LIVE_PROOF_SCHEMA_VERSION ||
    !revision(top.revision) ||
    !hexBinding(top.config_binding) ||
    !hexBinding(top.alias_binding) ||
    !finiteTimestamp(top.started_at_ms) ||
    !finiteTimestamp(top.completed_at_ms) ||
    typeof top.interrupted !== "boolean" ||
    !Array.isArray(roles) ||
    roles.length < 2 ||
    roles.length > 8 ||
    !clauses ||
    !Array.isArray(routes) ||
    routes.length < 2 ||
    routes.length > 16 ||
    !restoration ||
    !scan ||
    (top.verdict !== "proven" &&
      top.verdict !== "incomplete" &&
      top.verdict !== "failed")
  ) {
    return { unknown };
  }
  unknown ||= hasUnknownKeys(clauses, LIVE_PROOF_CLAUSES);
  if (!hasExactKeys(clauses, LIVE_PROOF_CLAUSES)) return { unknown };
  for (const clause of LIVE_PROOF_CLAUSES) {
    if (typeof clauses[clause] !== "boolean") return { unknown };
  }
  const seenAliases = new Set<string>();
  let primaryCount = 0;
  for (const rawRole of roles) {
    const role = record(rawRole);
    if (!role) return { unknown };
    unknown ||= hasUnknownKeys(role, ["alias", "role"]);
    if (
      !hasExactKeys(role, ["alias", "role"]) ||
      !isOpaqueAlias(role.alias) ||
      (role.role !== "primary" && role.role !== "alternate") ||
      seenAliases.has(role.alias)
    ) {
      return { unknown };
    }
    if (role.role === "primary") primaryCount += 1;
    seenAliases.add(role.alias);
  }
  if (primaryCount !== 1) return { unknown };
  for (const rawRoute of routes) {
    const route = record(rawRoute);
    const routeKeys = [
      "session_role",
      "attempts",
      "failure_class",
      "substantive_output",
      "restored",
    ];
    if (!route) return { unknown };
    unknown ||= hasUnknownKeys(route, routeKeys);
    if (
      !hasExactKeys(route, routeKeys) ||
      (route.session_role !== "root" && route.session_role !== "child") ||
      !Number.isInteger(route.attempts) ||
      (route.attempts as number) < 1 ||
      (route.attempts as number) > 2 ||
      !["none", "quota", "rate", "auth", "transport"].includes(
        String(route.failure_class),
      ) ||
      typeof route.substantive_output !== "boolean" ||
      typeof route.restored !== "boolean"
    ) {
      return { unknown };
    }
  }
  unknown ||= hasUnknownKeys(restoration, ["required", "completed"]);
  if (
    !hasExactKeys(restoration, ["required", "completed"]) ||
    typeof restoration.required !== "boolean" ||
    typeof restoration.completed !== "boolean"
  ) {
    return { unknown };
  }
  const scanKeys = [
    "status",
    "scanned_count",
    "scanned_bytes",
    "finding_classes",
  ];
  unknown ||= hasUnknownKeys(scan, scanKeys);
  if (
    !hasExactKeys(scan, scanKeys) ||
    !["clean", "findings", "error"].includes(String(scan.status)) ||
    !Number.isInteger(scan.scanned_count) ||
    (scan.scanned_count as number) < 0 ||
    (scan.scanned_count as number) > MAX_ARTIFACTS ||
    !Number.isInteger(scan.scanned_bytes) ||
    (scan.scanned_bytes as number) < 0 ||
    (scan.scanned_bytes as number) > MAX_ARTIFACT_BYTES ||
    !Array.isArray(scan.finding_classes) ||
    scan.finding_classes.length > MAX_SCAN_FINDING_CLASSES ||
    scan.finding_classes.some(
      (item) =>
        ![
          "bearer-token",
          "jwt",
          "token-field",
          "authorization-header",
          "account-header",
          "account-pii",
          "raw-auth-object",
          "provider-headers",
          "forbidden-value",
        ].includes(String(item)),
    )
  ) {
    return { unknown };
  }
  return { report: input as LiveProofReport, unknown };
}

function classifyWithoutDeclaredVerdict(
  report: LiveProofReport,
  expected: ExpectedProofBindings,
  reasons: ProofVerdict["reasons"],
): ProofClassification {
  if (
    report.revision !== expected.revision ||
    report.config_binding !== expected.config_binding ||
    report.alias_binding !== expected.alias_binding ||
    aliasRoleBinding(report.alias_roles) !== report.alias_binding
  ) {
    addReason(reasons, "binding-mismatch");
  }
  const maxAge = expected.max_age_ms ?? LIVE_PROOF_MAX_AGE_MS;
  if (
    !Number.isFinite(expected.now_ms) ||
    !Number.isFinite(maxAge) ||
    maxAge < 1 ||
    report.completed_at_ms < report.started_at_ms ||
    report.completed_at_ms > expected.now_ms ||
    expected.now_ms - report.completed_at_ms > maxAge
  ) {
    addReason(reasons, "stale");
  }
  if (report.interrupted) addReason(reasons, "interrupted");
  if (LIVE_PROOF_CLAUSES.some((clause) => report.clauses[clause] !== true)) {
    addReason(reasons, "clause-incomplete");
  }
  if (
    !report.routes.some((route) => route.session_role === "root") ||
    !report.routes.some((route) => route.session_role === "child") ||
    report.routes.some((route) => !route.restored)
  ) {
    addReason(reasons, "route-incomplete");
  }
  if (report.restoration.required && !report.restoration.completed) {
    addReason(reasons, "restoration-incomplete");
  }
  if (report.artifact_scan.status === "error") {
    addReason(reasons, "artifact-scan-error");
  }
  if (
    report.artifact_scan.status === "findings" ||
    report.artifact_scan.finding_classes.length > 0
  ) {
    addReason(reasons, "sanitation-finding");
  }
  if (
    reasons.includes("artifact-scan-error") ||
    reasons.includes("sanitation-finding")
  ) {
    return "failed";
  }
  return reasons.length === 0 ? "proven" : "incomplete";
}

export function classifyLiveProof(
  input: unknown,
  expected: ExpectedProofBindings,
): ProofVerdict {
  const reasons: ProofVerdict["reasons"] = [];
  const parsed = schemaShape(input);
  if (parsed.unknown) addReason(reasons, "unknown-field");
  if (!parsed.report) {
    addReason(reasons, "schema-invalid");
    return { verdict: "failed", reasons };
  }
  if (parsed.unknown) return { verdict: "failed", reasons };
  const computed = classifyWithoutDeclaredVerdict(
    parsed.report,
    expected,
    reasons,
  );
  if (parsed.report.verdict !== computed) {
    addReason(reasons, "declared-verdict-mismatch");
    return { verdict: "failed", reasons };
  }
  return { verdict: computed, reasons };
}

export function aliasRoleBinding(
  roles: ReadonlyArray<{ alias: string; role: "primary" | "alternate" }>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        roles.map(({ alias, role }) => {
          if (!isOpaqueAlias(alias)) throw new Error("invalid-alias-role");
          return { alias, role };
        }),
      ),
    )
    .digest("hex");
}

export function collectLiveProof(
  input: Omit<LiveProofReport, "schema_version" | "verdict">,
  expected: ExpectedProofBindings,
): LiveProofReport {
  const report = {
    schema_version: LIVE_PROOF_SCHEMA_VERSION,
    revision: input.revision,
    config_binding: input.config_binding,
    alias_binding: input.alias_binding,
    started_at_ms: input.started_at_ms,
    completed_at_ms: input.completed_at_ms,
    interrupted: input.interrupted,
    alias_roles: input.alias_roles.map(({ alias, role }) => ({ alias, role })),
    clauses: Object.fromEntries(
      LIVE_PROOF_CLAUSES.map((clause) => [clause, input.clauses[clause]]),
    ) as Record<LiveProofClause, boolean>,
    routes: input.routes.map((route) => ({
      session_role: route.session_role,
      attempts: route.attempts,
      failure_class: route.failure_class,
      substantive_output: route.substantive_output,
      restored: route.restored,
    })),
    restoration: {
      required: input.restoration.required,
      completed: input.restoration.completed,
    },
    artifact_scan: {
      status: input.artifact_scan.status,
      scanned_count: input.artifact_scan.scanned_count,
      scanned_bytes: input.artifact_scan.scanned_bytes,
      finding_classes: [...input.artifact_scan.finding_classes],
    },
    verdict: "incomplete" as ProofClassification,
  } satisfies LiveProofReport;
  const reasons: ProofVerdict["reasons"] = [];
  report.verdict = classifyWithoutDeclaredVerdict(report, expected, reasons);
  return report;
}

export function scanProofArtifacts(
  artifacts: ReadonlyArray<{ surface: ArtifactSurface; content: string }>,
  forbiddenValues: readonly string[] = [],
): ArtifactScanResult {
  try {
    if (artifacts.length > MAX_ARTIFACTS) throw new Error("scan-bound");
    const findings = new Set<ScanFindingClass>();
    let scannedBytes = 0;
    const surfaces = new Set<ArtifactSurface>([
      "observer",
      "state",
      "proof",
      "log",
      "error",
      "session",
      "tool",
    ]);
    for (const artifact of artifacts) {
      if (
        !surfaces.has(artifact.surface) ||
        typeof artifact.content !== "string"
      ) {
        throw new Error("scan-input");
      }
      scannedBytes += Buffer.byteLength(artifact.content);
      if (scannedBytes > MAX_ARTIFACT_BYTES) throw new Error("scan-bound");
      const content = artifact.content;
      if (/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(content)) {
        findings.add("bearer-token");
      }
      if (
        /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/.test(
          content,
        )
      ) {
        findings.add("jwt");
      }
      if (
        /\b(?:access_token|refresh_token|access|refresh)\b["']?\s*[:=]/i.test(
          content,
        )
      ) {
        findings.add("token-field");
      }
      if (/\bauthorization\b["']?\s*[:=]/i.test(content)) {
        findings.add("authorization-header");
      }
      if (
        /\b(?:chatgpt-account-id|accountId|chatgpt_account_id)\b["']?\s*[:=]/i.test(
          content,
        )
      ) {
        findings.add("account-header");
      }
      if (
        /["']type["']\s*:\s*["']oauth["']/i.test(content) ||
        /\b(?:apiKey|credential)\b["']?\s*[:=]/i.test(content)
      ) {
        findings.add("raw-auth-object");
      }
      if (/\bheaders\b["']?\s*[:=]/i.test(content)) {
        findings.add("provider-headers");
      }
      if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(content)) {
        findings.add("account-pii");
      }
      if (
        forbiddenValues.some(
          (value) => value.length >= 4 && content.includes(value),
        )
      ) {
        findings.add("forbidden-value");
      }
    }
    return {
      status: findings.size === 0 ? "clean" : "findings",
      scanned_count: artifacts.length,
      scanned_bytes: scannedBytes,
      finding_classes: [...findings].sort(),
    };
  } catch {
    return {
      status: "error",
      scanned_count: 0,
      scanned_bytes: 0,
      finding_classes: [],
    };
  }
}

export function writeLiveProofReport(
  path: string,
  report: LiveProofReport,
): void {
  writePrivateJsonAtomic(path, report);
}
