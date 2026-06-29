/**
 * Read-only shadow/stray profile-dir detector. Scans `~/.claude-profiles` and
 * `~/.pi-profiles` for dirs that are NOT a tracked managed profile: reserved
 * shadows (a `default`/`auto` basename that collides with the native `~/.claude`
 * / `~/.pi` account — `default` strands a login nothing reads) and untracked
 * strays (a leftover dir agentusage's config no longer lists). It ALSO inspects
 * the native `~/.claude` itself for the re-home-incomplete state: authed
 * (`oauthAccount` present) but the tier unresolvable, which renders `?x` in
 * `keeper usage`. Purely diagnostic — it NEVER moves, deletes, or otherwise
 * mutates the filesystem.
 *
 * Robustness: a vanished entry (mid-scan ENOENT) or an unparseable
 * `.claude.json` is a finding-or-skip, never a crash — scanning continues. Auth
 * presence is probed structurally (a `.credentials.json` file, or a
 * `.claude.json` carrying an `oauthAccount` object — the read shape mirrors the
 * usage scraper); token CONTENTS are never read or logged.
 *
 * DB-free leaf: imports only `node:fs`/`node:os`/`node:path` + the dep-free
 * `usage-picker` (`listProfiles`), `state-sharing`
 * (`isReservedProfileDirName`), and `claude-tier` (the tier predicate, shared
 * with the scraper so the two never disagree), so both the `keeper agent`
 * launcher and `cli/usage.ts` can import it without dragging `src/db.ts` onto a
 * cold path.
 */

import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_CLAUDE_JSON_BYTES, resolveTierMultiplier } from "../claude-tier";
import { isReservedProfileDirName } from "./state-sharing";

export type ShadowProfileAgent = "claude" | "pi";

/** One stray/shadow profile dir found under a profiles root. */
export interface ShadowProfileFinding {
  /** Which profiles root the dir lives under. */
  agent: ShadowProfileAgent;
  /** The dir basename — the ORIGINAL on-disk string (never NFC-normalized). */
  name: string;
  /** A `.credentials.json`, or a `.claude.json`/`auth.json` carrying auth, exists. */
  hasAuth: boolean;
  /** The basename resolves to the reserved set (`default`/`auto`) — always a shadow. */
  isReservedShadow: boolean;
  /** agentusage config.yaml lists this name (may STILL be a reserved shadow). */
  tracked: boolean;
  /**
   * Discriminant: when set, this finding is NOT a profiles-root dir but the
   * native `~/.claude` account being authed (`oauthAccount` present) while its
   * `organizationRateLimitTier` is unresolvable — a re-home that restored the
   * keychain but not the tier cache (usage then renders `?x`). Absent on the
   * ordinary stray/shadow dir findings, which carry shadow/tracked semantics
   * this one does not (`name` is the canonical dir basename, not a profile name).
   */
  tierUnresolved?: boolean;
}

const PROFILE_ROOTS: ReadonlyArray<{
  agent: ShadowProfileAgent;
  rootName: string;
}> = [
  { agent: "claude", rootName: ".claude-profiles" },
  { agent: "pi", rootName: ".pi-profiles" },
];

/**
 * Findings for every stray/shadow dir under both profiles roots. `listProfilesFn`
 * is injected (agentusage's `listProfiles`) so this stays testable without the
 * real catalog and fail-open (a throwing list → empty tracked set, so nothing is
 * wrongly excluded from the scan). A managed tracked profile (configured AND not
 * reserved) is expected and omitted; everything else is reported.
 */
export function findShadowProfileDirs(
  listProfilesFn: () => string[],
  homeDir: string = homedir(),
): ShadowProfileFinding[] {
  const configuredNames = new Set(
    safeList(listProfilesFn).map((n) => n.trim().normalize("NFC")),
  );
  const findings: ShadowProfileFinding[] = [];
  for (const { agent, rootName } of PROFILE_ROOTS) {
    scanRoot(join(homeDir, rootName), agent, configuredNames, findings);
  }
  appendCanonicalTierFinding(homeDir, findings);
  return findings;
}

/**
 * Inspect the native `~/.claude` account (claude only — pi carries no tier) and
 * append a distinct tier-unresolved finding when it is authed but its tier is
 * unresolvable. Not a profiles-root dir, so it carries no shadow/tracked
 * semantics; `name` is the canonical `.claude` basename. Unauthed / resolved /
 * absent all add nothing.
 */
