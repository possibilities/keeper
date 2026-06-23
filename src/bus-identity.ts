/**
 * Agent Bus two-layer name resolution (epic fn-875). The keystone correctness
 * surface: an agent reachable by its CURRENT name must ALSO be reachable by ANY
 * FORMER name (dead-name resolution), symmetric for reach and reply.
 *
 * PURE over its inputs — `(live channel set, read-only keeper.db handle, target)`
 * — so every resolution path unit-tests in-process via `freshMemDb()` seeding a
 * synthetic `jobs` table. No env / tmux / cwd / `Date.now()` reads; the impure
 * I/O (DB open, clock) lives in the worker and arrives as plain data.
 *
 * Two layers:
 *  - Layer 2 (identity) — resolve the target NAME to a stable keeper identity by
 *    consulting ALL `jobs` (not just live channels): exact on session_id / pid /
 *    current title / ANY `name_history` entry → prefix on ids → substring on the
 *    CURRENT TITLE ONLY. Append-only `name_history` makes an old/dead name map
 *    deterministically to the same agent.
 *  - Layer 1 (delivery) — map the resolved identity (or, on a keeper miss, the
 *    raw target) to a CURRENT live channel.
 *
 * Fail-soft: a keeper miss does NOT error — it falls back to the live registry
 * (a just-started agent whose pid is not yet folded into `jobs` is reachable by
 * its register-frame name). Ambiguity is deterministic: prefer a LIVE channel,
 * else the newest job by `updated_at`.
 */

import type { Database } from "bun:sqlite";

/**
 * The live, in-memory channel set the worker hands the resolver — Layer 1. A
 * subset of the bus's `ChannelRow` shape carrying only the resolution-relevant
 * fields, so the resolver stays decoupled from the storage row type.
 */
export interface LiveChannel {
  channel_id: string;
  pid: number;
  start_time: string;
  session_id: string | null;
  current_name: string | null;
  /** Oldest→newest session names. */
  name_history: string[];
  /**
   * Presence axis: whether the channel has an OPEN socket right now. Identity
   * resolution treats a known-disconnected channel as resolvable (so a send to
   * it reports `not_connected` rather than `unknown`), but delivery and the
   * ambiguity-collapse "preferred" pick gate on this being `true`.
   */
  connected: boolean;
}

/** A stable keeper identity resolved from `jobs` (Layer 2 output). */
export interface ResolvedIdentity {
  job_id: string;
  pid: number | null;
  start_time: string | null;
  title: string | null;
  name_history: string[];
}

/** Resolution method label — echoed for diagnostics. */
export type ResolveMethod =
  | "live-exact"
  | "jobs-exact"
  | "jobs-prefix"
  | "jobs-substring"
  | "live-fallback"
  | "unknown";

export type BusResolveResult =
  | {
      kind: "ok";
      method: ResolveMethod;
      /** The live channel to deliver to (present when the agent is on the bus NOW). */
      channel: LiveChannel | null;
      /** The keeper identity (present when keeper knew the agent). */
      identity: ResolvedIdentity | null;
    }
  | { kind: "ambiguous"; method: ResolveMethod; identities: ResolvedIdentity[] }
  | { kind: "unknown"; target: string };

const LIVE_PREFER_ORDER = `
  COALESCE(updated_at, created_at) DESC,
  job_id ASC`;

/** Map a raw `jobs` row to a {@link ResolvedIdentity}. */
function rowToIdentity(row: Record<string, unknown>): ResolvedIdentity {
  let history: string[] = [];
  const cell = row.name_history;
  if (typeof cell === "string" && cell.length > 0) {
    try {
      const parsed = JSON.parse(cell);
      if (Array.isArray(parsed)) history = parsed.map((v) => String(v));
    } catch {
      history = [];
    }
  }
  return {
    job_id: String(row.job_id),
    pid: row.pid == null ? null : Number(row.pid),
    start_time: row.start_time == null ? null : String(row.start_time),
    title: row.title == null ? null : String(row.title),
    name_history: history,
  };
}

