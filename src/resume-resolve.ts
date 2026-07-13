/**
 * resume-resolve — disk-anchored resume resolution for crash-restore.
 *
 * The keystone inversion: instead of trusting a candidate's RECORDED cwd (which
 * drifts — a claude session's transcript rehomes to a different project dir, and
 * `claude --resume <uuid>` is scoped to that project dir, so replaying the stale
 * recorded cwd prints "No conversation found" and exits 0), derive the launch
 * cwd from ON-DISK TRUTH: the conversation artifact itself.
 *
 * CLAUDE. Glob `<root>/projects/*<uuid>.jsonl` over the canonical `~/.claude`
 * root (plus any test-injected extras), realpath-deduped. claude-swap's
 * `--share-history` means every account reads/writes the SAME canonical
 * `~/.claude/projects/` tree, so there is no per-account root to disambiguate.
 * Read the found transcript's TAIL for the newest
 * COMPLETE (newline-terminated) line carrying a `cwd` field — torn-tail safe —
 * and prefer a tail cwd whose slug matches its holding dir. Fall back to matching
 * the observed-cwd history against the holding-dir slug. The slug is LOSSY (`/`
 * and `.` both collapse to `-`), so matching is FORWARD-ONLY: compute
 * {@link claudeCwdSlug} of a real path and compare to a holding-dir name — never
 * reverse a holding dir back into a path. Exactly one resolution proceeds; zero
 * matches or an unresolvable multi-match returns a typed preflight failure
 * carrying the found candidates and the one fixing command (never a doomed
 * `--resume` line). A resolved cwd that no longer exists on disk (a torn-down
 * worktree) ALSO fails preflight naming the project dir — never a dropped `cd` or
 * a `$HOME` fallback.
 *
 * PI. Artifact-existence gates: a session file under the cwd's Pi project dir
 * (or anywhere in the sessions tree) matching the resume target. A resume target
 * that names no on-disk artifact is typed not-resumable with a reason rather than
 * launched into a broken resume.
 *
 * All filesystem access rides the injectable {@link ResumeResolveFs} seam — the
 * pure resolution logic is exercised against an in-memory fake, and the
 * production {@link nodeResumeResolveFs} binding catches its own I/O errors so a
 * seam method is TOTAL (never throws). Imports only `node:*` and the dep-free
 * harness registry.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { harnessOrClaude } from "./agent/harness";

/**
 * The injectable filesystem seam. Every method is TOTAL — a binding catches its
 * own I/O errors and returns the empty/false result, so the pure resolution
 * logic never has to guard against a throw.
 */
export interface ResumeResolveFs {
  /** Entry names directly under `dir` (files and subdirs); `[]` when `dir` is
   *  absent, unreadable, or not a directory. */
  listDir(dir: string): string[];
  /** True iff `path` (a file or directory) exists. */
  exists(path: string): boolean;
  /** Canonical realpath of `path` (symlinks resolved) for dedup; returns `path`
   *  unchanged on any error. */
  realpath(path: string): string;
  /** The last up-to-`maxBytes` of `path` as UTF-8 plus whether the read began at
   *  byte 0 (`fromStart` — so the caller knows the first line is complete, not a
   *  torn head). `null` when the file is absent / unreadable / not a file. */
  readTail(
    path: string,
    maxBytes: number,
  ): { text: string; fromStart: boolean } | null;
}

/** The verdict {@link ResumeResolver} returns for one candidate. */
export type ResumeResolution =
  /** Claude: the derived launch cwd (may equal the recorded one). */
  | { kind: "resolved"; cwd: string }
  /** Non-claude: the resume target's on-disk artifact exists — launch as-is. */
  | { kind: "resumable" }
  /** Non-claude: the resume target names no on-disk artifact (or none was
   *  resolved) — reported, never launched. */
  | { kind: "not-resumable"; reason: string }
  /** Claude: the transcript resolution failed (zero-match, unresolvable
   *  multi-match, or a vanished resolved cwd) — no `--resume` line is emitted;
   *  the failure names the found candidates and the one fixing command. */
  | {
      kind: "preflight-failed";
      reason: string;
      found: string[];
      fixCommand: string;
    };

/** The minimal candidate shape the resolver reads — structurally a superset-free
 *  view of `RestoreCandidate`, so this module never imports the restore-set. */
export interface ResumeCandidateLike {
  job_id: string;
  resume_target: string;
  cwd: string | null;
  harness?: string;
}

/** The seam `planRestore` / `renderSnapshotScript` consume: candidate → verdict. */
export type ResumeResolver = (
  candidate: ResumeCandidateLike,
) => ResumeResolution;

