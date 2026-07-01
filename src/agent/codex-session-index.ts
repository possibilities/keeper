import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";

export interface CodexSessionNameIndexerOptions {
  codexHome: string;
  threadName: string;
  expectedCwd: string | null;
  startedAtMs: number;
}

interface Candidate {
  id: string;
  cwd: string | null;
  createdAtMs: number;
  mtimeMs: number;
}

/**
 * Poll Codex's rollout directory until the launched session has a persisted id,
 * then append the synthetic display name to Codex's session index. This is
 * fail-soft by design: Codex runs normally if the id never appears.
 */
export function startCodexSessionNameIndexer(
  opts: CodexSessionNameIndexerOptions,
): () => void {
  const threadName = opts.threadName.trim();
  if (!threadName) {
    return () => {};
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const tick = (): void => {
    const id = findCodexSessionId(opts);
    if (id === null) {
      return;
    }
    appendSessionIndexRow(opts.codexHome, id, threadName);
    stop();
  };

  timer = setInterval(tick, 1000);
  timer.unref?.();
  setTimeout(tick, 100).unref?.();
  return stop;
}

export function appendSessionIndexRow(
  codexHome: string,
  id: string,
  threadName: string,
): void {
  const row = {
    id,
    thread_name: threadName,
    updated_at: new Date().toISOString(),
  };
  appendFileSync(
    join(codexHome, "session_index.jsonl"),
    `${JSON.stringify(row)}\n`,
  );
}

/**
 * Extract the codex session uuid from an already-resolved rollout transcript
 * path. Codex names each rollout `rollout-<ts>-<uuid>.jsonl` and the trailing
 * uuid IS the id it later resumes by, so the id the outer capture needs is
 * literally in the filename. Pure string parse (basename only, no FS): a path
 * whose basename is not a `rollout-…-<uuid>.jsonl` shape returns null.
 */
export function codexSessionIdFromRolloutPath(p: string): string | null {
  const name = basename(p);
  if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) {
    return null;
  }
  const match = name.match(
    /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return match?.[1] ?? null;
}

export function findCodexSessionId(
  opts: CodexSessionNameIndexerOptions,
): string | null {
  const candidates = findCandidateSessions(opts);
  if (candidates.length === 0) {
    return null;
  }

  if (opts.expectedCwd !== null) {
    const cwdMatches = candidates.filter((candidate) => {
      return candidate.cwd === opts.expectedCwd;
    });
    if (cwdMatches.length === 1) {
      return cwdMatches[0]?.id ?? null;
    }
    if (cwdMatches.length > 1) {
      return newestCandidate(cwdMatches)?.id ?? null;
    }
  }

  if (candidates.length === 1) {
    return candidates[0]?.id ?? null;
  }
  return null;
}

function findCandidateSessions(
  opts: CodexSessionNameIndexerOptions,
): Candidate[] {
  const root = join(opts.codexHome, "sessions");
  const dirs = sessionDayDirs(root, opts.startedAtMs);
  const candidates: Candidate[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      continue;
    }
    for (const name of safeReadDir(dir)) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) {
        continue;
      }
      const path = join(dir, name);
      const stat = safeStat(path);
      if (stat === null || stat.mtimeMs < opts.startedAtMs - 1000) {
        continue;
      }
      const meta = readSessionMeta(path);
      if (meta === null) {
        continue;
      }
      if (meta.createdAtMs < opts.startedAtMs - 1000) {
        continue;
      }
      candidates.push({ ...meta, mtimeMs: stat.mtimeMs });
    }
  }
  return candidates;
}

function newestCandidate(candidates: Candidate[]): Candidate | null {
  let newest: Candidate | null = null;
  for (const candidate of candidates) {
    if (newest === null || candidate.mtimeMs > newest.mtimeMs) {
      newest = candidate;
    }
  }
  return newest;
}

function sessionDayDirs(root: string, startedAtMs: number): string[] {
  const dirs = new Set<string>();
  for (const date of [new Date(startedAtMs), new Date()]) {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    dirs.add(join(root, year, month, day));
  }
  return [...dirs];
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeStat(path: string): { mtimeMs: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function readSessionMeta(
  path: string,
): { id: string; cwd: string | null; createdAtMs: number } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytes).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.includes('"type":"session_meta"')) {
        continue;
      }
      const parsed = JSON.parse(line) as {
        timestamp?: unknown;
        payload?: { id?: unknown; cwd?: unknown };
      };
      const id = parsed.payload?.id;
      if (typeof id !== "string" || !isUuid(id)) {
        return null;
      }
      const createdAtMs = parseTimestampMs(parsed.timestamp);
      if (createdAtMs === null) {
        return null;
      }
      const cwd = parsed.payload?.cwd;
      return { id, cwd: typeof cwd === "string" ? cwd : null, createdAtMs };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  );
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