/**
 * Find the live channel for a resolved identity — Layer 1 over Layer 2's output.
 * Matches on the stable `(pid, start_time)` identity first (defeats pid reuse),
 * then on `session_id == job_id`. Returns null when the agent is not on the bus.
 */
function liveChannelForIdentity(
  channels: LiveChannel[],
  id: ResolvedIdentity,
): LiveChannel | null {
  if (id.pid != null && id.start_time != null) {
    const byIdentity = channels.find(
      (c) => c.pid === id.pid && c.start_time === id.start_time,
    );
    if (byIdentity) return byIdentity;
  }
  const bySession = channels.find((c) => c.session_id === id.job_id);
  return bySession ?? null;
}

/**
 * Layer 1 ONLY — match a target directly against the live channel set. The
 * fail-soft path when keeper.db knows nothing of the agent (resume gap). Exact
 * on session_id / pid / current_name / ANY name_history entry (NOCASE on names).
 */
function matchLiveExact(
  channels: LiveChannel[],
  target: string,
): LiveChannel[] {
  const needle = target.toLowerCase();
  const asInt = /^\d+$/.test(target) ? Number(target) : null;
  return channels.filter(
    (c) =>
      c.session_id === target ||
      (asInt != null && c.pid === asInt) ||
      (c.current_name != null && c.current_name.toLowerCase() === needle) ||
      c.name_history.some((n) => n.toLowerCase() === needle),
  );
}

/**
 * Resolve `jobs` rows for a target at one tier. Tier `exact` ANDs the
 * cross-field exact predicate (session_id / pid / current title / ANY
 * name_history entry, NOCASE on titles); `prefix` matches job_id/start ids by
 * prefix; `substring` matches the CURRENT TITLE ONLY (history is exact-only — a
 * substring over old names creates spooky false positives from forgotten
 * sessions, per the chatctl resolution model). Bound params only — never
 * string-interpolated.
 */
function jobsAtTier(
  db: Database,
  target: string,
  tier: "exact" | "prefix" | "substring",
): ResolvedIdentity[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (tier === "exact") {
    const asInt = /^\d+$/.test(target) ? Number(target) : null;
    where.push("job_id = ?");
    params.push(target);
    where.push("title = ? COLLATE NOCASE");
    params.push(target);
    where.push(`EXISTS (
      SELECT 1 FROM json_each(COALESCE(name_history, '[]')) je
       WHERE je.value = ? COLLATE NOCASE)`);
    params.push(target);
    if (asInt != null) {
      where.push("pid = ?");
      params.push(asInt);
    }
  } else if (tier === "prefix") {
    where.push("job_id LIKE ? ESCAPE '\\'");
    params.push(`${escapeLike(target)}%`);
  } else {
    where.push("title LIKE ? ESCAPE '\\' COLLATE NOCASE");
    params.push(`%${escapeLike(target)}%`);
  }
  const sql = `SELECT job_id, pid, start_time, title, name_history
    FROM jobs WHERE (${where.join(" OR ")})
    ORDER BY ${LIVE_PREFER_ORDER}`;
  const rows = db.prepare(sql).all(...(params as never[])) as Record<
    string,
    unknown
  >[];
  return rows.map(rowToIdentity);
}

/** Escape LIKE wildcards so a target with `%`/`_`/`\` matches literally. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Collapse a >1 identity set deterministically: prefer the one with a CONNECTED
 * channel; if exactly one is connected, that wins. A disconnected-but-resolvable
 * channel does NOT break a tie (it would deliver to no one), so the connected
 * pick is what disambiguates. Else the set stays ambiguous (the caller's `jobs`
 * query already ordered newest-by-updated_at first, but the bus surfaces
 * ambiguity rather than guessing across distinct agents). Returns `{ picked }`
 * for a clean pick, else `{ all }`.
 */
function collapseByLive(
  identities: ResolvedIdentity[],
  channels: LiveChannel[],
):
  | { picked: ResolvedIdentity; channel: LiveChannel }
  | { all: ResolvedIdentity[] } {
  const withConnected = identities
    .map((id) => ({ id, channel: liveChannelForIdentity(channels, id) }))
    .filter((x) => x.channel?.connected) as {
    id: ResolvedIdentity;
    channel: LiveChannel;
  }[];
  if (withConnected.length === 1) {
    return { picked: withConnected[0].id, channel: withConnected[0].channel };
  }
  return { all: identities };
}