/** How much of a transcript tail to read for the newest `cwd`-carrying line.
 *  Generous enough to span several claude lines (each carries a top-level `cwd`)
 *  even when a recent line holds a large tool-output blob. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/**
 * Forward-only claude project-dir slug: `/` and `.` both collapse to `-`. LOSSY
 * by construction — always compute `claudeCwdSlug(realPath)` and compare to a
 * holding-dir NAME; never attempt to decode a holding dir back into a path. Pure.
 */
export function claudeCwdSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** Pi's session-dir encoding — `--<slash-collapsed trimmed cwd>--`. Mirrors the
 *  transcript-watch producer so the existence gate reads the same layout. Pure. */
function encodePiCwd(cwd: string): string {
  const trimmed = cwd.replace(/^\/+|\/+$/g, "");
  return `--${trimmed.replace(/\//g, "-")}--`;
}

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (v !== "" && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Torn-tail-safe: the newest COMPLETE newline-terminated line's `cwd` field from
 * a tail read, or `null`. A line is complete only when it is terminated by a
 * `\n`, so the trailing segment after the last newline (a mid-write partial) is
 * dropped; when the read did not begin at byte 0 (`fromStart` false) the leading
 * segment is also a torn head and dropped. Scans newest→oldest and returns the
 * first line whose parsed JSON object carries a non-empty string `cwd`. Pure.
 */
export function newestTailCwd(tail: {
  text: string;
  fromStart: boolean;
}): string | null {
  const { text, fromStart } = tail;
  if (text === "") {
    return null;
  }
  // Split on `\n`; the LAST element is always incomplete — either the empty
  // string after a final newline, or a torn mid-write partial — so drop it.
  let lines = text.split("\n").slice(0, -1);
  if (!fromStart && lines.length > 0) {
    lines = lines.slice(1); // drop the torn head (read began mid-line).
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const cwd = (parsed as Record<string, unknown>).cwd;
      if (typeof cwd === "string" && cwd !== "") {
        return cwd;
      }
    }
  }
  return null;
}

/** Inputs for {@link resolveClaudeCwd} — the session uuid plus the disk-anchoring
 *  roots and the recorded-cwd hint (demoted to observed-cwd history). */
export interface ClaudeResolveInput {
  /** The claude session UUID — the `<uuid>.jsonl` transcript name and the
   *  `--resume` target. */
  sessionId: string;
  /** The recorded cwd, DEMOTED to a hint (no longer the launch cwd source). */
  recordedCwd: string | null;
  /** Config-dir roots to glob `<root>/projects/*<uuid>.jsonl` over; realpath-
   *  deduped internally (the canonical root plus any test-injected extras). */
  projectRoots: string[];
  /** Observed cwd history (includes the recorded cwd) for the slug fallback. */
  observedCwds: string[];
}

/** One found transcript: its holding-dir name (the slug), the project dir path,
 *  and the transcript path. */
interface FoundTranscript {
  holdingDir: string;
  projectDir: string;
  transcriptPath: string;
}

/**
 * Resolve a claude candidate's launch cwd from on-disk truth. Returns a
 * `resolved` cwd on a confident single resolution, else a typed
 * `preflight-failed` naming the found candidates and the one fixing command.
 * Pure relative to the injected `fs`.
 */
