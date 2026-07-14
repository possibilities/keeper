export type IdentitySource =
  | "explicit"
  | "JOBCTL_SESSION_ID"
  | "CLAUDE_CODE_SESSION_ID"
  | "KEEPER_JOB_ID"
  | "JOBCTL_JOB_ID";

export interface InvocationIdentity {
  /** The single identity used by discovery, trailers, telemetry, and results. */
  value: string | null;
  source: IdentitySource | null;
  /** All non-empty carriers, retained only for a typed conflict diagnostic. */
  carriers: Partial<Record<IdentitySource, string>>;
}

export class IdentityConflictError extends Error {
  readonly carriers: Partial<Record<IdentitySource, string>>;

  constructor(carriers: Partial<Record<IdentitySource, string>>) {
    super("conflicting invocation identity sources");
    this.name = "IdentityConflictError";
    this.carriers = carriers;
  }
}

export class InvalidIdentityError extends Error {
  readonly sources: IdentitySource[];

  constructor(sources: IdentitySource[]) {
    super("invalid invocation identity source");
    this.name = "InvalidIdentityError";
    this.sources = sources;
  }
}

/** UUID syntax accepted for invocation identity and the Job-Id trailer. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Resolve the invocation identity once. Any two non-empty carriers must agree;
 * silently preferring one would let attribution, trailers, and telemetry name
 * different writers. Keeper's tracked id carrier remains part of the surface.
 */
export function resolveInvocationIdentity(
  explicit: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): InvocationIdentity {
  const carriers: Partial<Record<IdentitySource, string>> = {};
  const add = (
    source: IdentitySource,
    raw: string | null | undefined,
  ): void => {
    const value = raw?.trim();
    if (value) carriers[source] = value;
  };
  add("explicit", explicit);
  add("JOBCTL_SESSION_ID", env.JOBCTL_SESSION_ID);
  add("CLAUDE_CODE_SESSION_ID", env.CLAUDE_CODE_SESSION_ID);
  add("KEEPER_JOB_ID", env.KEEPER_JOB_ID);
  add("JOBCTL_JOB_ID", env.JOBCTL_JOB_ID);

  const invalid = (Object.entries(carriers) as Array<[IdentitySource, string]>)
    .filter(([, value]) => !isUuid(value))
    .map(([source]) => source);
  if (invalid.length > 0) throw new InvalidIdentityError(invalid);

  // UUID spelling is case-insensitive at the boundary, but every downstream
  // consumer gets exactly one canonical lowercase identity.
  for (const source of Object.keys(carriers) as IdentitySource[]) {
    carriers[source] = carriers[source]?.toLowerCase();
  }
  const distinct = new Set(Object.values(carriers));
  if (distinct.size > 1) throw new IdentityConflictError(carriers);

  const order: IdentitySource[] = [
    "explicit",
    "JOBCTL_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
    "KEEPER_JOB_ID",
    "JOBCTL_JOB_ID",
  ];
  for (const source of order) {
    const value = carriers[source];
    if (value) return { value, source, carriers };
  }
  return { value: null, source: null, carriers };
}