/** The closed set of role tokens a `role@epic` address may carry. */
export type BusRole = "planner" | "refiner";

/** Map a recognized role to the `JobLinkEntry.kind` it resolves through. */
const ROLE_TO_LINK_KIND: Record<BusRole, "creator" | "refiner"> = {
  planner: "creator",
  refiner: "refiner",
};

/**
 * Parse a `role@epic` address into its `{ role, epic }` parts, or `null` when
 * the target is not a recognized role address. The role token is validated
 * against the closed `{planner, refiner}` set: a typo (`plannr@…`) returns
 * `null`, and a literal agent name that merely CONTAINS `@` returns `null` too —
 * either way the caller falls through to the existing name tiers, so role
 * ordering never hijacks a real name. Pure.
 */
export function parseRoleAddress(
  target: string,
): { role: BusRole; epic: string } | null {
  const m = /^(planner|refiner)@(.+)$/.exec(target);
  if (m === null) return null;
  return { role: m[1] as BusRole, epic: m[2] };
}

/**
 * Read the `epics.job_links` cell for ONE epic and return the `job_id`s of every
 * entry whose `kind` matches. Reads `epics`, never `jobs` (the only resolver path
 * that consults the `epics` projection). The JSON-TEXT cell is decoded
 * DEFENSIVELY — a NULL/empty cell, a parse failure, or a non-array payload all
 * yield `[]`, mirroring `rowToIdentity` / `decodeRow` so a malformed row never
 * throws inside the live relay path. Bound param only — never interpolated. Pure
 * over `(db, kind, epic)`.
 */