export function resolveClaudeCwd(
  fs: ResumeResolveFs,
  input: ClaudeResolveInput,
): ResumeResolution {
  const uuid = input.sessionId;
  if (uuid === "") {
    return {
      kind: "preflight-failed",
      reason: "claude candidate carries no session id",
      found: [],
      fixCommand: "# no session id — not resumable",
    };
  }

  // 1. Glob <root>/projects/<holdingDir>/<uuid>.jsonl across realpath-deduped roots.
  const found: FoundTranscript[] = [];
  const seenProjects = new Set<string>();
  for (const root of input.projectRoots) {
    if (root === "") {
      continue;
    }
    const projectsDir = join(root, "projects");
    const real = fs.realpath(projectsDir);
    if (seenProjects.has(real)) {
      continue;
    }
    seenProjects.add(real);
    for (const holdingDir of fs.listDir(projectsDir)) {
      const projectDir = join(projectsDir, holdingDir);
      const transcriptPath = join(projectDir, `${uuid}.jsonl`);
      if (fs.exists(transcriptPath)) {
        found.push({ holdingDir, projectDir, transcriptPath });
      }
    }
  }
  if (found.length === 0) {
    const roots = input.projectRoots
      .filter((r) => r !== "")
      .map((r) => join(r, "projects"));
    return {
      kind: "preflight-failed",
      reason: `no claude transcript on disk for session ${uuid}`,
      found: [],
      fixCommand: `# session ${uuid} has no transcript under ${
        roots.join(", ") || "(no roots)"
      }; not resumable`,
    };
  }

  // 2. Prefer a transcript-tail cwd whose slug matches its holding dir.
  const strong = new Set<string>();
  const tailCwds: string[] = [];
  for (const f of found) {
    const tail = fs.readTail(f.transcriptPath, TRANSCRIPT_TAIL_BYTES);
    const cwd = tail === null ? null : newestTailCwd(tail);
    if (cwd !== null) {
      tailCwds.push(cwd);
      if (claudeCwdSlug(cwd) === f.holdingDir) {
        strong.add(cwd);
      }
    }
  }

  // Exactly one confident tail cwd wins; otherwise fall back to the observed-cwd
  // history whose slug matches a holding dir. Zero or multiple ⇒ unresolvable.
  let resolved: string | null = null;
  if (strong.size === 1) {
    resolved = [...strong][0] ?? null;
  } else if (strong.size === 0) {
    resolved = resolveFromHistory(input.observedCwds, found);
  }

  if (resolved !== null) {
    // Risk guard: a resolved cwd that no longer exists (a torn-down worktree)
    // must fail preflight naming the project dir — never a dropped `cd` / $HOME.
    if (!fs.exists(resolved)) {
      return {
        kind: "preflight-failed",
        reason: `resolved cwd ${resolved} for session ${uuid} no longer exists on disk`,
        found: found.map((f) => f.projectDir),
        fixCommand: `# restore the directory ${resolved} (project dir ${
          found[0]?.projectDir ?? ""
        }) then: claude --resume "${uuid}"`,
      };
    }
    return { kind: "resolved", cwd: resolved };
  }

  // Unresolvable: zero confident matches or several. Offer the transcript-tail
  // cwds (the human's likely targets), falling back to the found project dirs.
  const distinctTail = uniq(tailCwds);
  const foundList =
    distinctTail.length > 0 ? distinctTail : found.map((f) => f.projectDir);
  return {
    kind: "preflight-failed",
    reason:
      strong.size > 1
        ? `session ${uuid} resolves to multiple candidate cwds — ambiguous`
        : `could not confidently resolve the launch cwd for session ${uuid}`,
    found: foundList,
    fixCommand: claudeFixCommand(uuid, foundList),
  };
}

/** Match the observed-cwd history against the found holding-dir slugs; a single
 *  distinct match resolves, zero or several does not. */
function resolveFromHistory(
  observedCwds: string[],
  found: FoundTranscript[],
): string | null {
  const matches = new Set<string>();
  for (const h of observedCwds) {
    if (h === "") {
      continue;
    }
    const slug = claudeCwdSlug(h);
    if (found.some((f) => f.holdingDir === slug)) {
      matches.add(h);
    }
  }
  return matches.size === 1 ? ([...matches][0] ?? null) : null;
}

/** The one fixing command a human runs to resolve an unresolvable claude
 *  candidate — cd into the first candidate and resume, naming the alternatives. */
function claudeFixCommand(uuid: string, targets: string[]): string {
  if (targets.length === 0) {
    return `# session ${uuid} has no on-disk transcript; not resumable`;
  }
  const [first, ...rest] = targets;
  const base = `cd ${first} && claude --resume "${uuid}"`;
  return rest.length === 0 ? base : `${base}   # or one of: ${rest.join(", ")}`;
}

/** Inputs for {@link resolveNonClaudeArtifact}. */
export interface NonClaudeResolveInput {
  harness: "pi";
  resumeTarget: string;
  cwd: string | null;
  homeDir: string;
  env: Record<string, string | undefined>;
}

/**
 * Existence-gate a non-claude candidate's resume target: a present on-disk
 * artifact is `resumable`, a missing one is typed `not-resumable` with a reason
 * (never a broken launch). Pure relative to the injected `fs`.
 */
export function resolveNonClaudeArtifact(
  fs: ResumeResolveFs,
  input: NonClaudeResolveInput,
): ResumeResolution {
  // Keep a runtime guard despite the narrow type: persisted rows and JavaScript
  // callers are untrusted at this boundary. Only Pi has a non-Claude artifact
  // store; an unregistered value is an ordinary unsupported-harness failure.
  const harness = harnessOrClaude(input.harness);
  if (harness !== "pi") {
    throw new Error(`harness '${harness}' has no non-Claude resume resolver`);
  }
  if (input.resumeTarget === "") {
    return {
      kind: "not-resumable",
      reason: "pi session has no resolved resume target",
    };
  }
  return piArtifact(fs, input);
}

