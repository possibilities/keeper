/**
 * Read-only shadow/stray profile-dir detector. Scans `~/.claude-profiles` and
 * `~/.pi-profiles` for dirs that are NOT a tracked managed profile: reserved
 * shadows (a `default`/`auto` basename that collides with the native `~/.claude`
 * / `~/.pi` account — `default` strands a login nothing reads) and untracked
 * strays (a leftover dir agentusage's config no longer lists). Purely
 * diagnostic — it NEVER moves, deletes, or otherwise mutates the filesystem.
 *
 * Robustness: a vanished entry (mid-scan ENOENT) or an unparseable
 * `.claude.json` is a finding-or-skip, never a crash — scanning continues. Auth
 * presence is probed structurally (a `.credentials.json` file, or a
 * `.claude.json` carrying an `oauthAccount` object — the read shape mirrors the
 * usage scraper); token CONTENTS are never read or logged.
 *
 * DB-free leaf: imports only `node:fs`/`node:os`/`node:path` + the dep-free
 * `usage-picker` (`listProfiles`) and `state-sharing`
 * (`isReservedProfileDirName`), so both the `keeper agent` launcher and
 * `cli/usage.ts` can import it without dragging `src/db.ts` onto a cold path.
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
  return findings;
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