export function roleJobIds(
  db: Database,
  kind: "creator" | "refiner",
  epic: string,
): string[] {
  const row = db
    .query("SELECT job_links FROM epics WHERE epic_id = ?")
    .get(epic) as { job_links: string | null } | null;
  if (row == null) return [];
  const cell = row.job_links;
  if (typeof cell !== "string" || cell.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(cell);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids: string[] = [];
  for (const entry of parsed) {
    if (
      entry != null &&
      typeof entry === "object" &&
      (entry as { kind?: unknown }).kind === kind &&
      typeof (entry as { job_id?: unknown }).job_id === "string"
    ) {
      ids.push((entry as { job_id: string }).job_id);
    }
  }
  return ids;
}

/**
 * Resolve a `role@epic` address (the role branch of {@link resolveTarget}, run
 * BEFORE the name tiers). Collects every `kind`-matching `job_id` from the
 * epic's `job_links` — an epic can carry more than one creator edge
 * (cross-session edges are never suppressed) — and resolves each through the
 * existing identity path (a creator `job_id` IS a session id, resolved by
 * recursively re-entering {@link resolveTarget}; the bare `job_id` carries no
 * role prefix, so the recursion terminates at the exact tier).
 *
 *  - 0 ids → `unknown`
 *  - 1 id → the recursive resolution's result (`ok` with a live channel, or
 *    `not_connected`-shaped `ok` with a null channel when the creator is offline)
 *  - >1 ids → `collapseByLive` over the resolved identities (clean-pick the one
 *    connected creator, else `ambiguous`)
 *
 * Pure over `(channels, db, role, epic)`.
 */
function resolveRoleAddress(
  channels: LiveChannel[],
  db: Database,
  role: BusRole,
  epic: string,
  rawTarget: string,
): BusResolveResult {
  // `refiner@…` is recognized (so it never falls through to the name tiers) but
  // UNWIRED in this task — a clean `unknown`, never a name-tier hijack.
  if (role === "refiner") return { kind: "unknown", target: rawTarget };
  const ids = roleJobIds(db, ROLE_TO_LINK_KIND[role], epic);
  if (ids.length === 0) return { kind: "unknown", target: rawTarget };
  if (ids.length === 1) return resolveTarget(channels, db, ids[0]);

  // >1 creator edges — resolve each job_id to its identity, then collapse on the
  // single connected one (else surface ambiguity), reusing the name-tier path.
  const identities: ResolvedIdentity[] = [];
  for (const id of ids) {
    const r = resolveTarget(channels, db, id);
    if (r.kind === "ok" && r.identity != null) identities.push(r.identity);
    else if (r.kind === "ambiguous") identities.push(...r.identities);
  }
  if (identities.length === 0) return { kind: "unknown", target: rawTarget };
  const collapsed = collapseByLive(identities, channels);
  if ("picked" in collapsed) {
    return {
      kind: "ok",
      method: "jobs-exact",
      identity: collapsed.picked,
      channel: collapsed.channel,
    };
  }
  return { kind: "ambiguous", method: "jobs-exact", identities: collapsed.all };
}

/**
 * Resolve a target to a delivery channel and/or stable identity. The full
 * two-layer pipeline:
 *
 *  0. Role branch — a `role@epic` address (`planner@<epic_id>`) resolves through
 *     the epic's `job_links` creator edge(s) BEFORE the name tiers, so a role
 *     address can never miss all three job-keyed tiers and fall to `unknown`. A
 *     non-role `@`-bearing name falls through to the tiers unchanged.
 *  1. Layer 2 tiers over ALL `jobs` — exact → prefix → substring. First tier
 *     with a single identity (or a single LIVE one among several) wins.
 *  2. Layer 1 maps that identity to its current live channel (may be null — the
 *     agent is known but not on the bus right now).
 *  3. On a keeper MISS, fail-soft to a direct live-channel match (resume gap).
 *  4. Genuine miss → `unknown` (the caller surfaces it; never throws).
 *
 * @param channels  the live in-memory channel set (Layer 1).
 * @param db        read-only keeper.db handle (Layer 2 `jobs` source).
 * @param target    the requested name / id / former name.
 */
export function resolveTarget(
  channels: LiveChannel[],
  db: Database,
  target: string,
): BusResolveResult {
  const role = parseRoleAddress(target);
  if (role !== null) {
    return resolveRoleAddress(channels, db, role.role, role.epic, target);
  }

  for (const tier of ["exact", "prefix", "substring"] as const) {
    const identities = jobsAtTier(db, target, tier);
    if (identities.length === 0) continue;
    const method: ResolveMethod =
      tier === "exact"
        ? "jobs-exact"
        : tier === "prefix"
          ? "jobs-prefix"
          : "jobs-substring";
    if (identities.length === 1) {
      return {
        kind: "ok",
        method,
        identity: identities[0],
        channel: liveChannelForIdentity(channels, identities[0]),
      };
    }
    const collapsed = collapseByLive(identities, channels);
    if ("picked" in collapsed) {
      return {
        kind: "ok",
        method,
        identity: collapsed.picked,
        channel: collapsed.channel,
      };
    }
    return { kind: "ambiguous", method, identities: collapsed.all };
  }

  // Keeper miss — fail-soft to the live registry (resume gap: a just-started
  // agent reachable by its register-frame name before keeper folds it).
  const live = matchLiveExact(channels, target);
  if (live.length === 1) {
    return {
      kind: "ok",
      method: "live-fallback",
      identity: null,
      channel: live[0],
    };
  }
  if (live.length > 1) {
    // >1 live match — a single CONNECTED channel disambiguates (the others can't
    // receive anyway); only when 0 or >1 are connected is it genuinely ambiguous.
    const connected = live.filter((c) => c.connected);
    if (connected.length === 1) {
      return {
        kind: "ok",
        method: "live-fallback",
        identity: null,
        channel: connected[0],
      };
    }
    // Ambiguity in the live set alone — surface it (no keeper identity to rank by).
    return {
      kind: "ambiguous",
      method: "live-fallback",
      identities: live.map((c) => ({
        job_id: c.session_id ?? c.channel_id,
        pid: c.pid,
        start_time: c.start_time,
        title: c.current_name,
        name_history: c.name_history,
      })),
    };
  }
  return { kind: "unknown", target };
}