function piArtifact(
  fs: ResumeResolveFs,
  input: NonClaudeResolveInput,
): ResumeResolution {
  const { resumeTarget: target, cwd, homeDir, env } = input;
  const roots = uniq([
    (env.PI_CODING_AGENT_DIR ?? "").trim(),
    join(homeDir, ".pi", "agent"),
  ]);
  for (const root of roots) {
    const sessionsDir = join(root, "sessions");
    // Primary: the cwd-scoped session dir.
    if (cwd != null && cwd !== "") {
      const cwdDir = join(sessionsDir, encodePiCwd(cwd));
      if (fs.listDir(cwdDir).some((n) => n.includes(target))) {
        return { kind: "resumable" };
      }
    }
    // Fallback: a filename carrying the target uuid anywhere one level under
    // sessions/ (the identity drifted off the recorded cwd).
    if (fs.listDir(sessionsDir).some((n) => n.includes(target))) {
      return { kind: "resumable" };
    }
    for (const entry of fs.listDir(sessionsDir)) {
      if (
        fs.listDir(join(sessionsDir, entry)).some((n) => n.includes(target))
      ) {
        return { kind: "resumable" };
      }
    }
  }
  return {
    kind: "not-resumable",
    reason: `pi session ${target} has no on-disk artifact under ${
      roots.map((r) => join(r, "sessions")).join(", ") || "(no pi dir)"
    }`,
  };
}

/** Options for {@link makeResumeResolver} — the seam plus the roots it derives
 *  claude project dirs and harness stores from. */
export interface ResumeResolverOptions {
  fs: ResumeResolveFs;
  homeDir: string;
  env: Record<string, string | undefined>;
  /** Extra claude project roots appended after `CLAUDE_CONFIG_DIR` + `~/.claude`
   *  (tests point these at a fixture tree). */
  extraClaudeRoots?: string[];
}

/**
 * Build a {@link ResumeResolver} from a seam and its roots: a claude candidate
 * routes to {@link resolveClaudeCwd} (disk-anchored cwd), every other harness to
 * {@link resolveNonClaudeArtifact} (existence gate).
 */
export function makeResumeResolver(
  opts: ResumeResolverOptions,
): ResumeResolver {
  const { fs, homeDir, env } = opts;
  const extra = opts.extraClaudeRoots ?? [];
  return (candidate) => {
    const harness = harnessOrClaude(candidate.harness);
    if (harness === "claude") {
      const sessionId =
        candidate.resume_target !== ""
          ? candidate.resume_target
          : candidate.job_id;
      return resolveClaudeCwd(fs, {
        sessionId,
        recordedCwd: candidate.cwd,
        projectRoots: claudeProjectRoots(homeDir, extra),
        observedCwds:
          candidate.cwd != null && candidate.cwd !== "" ? [candidate.cwd] : [],
      });
    }
    return resolveNonClaudeArtifact(fs, {
      harness,
      resumeTarget: candidate.resume_target,
      cwd: candidate.cwd,
      homeDir,
      env,
    });
  };
}

/** The claude project-dir roots: the canonical `~/.claude`, then any
 *  test-injected extras — realpath-deduped downstream. claude-swap's
 *  `--share-history` means every account shares this one canonical root, so
 *  there is no per-account config dir to search. */
function claudeProjectRoots(homeDir: string, extra: string[]): string[] {
  const roots: string[] = [join(homeDir, ".claude")];
  for (const r of extra) {
    if (r !== "") {
      roots.push(r);
    }
  }
  return roots;
}

/** The production {@link ResumeResolveFs} — real `node:fs`, every method total
 *  (its own try/catch degrades an I/O error to the empty/false result). */
export function nodeResumeResolveFs(): ResumeResolveFs {
  return {
    listDir(dir) {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    exists(path) {
      try {
        return existsSync(path);
      } catch {
        return false;
      }
    },
    realpath(path) {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    },
    readTail(path, maxBytes) {
      let fd = -1;
      try {
        const st = statSync(path);
        if (!st.isFile()) {
          return null;
        }
        const size = st.size;
        const start = size > maxBytes ? size - maxBytes : 0;
        const len = size - start;
        const fromStart = start === 0;
        if (len <= 0) {
          return { text: "", fromStart };
        }
        fd = openSync(path, "r");
        const buf = Buffer.allocUnsafe(len);
        let read = 0;
        while (read < len) {
          const n = readSync(fd, buf, read, len - read, start + read);
          if (n <= 0) {
            break;
          }
          read += n;
        }
        return { text: buf.toString("utf8", 0, read), fromStart };
      } catch {
        return null;
      } finally {
        if (fd >= 0) {
          try {
            closeSync(fd);
          } catch {
            // best-effort close.
          }
        }
      }
    },
  };
}

/** The default production resolver — real fs, real `$HOME`, real `process.env`.
 *  `planRestore` / `renderSnapshotScript` default to it; tests inject a fake. */
export const defaultResumeResolver: ResumeResolver = makeResumeResolver({
  fs: nodeResumeResolveFs(),
  homeDir: homedir(),
  env: process.env as Record<string, string | undefined>,
});
