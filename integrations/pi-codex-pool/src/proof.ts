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

/**
 * The only clauses a degraded verdict may waive: their evidence structurally
 * requires a second serving alias — distinct root/child routing and the
 * pool-exhaustion native-fallback leg — which a quota-dead alias refuses. Any
 * unmet clause outside this set makes the run genuinely incomplete, never
 * degraded-eligible.
 */
export const QUOTA_WAIVABLE_CLAUSES = [
  "native_fallback",
  "transport_isolation",
] as const satisfies readonly LiveProofClause[];

export type ProofClassification =
  | "proven"
  | "incomplete"
  | "failed"
  | "proven-degraded-single-alias";

/**
 * A degraded verdict's recorded justification: the classified interruption cause
 * and the exact clauses waived because the quota-dead alias refused to serve.
 */
export interface DegradedProofVerdict {
  cause: "quota";
  waived_clauses: LiveProofClause[];
  pinned_alias: string;
}

export const LIVE_PROOF_REQUIRED_EVIDENCE = {
  independent_credentials: [
    "primary-credential-rotated",
    "alternate-credential-rotated",
  ],
  sanitized_observer: ["sanitized-observer-rendered"],
  deterministic_routing: ["routes-recorded", "attempt-aliases-recorded"],
  session_stickiness: ["completed-session-reused-alias"],
  pressure_cooldown: [
    "concurrent-routes-observed",
    "classified-retry-observed",
    "cooldown-observed",
  ],
  single_retry: [
    "two-attempt-route-observed",
    "all-routes-at-most-two-attempts",
  ],
  substantive_cutoff: ["substantive-output-fault-not-retried"],
  abort_preserved: ["deliberate-child-abort-not-retried"],
  request_contract: ["all-attempts-preserved-request-contract"],
  native_fallback: ["native-fallback-completed"],
  compat_root_delegate: ["compat-root-delegate-used"],
  root_child_sessions: ["root-route-observed", "child-route-observed"],
  transport_isolation: ["root-child-distinct-aliases"],
} as const satisfies Record<LiveProofClause, readonly string[]>;

export interface ProofTranscriptEntry {
  sequence: number;
  clause: LiveProofClause;
  evidence: string[];
}

export type ArtifactSurface =
  | "observer"
  | "state"
  | "proof"
  | "transcript"
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
  transcript: ProofTranscriptEntry[];
  clauses: Record<LiveProofClause, boolean>;
  routes: Array<{
    session_role: "root" | "child";
    attempts: number;
    aliases: string[];
    failure_class: "none" | "quota" | "rate" | "auth" | "transport";
    substantive_output: boolean;
    restored: boolean;
  }>;
  restoration: {
    required: boolean;
    completed: boolean;
  };
  artifact_scan: ArtifactScanResult;
  degraded: DegradedProofVerdict | null;
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
    | "transcript-mismatch"
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
  "transcript",
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

/**
 * Every required report key present and no key outside the required set plus the
 * optional `degraded` marker — a legacy full report omitting `degraded` reads as
 * a non-degraded report, while an extra unknown key is rejected upstream.
 */