function appendCanonicalTierFinding(
  homeDir: string,
  findings: ShadowProfileFinding[],
): void {
  const state = classifyCanonicalClaudeTier(
    join(homeDir, ".claude", ".claude.json"),
  );
  if (state !== "tier-unresolved") {
    return;
  }
  findings.push({
    agent: "claude",
    name: ".claude",
    hasAuth: true,
    isReservedShadow: false,
    tracked: false,
    tierUnresolved: true,
  });
}

type CanonicalClaudeTierState = "unauthed" | "resolved" | "tier-unresolved";

/**
 * Classify the native `~/.claude` account's tier from its `.claude.json`,
 * mirroring the scraper's `parseTierMultiplier` predicate EXACTLY (shared cap +
 * {@link resolveTierMultiplier}) minus the missing-`oauthAccount` arm:
 *
 *  - `unauthed`  — no `oauthAccount` object is readable (file missing /
 *    unparseable / not an object / no `oauthAccount`). That is "not authed
 *    here", a different state — NOT this finding.
 *  - `resolved`  — `oauthAccount` present and the tier resolves to a multiplier.
 *  - `tier-unresolved` — authed but the tier is unresolvable (file oversize, or
 *    the tier is absent / non-string / an unknown key). This is what renders
 *    `?x` in `keeper usage`. Oversize bails before the read just like the
 *    scraper, so it can't confirm `oauthAccount`, but the scraper renders `?x`
 *    for it too — mirror that to keep the two surfaces in agreement.
 *
 * Never throws.
 */
function classifyCanonicalClaudeTier(
  claudeJsonPath: string,
): CanonicalClaudeTierState {
  let size: number;
  try {
    size = statSync(claudeJsonPath).size;
  } catch {
    return "unauthed";
  }
  if (size > MAX_CLAUDE_JSON_BYTES) {
    return "tier-unresolved";
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
  } catch {
    return "unauthed";
  }
  if (!isRecord(data) || !isRecord(data.oauthAccount)) {
    return "unauthed";
  }
  return resolveTierMultiplier(data.oauthAccount.organizationRateLimitTier) !=
    null
    ? "resolved"
    : "tier-unresolved";
}

function scanRoot(
  root: string,
  agent: ShadowProfileAgent,
  configuredNames: ReadonlySet<string>,
  findings: ShadowProfileFinding[],
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    // Absent/unreadable root (ENOENT and friends): nothing to scan, not an error.
    return;
  }
  for (const entry of entries) {
    if (!isDirEntry(entry, root)) {
      continue;
    }
    const name = entry.name;
    const normalized = name.normalize("NFC");
    const isReservedShadow = isReservedProfileDirName(name);
    const tracked = configuredNames.has(normalized);
    // A configured, non-reserved profile is a managed dir — expected, skip it.
    if (tracked && !isReservedShadow) {
      continue;
    }
    findings.push({
      agent,
      name,
      hasAuth: hasAuth(agent, join(root, name)),
      isReservedShadow,
      tracked,
    });
  }
}

/** True for a real directory, or a symlink resolving to one. Never throws. */
function isDirEntry(entry: Dirent, root: string): boolean {
  if (entry.isDirectory()) {
    return true;
  }
  if (entry.isSymbolicLink()) {
    try {
      return statSync(join(root, entry.name)).isDirectory();
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Structural auth probe for a profile dir. Claude: a `.credentials.json` file or
 * a `.claude.json` whose top level carries an `oauthAccount` object. Pi: a
 * profile-local `auth.json`. Never reads or logs token contents; any IO/parse
 * failure (including a mid-scan ENOENT) folds to `false`.
 */
function hasAuth(agent: ShadowProfileAgent, entryDir: string): boolean {
  if (existsSync(join(entryDir, ".credentials.json"))) {
    return true;
  }
  if (agent === "pi") {
    return existsSync(join(entryDir, "auth.json"));
  }
  return claudeJsonHasOauth(join(entryDir, ".claude.json"));
}

/** True iff `.claude.json` parses to an object carrying an `oauthAccount` object. */
function claudeJsonHasOauth(claudeJsonPath: string): boolean {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
  } catch {
    // Missing or unparseable: cannot confirm auth from here — not a crash.
    return false;
  }
  return isRecord(data) && isRecord(data.oauthAccount);
}

function safeList(fn: () => string[]): string[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
