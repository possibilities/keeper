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
  /**
   * The rollout's `SessionMeta.originator` — normally codex's own tag
   * (`"codex-tui"`), but the keeper launcher overrides it to the keeper job id
   * via `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`, so a keeper-launched rollout can be
   * positively attributed by exact id match. NULL when the meta line omits it.
   */
  originator: string | null;
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
  return pickCandidateByCwd(findCandidateSessions(opts), opts.expectedCwd);
}

/**
 * Options for {@link resolveCodexResumeTarget} — the daemon-side back-fill of a
 * tracked codex job's native rollout uuid (its resume target).
 */
export interface CodexResumeResolveOptions {
  codexHome: string;
  /**
   * The keeper job id, which the launcher exports as
   * `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` so the rollout stamps it as its
   * `SessionMeta.originator` — the exact-match attribution key.
   */
  jobId: string;
  /** The launching cwd, for the collision-tolerant fallback. */
  expectedCwd: string | null;
  /** Job launch instant (ms) — the candidate-rollout recency floor. */
  startedAtMs: number;
}

/**
 * Resolve a tracked codex job's native rollout uuid (the id it resumes by),
 * reading ONLY each candidate rollout's `SessionMeta` head line — never session
 * content. Attribution precedence:
 *
 *  1. **Exact originator match** — the launcher exports
 *     `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=jobId`, so a keeper-launched rollout
 *     carries `SessionMeta.originator === jobId`. This positively attributes the
 *     session even when two concurrent codex sessions share a cwd (the case the
 *     name indexer must refuse). A pathological >1 originator match refuses.
 *  2. **cwd + created-at fallback** (override stripped or upstream-removed) — the
 *     same refuse-to-guess-on-same-cwd-collision behavior {@link findCodexSessionId}
 *     uses. An unresolvable session returns null; the caller leaves resume_target
 *     NULL and presence is unaffected.
 */
export function resolveCodexResumeTarget(
  opts: CodexResumeResolveOptions,
): string | null {
  const candidates = findCandidateSessions({
    codexHome: opts.codexHome,
    startedAtMs: opts.startedAtMs,
  });
  const byOriginator = candidates.filter(
    (candidate) => candidate.originator === opts.jobId,
  );
  if (byOriginator.length === 1) {
    return byOriginator[0]?.id ?? null;
  }
  if (byOriginator.length > 1) {
    return null;
  }
  return pickCandidateByCwd(candidates, opts.expectedCwd);
}

/**
 * Pick the one candidate whose cwd matches, refusing to guess on a same-cwd
 * collision (naming the wrong session's rollout is worse than leaving it
 * unnamed — never a newest-by-mtime pick). With no cwd constraint, a sole
 * candidate is unambiguous. Shared by the launcher name indexer and the
 * daemon resume back-fill's fallback path.
 */
function pickCandidateByCwd(
  candidates: Candidate[],
  expectedCwd: string | null,
): string | null {
  if (candidates.length === 0) {
    return null;
  }
  if (expectedCwd !== null) {
    const cwdMatches = candidates.filter((candidate) => {
      return candidate.cwd === expectedCwd;
    });
    if (cwdMatches.length === 1) {
      return cwdMatches[0]?.id ?? null;
    }
    if (cwdMatches.length > 1) {
      return null;
    }
  }
  if (candidates.length === 1) {
    return candidates[0]?.id ?? null;
  }
  return null;
}

function findCandidateSessions(opts: {
  codexHome: string;
  startedAtMs: number;
}): Candidate[] {
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
      candidates.push(meta);
    }
  }
  return candidates;
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

function readSessionMeta(path: string): Candidate | null {
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
      // Head line only (metadata, never session content — codex rollouts can
      // carry secrets). A partially-written meta line (codex collects git fields
      // async) fails the parse and folds to null, tolerated by the caller.
      const parsed = JSON.parse(line) as {
        timestamp?: unknown;
        payload?: { id?: unknown; cwd?: unknown; originator?: unknown };
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
      const originator = parsed.payload?.originator;
      return {
        id,
        cwd: typeof cwd === "string" ? cwd : null,
        createdAtMs,
        originator: typeof originator === "string" ? originator : null,
      };
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