function hasReportKeys(value: Record<string, unknown>): boolean {
  const keys = new Set(Object.keys(value));
  const allowed = new Set<string>([...REPORT_KEYS, "degraded"]);
  return (
    REPORT_KEYS.every((key) => keys.has(key)) &&
    [...keys].every((key) => allowed.has(key))
  );
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
  let unknown = hasUnknownKeys(top, [...REPORT_KEYS, "degraded"]);
  if (!hasReportKeys(top)) return { unknown };
  const roles = top.alias_roles;
  const transcript = top.transcript;
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
    !Array.isArray(transcript) ||
    transcript.length !== LIVE_PROOF_CLAUSES.length ||
    !clauses ||
    !Array.isArray(routes) ||
    routes.length > 16 ||
    !restoration ||
    !scan ||
    (top.verdict !== "proven" &&
      top.verdict !== "incomplete" &&
      top.verdict !== "failed" &&
      top.verdict !== "proven-degraded-single-alias")
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
  for (const [index, rawEntry] of transcript.entries()) {
    const entry = record(rawEntry);
    const clause = LIVE_PROOF_CLAUSES[index];
    if (!entry || clause === undefined) return { unknown };
    unknown ||= hasUnknownKeys(entry, ["sequence", "clause", "evidence"]);
    if (
      !hasExactKeys(entry, ["sequence", "clause", "evidence"]) ||
      entry.sequence !== index + 1 ||
      entry.clause !== clause ||
      !Array.isArray(entry.evidence) ||
      entry.evidence.length > LIVE_PROOF_REQUIRED_EVIDENCE[clause].length ||
      entry.evidence.some((item) => typeof item !== "string") ||
      new Set(entry.evidence).size !== entry.evidence.length ||
      entry.evidence.some(
        (item) =>
          !(LIVE_PROOF_REQUIRED_EVIDENCE[clause] as readonly string[]).includes(
            String(item),
          ),
      )
    ) {
      return { unknown };
    }
  }
  for (const rawRoute of routes) {
    const route = record(rawRoute);
    const routeKeys = [
      "session_role",
      "attempts",
      "aliases",
      "failure_class",
      "substantive_output",
      "restored",
    ];
    if (!route) return { unknown };
    unknown ||= hasUnknownKeys(route, routeKeys);
    const routeAliases = route.aliases;
    if (
      !hasExactKeys(route, routeKeys) ||
      (route.session_role !== "root" && route.session_role !== "child") ||
      !Array.isArray(routeAliases) ||
      routeAliases.length < 1 ||
      routeAliases.length > 2 ||
      routeAliases.some(
        (alias) => !isOpaqueAlias(alias) || !seenAliases.has(String(alias)),
      ) ||
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
  const degraded = top.degraded;
  if (degraded !== undefined && degraded !== null) {
    const marker = record(degraded);
    if (!marker) return { unknown };
    unknown ||= hasUnknownKeys(marker, [
      "cause",
      "waived_clauses",
      "pinned_alias",
    ]);
    const waived = marker.waived_clauses;
    if (
      !hasExactKeys(marker, ["cause", "waived_clauses", "pinned_alias"]) ||
      marker.cause !== "quota" ||
      typeof marker.pinned_alias !== "string" ||
      !isOpaqueAlias(marker.pinned_alias) ||
      !Array.isArray(waived) ||
      waived.length === 0 ||
      waived.length > QUOTA_WAIVABLE_CLAUSES.length ||
      new Set(waived).size !== waived.length ||
      waived.some(
        (clause) =>
          !(QUOTA_WAIVABLE_CLAUSES as readonly string[]).includes(
            String(clause),
          ),
      )
    ) {
      return { unknown };
    }
  }
  return { report: input as LiveProofReport, unknown };
}

/**
 * The residual reasons a legitimate quota degradation may still carry: the
 * waived clauses register `clause-incomplete`, the quota refusal may mark the
 * run `interrupted`, and the refused native-fallback leg may leave restoration
 * incomplete. Any other reason (binding, staleness, sanitation, missing routes)
 * disqualifies the degraded verdict outright.
 */
const DEGRADED_ALLOWED_REASONS = new Set<ProofVerdict["reasons"][number]>([
  "clause-incomplete",
  "interrupted",
  "restoration-incomplete",
]);

/**
 * True only when the run's sole shortfall is the quota-dead alias refusing its
 * waivable legs: every unmet clause is quota-waivable, the declared waiver names
 * exactly those clauses, a route recorded a genuine quota failure, and no reason
 * outside the allowed residual set remains.
 */
function degradedEligible(
  routes: LiveProofReport["routes"],
  transcriptClauses: Record<LiveProofClause, boolean>,
  reasons: ProofVerdict["reasons"],
  waivedClauses: readonly LiveProofClause[],
): boolean {
  const unmet = LIVE_PROOF_CLAUSES.filter(
    (clause) => !transcriptClauses[clause],
  );
  if (unmet.length === 0) return false;
  if (
    !unmet.every((clause) =>
      (QUOTA_WAIVABLE_CLAUSES as readonly string[]).includes(clause),
    )
  ) {
    return false;
  }
  const waivedSet = new Set(waivedClauses);
  if (
    waivedSet.size !== waivedClauses.length ||
    waivedClauses.length !== unmet.length ||
    !unmet.every((clause) => waivedSet.has(clause)) ||
    !waivedClauses.every((clause) =>
      (QUOTA_WAIVABLE_CLAUSES as readonly string[]).includes(clause),
    )
  ) {
    return false;
  }
  if (!routes.some((route) => route.failure_class === "quota")) return false;
  if (!reasons.includes("clause-incomplete")) return false;
  return reasons.every((reason) => DEGRADED_ALLOWED_REASONS.has(reason));
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
  const transcriptClauses = clausesFromProofTranscript(report.transcript);
  if (
    LIVE_PROOF_CLAUSES.some(
      (clause) => report.clauses[clause] !== transcriptClauses[clause],
    )
  ) {
    addReason(reasons, "transcript-mismatch");
  }
  if (LIVE_PROOF_CLAUSES.some((clause) => !transcriptClauses[clause])) {
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
    reasons.includes("transcript-mismatch") ||
    reasons.includes("artifact-scan-error") ||
    reasons.includes("sanitation-finding")
  ) {
    return "failed";
  }
  if (reasons.length === 0) return "proven";
  const declaredDegraded = report.degraded ?? null;
  if (
    declaredDegraded !== null &&
    declaredDegraded.cause === "quota" &&
    degradedEligible(
      report.routes,
      transcriptClauses,
      reasons,
      declaredDegraded.waived_clauses,
    )
  ) {
    return "proven-degraded-single-alias";
  }
  return "incomplete";
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

/**
 * The validated degraded marker of a schema-valid report, or null when the
 * report carries none. Callers that have already confirmed a
 * `proven-degraded-single-alias` verdict via {@link classifyLiveProof} use this
 * to read the waived clauses the activation pin must record.
 */
export function reportDegradedVerdict(
  input: unknown,
): DegradedProofVerdict | null {
  const parsed = schemaShape(input);
  const degraded = parsed.report?.degraded ?? null;
  if (degraded === null || degraded.cause !== "quota") return null;
  return {
    cause: "quota",
    waived_clauses: [...degraded.waived_clauses],
    pinned_alias: degraded.pinned_alias,
  };
}

export function buildProofTranscript(
  observed: Partial<Record<LiveProofClause, readonly string[]>>,
): ProofTranscriptEntry[] {
  return LIVE_PROOF_CLAUSES.map((clause, index) => {
    const supplied = new Set(observed[clause] ?? []);
    return {
      sequence: index + 1,
      clause,
      evidence: LIVE_PROOF_REQUIRED_EVIDENCE[clause].filter((item) =>
        supplied.has(item),
      ),
    };
  });
}

export function clausesFromProofTranscript(
  transcript: readonly ProofTranscriptEntry[],
): Record<LiveProofClause, boolean> {
  const byClause = new Map(
    transcript.map((entry) => [entry.clause, new Set(entry.evidence)]),
  );
  return Object.fromEntries(
    LIVE_PROOF_CLAUSES.map((clause) => {
      const observed = byClause.get(clause);
      return [
        clause,
        observed !== undefined &&
          LIVE_PROOF_REQUIRED_EVIDENCE[clause].every((item) =>
            observed.has(item),
          ),
      ];
    }),
  ) as Record<LiveProofClause, boolean>;
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
  input: Omit<LiveProofReport, "schema_version" | "verdict" | "degraded">,
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
    transcript: input.transcript.map((entry) => ({
      sequence: entry.sequence,
      clause: entry.clause,
      evidence: [...entry.evidence],
    })),
    clauses: Object.fromEntries(
      LIVE_PROOF_CLAUSES.map((clause) => [clause, input.clauses[clause]]),
    ) as Record<LiveProofClause, boolean>,
    routes: input.routes.map((route) => ({
      session_role: route.session_role,
      attempts: route.attempts,
      aliases: [...route.aliases],
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
    degraded: null as DegradedProofVerdict | null,
    verdict: "incomplete" as ProofClassification,
  } satisfies LiveProofReport;
  const reasons: ProofVerdict["reasons"] = [];
  report.verdict = classifyWithoutDeclaredVerdict(report, expected, reasons);
  if (report.verdict === "incomplete") {
    const transcriptClauses = clausesFromProofTranscript(report.transcript);
    const faulted = new Set<string>();
    for (const route of report.routes) {
      if (route.failure_class !== "quota") continue;
      const first = route.aliases[0];
      if (first !== undefined) faulted.add(first);
    }
    const healthyCandidates = report.alias_roles
      .map((entry) => entry.alias)
      .filter((alias) => !faulted.has(alias));
    const pinnedAlias =
      faulted.size >= 1 && healthyCandidates.length === 1
        ? healthyCandidates[0]
        : null;
    if (pinnedAlias === undefined || pinnedAlias === null) return report;
    const candidate: DegradedProofVerdict = {
      cause: "quota",
      waived_clauses: LIVE_PROOF_CLAUSES.filter(
        (clause) => !transcriptClauses[clause],
      ),
      pinned_alias: pinnedAlias,
    };
    const degradedReasons: ProofVerdict["reasons"] = [];
    const upgraded = classifyWithoutDeclaredVerdict(
      { ...report, degraded: candidate },
      expected,
      degradedReasons,
    );
    if (upgraded === "proven-degraded-single-alias") {
      report.degraded = candidate;
      report.verdict = upgraded;
    }
  }
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
      "transcript",
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
