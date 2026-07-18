#!/usr/bin/env bun
// PreToolUse(Write|Edit|MultiEdit|Bash) wrong-tree write guard.
//
// Sibling of branch-guard and grant-guard. Where branch-guard hard-denies a
// subagent's branch mutation and grant-guard confines an escalation subagent's
// mutations, this hook denies a WORKTREE-LANE worker's write that
// lands in a tracked repo working tree that is NOT its own lane — the mechanical
// half of keeping a shared checkout clean so the repair route stays available.
// Rationale for why a stray write into the shared checkout matters: docs/adr/0025.
//
// Jurisdiction is marker-keyed on the
// launch-injected lane PATH `KEEPER_PLAN_WORKTREE` (realpath-normalized at the
// worker's child boundary, torn down at finalize):
//   - marker absent / empty (serial launches AND the human's own session) →
//     INERT: the hook allows everything (no output).
//   - marker set → the write target must resolve INSIDE the lane, be plan-state
//     (.keeper), or be outside every tracked repo; otherwise DENY.
//
// This is BEST-EFFORT AUDIT, not a security boundary: the Bash write-vector
// extraction is string parsing (redirects, heredocs, tee, sed -i), TOCTOU
// between this check and the write is accepted, and the hook FAILS OPEN on every
// internal error (mirroring branch-guard, INVERTING grant-guard's in-jurisdiction
// fail-closed). It denies via the PreToolUse JSON envelope and always exits 0; it
// NEVER writes host stdout except that one envelope, and logs privately.
//
// node:* imports only (no bun:sqlite, no plan plugin). The git-boundary decision
// walks the filesystem for a `.git` marker — that filesystem probe is injected so
// the decision core stays a pure, in-process-testable seam.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { grantCoversWrite } from "../../../../src/grant-leaf.ts";

// ---------------------------------------------------------------------------
// Payload + envelope types.
// ---------------------------------------------------------------------------

/** The PreToolUse hook payload fields the wrong-tree decision reads. */
export interface WrongTreeGuardPayload {
  tool_name?: string;
  agent_id?: string;
  agent_type?: string;
  cwd?: string;
  tool_input?: {
    command?: string;
    file_path?: string;
    notebook_path?: string;
  };
}

/** A grant-override seam: true when a valid escalation grant authorizes a write
 *  to this already-canonical target, so the wrong-tree deny yields to it. */
export type GrantOverride = (canonicalTarget: string) => boolean;
const NO_GRANT: GrantOverride = () => false;

/** The canonical PreToolUse deny envelope (exit-0 + JSON). */
export interface WrongTreeGuardDenyEnvelope {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

/**
 * The injected filesystem seam. Production wires a node:fs-backed probe; tests
 * pass a fake over a virtual repo layout so the decision core needs no real git.
 */
export interface TreeProbe {
  /** Canonical absolute path of `abs`, resolving symlinks. For a not-yet-existing
   *  (create-new) path, resolve the nearest existing ancestor and re-append the
   *  missing tail. Returns null when even that fails — the fail-open signal. */
  realpath(abs: string): string | null;
  /** The tracked-repo toplevel containing the already-canonical `resolved` — the
   *  nearest ancestor directory holding a `.git` entry (dir OR the worktree's
   *  `.git` file), itself canonical — or null when the path is in no tracked
   *  repo. */
  repoToplevel(resolved: string): string | null;
}

/** Optional private-log sink threaded through the pure core (noop in tests). */
export type LogSink = (record: Record<string, unknown>) => void;
const NOOP_LOG: LogSink = () => {};

// ---------------------------------------------------------------------------
// Path predicates — pure.
// ---------------------------------------------------------------------------

/** Split a canonical absolute path into its segments (no leading empty). */
function segmentsOf(p: string): string[] {
  return p.split("/").filter((s) => s.length > 0);
}

/**
 * The small UNCONDITIONAL denylist enforced regardless of lane — the paths a
 * lane worker may never write even inside its own lane: git's `.git/config`
 * (repo-config injection) and credential-shaped files. Checked BEFORE the
 * own-lane allow, so `<lane>/.git/config` still denies.
 */
export function isProtectedPath(canonical: string): boolean {
  const segs = segmentsOf(canonical);
  for (let i = 0; i + 1 < segs.length; i++) {
    // `.git/config` (the config file directly under a `.git` directory).
    if (segs[i] === ".git" && segs[i + 1] === "config") return true;
    // `.aws/credentials`.
    if (segs[i] === ".aws" && segs[i + 1] === "credentials") return true;
    // Anything under a `.ssh` directory (private keys / known_hosts / config).
    if (segs[i] === ".ssh") return true;
  }
  const base = segs.length > 0 ? (segs[segs.length - 1] as string) : "";
  // Credential-shaped filenames anywhere.
  return base === ".git-credentials" || base === ".netrc";
}

/**
 * True when `canonical` is plan-state under `<toplevel>/.keeper` — legitimately
 * written to the PRIMARY repo (a non-lane tracked tree) by the plan CLI, so it
 * is allowlisted even though its toplevel is not the lane.
 */
export function isKeeperStatePath(
  canonical: string,
  toplevel: string,
): boolean {
  return (
    canonical === `${toplevel}/.keeper` ||
    canonical.startsWith(`${toplevel}/.keeper/`)
  );
}

// ---------------------------------------------------------------------------
// Bash write-vector target extraction — quote-aware, best-effort.
// ---------------------------------------------------------------------------

type BashToken = { kind: "word"; text: string } | { kind: "redir" };

/** Leading wrapper executables whose own tokens are skipped so the WRAPPED
 *  command (tee/sed) is the one classified. Best-effort — a wrapper's option
 *  values are consumed heuristically. */
const BASH_WRAPPERS = new Set([
  "sudo",
  "env",
  "command",
  "exec",
  "builtin",
  "nohup",
  "time",
  "nice",
  "stdbuf",
  "timeout",
  "xargs",
]);

/**
 * Tokenize `command` into segments (split on top-level `; | || && & newline` and
 * `(`/`)`), honoring single/double quotes, recording write-redirect operators
 * (`>`, `>>`, `>|`, `&>`, `&>>`, `N>`) as their own `redir` marker so the
 * following word is a redirect TARGET. Read redirects (`<`) contribute no target;
 * a heredoc (`<<DELIM`) additionally has its body SKIPPED so body text is never
 * mis-parsed as commands (which could mint a spurious target).
 */
function tokenizeSegments(command: string): BashToken[][] {
  const segments: BashToken[][] = [];
  let seg: BashToken[] = [];
  let word = "";
  let hasWord = false;
  let inSingle = false;
  let inDouble = false;

  const flushWord = (): void => {
    if (hasWord) {
      seg.push({ kind: "word", text: word });
      word = "";
      hasWord = false;
    }
  };
  const endSeg = (): void => {
    flushWord();
    if (seg.length > 0) {
      segments.push(seg);
      seg = [];
    }
  };
  const dropFdPrefixOrFlush = (): void => {
    // A leading fd number (`2>`) is not a real argument — drop it; otherwise
    // flush the accumulated word before the redirect operator.
    if (hasWord && /^[0-9]+$/.test(word)) {
      word = "";
      hasWord = false;
    } else {
      flushWord();
    }
  };

  const n = command.length;
  for (let i = 0; i < n; i++) {
    const c = command[i] as string;
    const next = i + 1 < n ? (command[i + 1] as string) : "";

    if (inSingle) {
      if (c === "'") inSingle = false;
      else {
        word += c;
        hasWord = true;
      }
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      else if (
        c === "\\" &&
        (next === '"' || next === "\\" || next === "$" || next === "`")
      ) {
        word += next;
        hasWord = true;
        i++;
      } else {
        word += c;
        hasWord = true;
      }
      continue;
    }

    // --- unquoted ---
    if (c === "'") {
      inSingle = true;
      hasWord = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      hasWord = true;
      continue;
    }
    if (c === "\\") {
      if (next !== "") {
        word += next;
        hasWord = true;
        i++;
      }
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      flushWord();
      continue;
    }
    if (c === "\n" || c === ";") {
      endSeg();
      continue;
    }
    if (c === "|") {
      endSeg();
      if (next === "|") i++;
      continue;
    }
    if (c === "(" || c === ")") {
      endSeg();
      continue;
    }
    if (c === "&") {
      if (next === ">") {
        dropFdPrefixOrFlush();
        i++; // consume '>'
        if (command[i + 1] === ">") i++; // `&>>`
        seg.push({ kind: "redir" });
        continue;
      }
      endSeg();
      if (next === "&") i++;
      continue;
    }
    if (c === ">") {
      dropFdPrefixOrFlush();
      if (next === ">" || next === "|") i++; // `>>` / `>|`
      seg.push({ kind: "redir" });
      continue;
    }
    if (c === "<") {
      dropFdPrefixOrFlush();
      if (next === "<") {
        if (command[i + 2] === "<") {
          // here-string `<<<`: operator only, following word is data (no target).
          i += 2;
          continue;
        }
        // heredoc `<<[-]DELIM`: skip the delimiter and the entire body so body
        // text is never re-tokenized as commands.
        i = skipHeredoc(command, i);
        continue;
      }
      // single `<` read redirect: operator only, no write target.
      continue;
    }
    word += c;
    hasWord = true;
  }
  endSeg();
  return segments;
}

/**
 * Given `command` positioned at the first `<` of a `<<` heredoc, parse the
 * delimiter and fast-forward past the heredoc body, returning the index of the
 * last consumed char (the caller's loop `i++` resumes after it). Best-effort: an
 * unterminated heredoc consumes to end-of-string.
 */
function skipHeredoc(command: string, ltLt: number): number {
  const n = command.length;
  let j = ltLt + 2; // past both `<`
  if (command[j] === "-") j++; // `<<-`
  while (j < n && (command[j] === " " || command[j] === "\t")) j++;
  // Read the delimiter (quotes/backslash strip, stop at whitespace/operators).
  let delim = "";
  let quote = "";
  while (j < n) {
    const ch = command[j] as string;
    if (quote) {
      if (ch === quote) quote = "";
      else delim += ch;
      j++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      j++;
      continue;
    }
    if (ch === "\\") {
      j++;
      if (j < n) {
        delim += command[j];
        j++;
      }
      continue;
    }
    if (
      ch === " " ||
      ch === "\t" ||
      ch === "\n" ||
      ch === ";" ||
      ch === "&" ||
      ch === "|" ||
      ch === ")"
    ) {
      break;
    }
    delim += ch;
    j++;
  }
  // Advance to end of the current (opening) line.
  while (j < n && command[j] !== "\n") j++;
  if (delim === "") return j;
  // Skip body lines until one trims to the delimiter.
  let k = j;
  while (k < n) {
    const lineStart = k + 1;
    let lineEnd = lineStart;
    while (lineEnd < n && command[lineEnd] !== "\n") lineEnd++;
    if (command.slice(lineStart, lineEnd).trim() === delim) return lineEnd;
    if (lineEnd >= n) return n;
    k = lineEnd;
  }
  return n;
}

/** The command word of a segment (after env-assignment and wrapper stripping)
 *  plus its trailing args, or null when the segment has no command word. */
function commandOf(words: string[]): { cmd: string; args: string[] } | null {
  let i = 0;
  while (
    i < words.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string)
  )
    i++;
  while (i < words.length && BASH_WRAPPERS.has(words[i] as string)) {
    const w = words[i] as string;
    i++;
    if (w === "timeout" || w === "nice" || w === "stdbuf" || w === "xargs") {
      while (i < words.length && (words[i] as string).startsWith("-")) i++;
      if (
        w === "timeout" &&
        i < words.length &&
        /^[0-9]/.test(words[i] as string)
      )
        i++;
    } else if (w === "env") {
      while (
        i < words.length &&
        (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string) ||
          (words[i] as string).startsWith("-"))
      )
        i++;
    }
  }
  if (i >= words.length) return null;
  return { cmd: words[i] as string, args: words.slice(i + 1) };
}

/** Append the in-place file operands of a `sed -i` (best-effort) to `out`. */
function pushSedInPlaceTargets(args: string[], out: string[]): void {
  let inPlace = false;
  let hasScriptFlag = false;
  const nonFlags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (
      a === "-i" ||
      a === "--in-place" ||
      a.startsWith("--in-place=") ||
      (a.startsWith("-i") && !a.startsWith("--"))
    ) {
      inPlace = true;
      continue;
    }
    if (a === "-e" || a === "--expression" || a === "-f" || a === "--file") {
      hasScriptFlag = true;
      i++; // consume the script/file value
      continue;
    }
    if (a.startsWith("--expression=") || a.startsWith("--file=")) {
      hasScriptFlag = true;
      continue;
    }
    if (a.startsWith("-")) continue; // other sed flags (-n/-r/-E/-s/-z)
    nonFlags.push(a);
  }
  if (!inPlace) return;
  // Without an explicit -e/-f script flag, sed's first positional is the inline
  // script, not a file — drop it.
  const files = hasScriptFlag ? nonFlags : nonFlags.slice(1);
  for (const f of files) out.push(f);
}

/**
 * Best-effort extraction of every write-TARGET path from a Bash command's write
 * vectors: `>`-family redirect targets (which also covers `cat > f <<EOF`
 * heredocs), `tee` operands, and `sed -i` in-place file operands. Read-only
 * commands yield no target. String parsing by explicit best-effort discipline.
 */
export function extractBashTargets(command: string): string[] {
  if (command.length > 200_000) return []; // pathological payload → best-effort skip
  const targets: string[] = [];
  for (const seg of tokenizeSegments(command)) {
    for (let k = 0; k < seg.length; k++) {
      const tok = seg[k];
      if (tok && tok.kind === "redir") {
        const nxt = seg[k + 1];
        if (
          nxt &&
          nxt.kind === "word" &&
          nxt.text.length > 0 &&
          !nxt.text.startsWith("&") // `>&1` is an fd dup, not a file
        ) {
          targets.push(nxt.text);
        }
      }
    }
    const words = seg
      .filter((t): t is { kind: "word"; text: string } => t.kind === "word")
      .map((t) => t.text);
    const co = commandOf(words);
    if (co === null) continue;
    if (co.cmd === "tee") {
      for (const a of co.args) if (!a.startsWith("-")) targets.push(a);
    } else if (co.cmd === "sed" || co.cmd === "gsed") {
      pushSedInPlaceTargets(co.args, targets);
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Target collection per tool.
// ---------------------------------------------------------------------------

/** The raw (possibly relative) write-target paths this payload would touch. */
export function collectTargets(payload: WrongTreeGuardPayload): string[] {
  const tool = payload.tool_name;
  if (tool === "Bash") {
    return extractBashTargets(payload.tool_input?.command ?? "");
  }
  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit") {
    const fp = payload.tool_input?.file_path;
    return typeof fp === "string" && fp.length > 0 ? [fp] : [];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Deny reasons + envelope.
// ---------------------------------------------------------------------------

function denyEnvelope(reason: string): WrongTreeGuardDenyEnvelope {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function wrongTreeReason(
  target: string,
  toplevel: string,
  lane: string,
): string {
  return (
    `Worktree-lane write BLOCKED: '${target}' lands in tracked repo '${toplevel}', ` +
    `which is not this worker's lane '${lane}'. A worktree-mode worker must write ` +
    `only inside its own lane (plan state under .keeper is exempt). Edit the file ` +
    `inside the lane; the orchestrator owns any cross-tree change.`
  );
}

function protectedReason(target: string): string {
  return (
    `Worktree-lane write BLOCKED: '${target}' is a protected git-config / ` +
    `credential path, denied for a lane worker regardless of lane.`
  );
}

// ---------------------------------------------------------------------------
// Pure decision core.
// ---------------------------------------------------------------------------

/** Classify one raw target path; returns a deny reason or null (allow). */
function classifyTarget(
  raw: string,
  cwd: string,
  laneReal: string,
  probe: TreeProbe,
  log: LogSink,
  grantOverride: GrantOverride,
): string | null {
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const resolved = probe.realpath(abs);
  if (resolved === null) {
    log({ event: "unresolvable", target: raw });
    return null; // fail open on an unresolvable target
  }
  if (isProtectedPath(resolved)) {
    const reason = protectedReason(raw);
    log({ event: "deny", kind: "protected", target: raw, resolved });
    return reason;
  }
  const toplevel = probe.repoToplevel(resolved);
  if (toplevel === null) return null; // outside every tracked repo → allow
  if (isKeeperStatePath(resolved, toplevel)) return null; // plan state → allow
  if (toplevel === laneReal) return null; // own lane → allow
  // An escalation subagent with a valid grant covering this exact target writes
  // into the shared checkout legitimately — its grant overrides the wrong-tree
  // deny (protected paths above are already excluded from any grant).
  if (grantOverride(resolved)) {
    log({ event: "grant-allow", target: raw, resolved, toplevel });
    return null;
  }
  const reason = wrongTreeReason(raw, toplevel, laneReal);
  log({ event: "deny", kind: "wrong-tree", target: raw, resolved, toplevel });
  return reason;
}

/**
 * Pure decision: the deny envelope for this (payload, env), or null to allow (no
 * output). Inert (allow) unless `KEEPER_PLAN_WORKTREE` is set non-empty. Fails
 * OPEN on any resolution gap — this is best-effort audit, not a boundary.
 */
export function decideWrongTreeGuard(
  payload: WrongTreeGuardPayload,
  env: Record<string, string | undefined>,
  probe: TreeProbe,
  log: LogSink = NOOP_LOG,
  grantOverride: GrantOverride = NO_GRANT,
): WrongTreeGuardDenyEnvelope | null {
  const lane = (env.KEEPER_PLAN_WORKTREE ?? "").trim();
  if (lane === "") return null; // unmarked (serial / human) → inert-allow
  if (payload === null || typeof payload !== "object") return null; // fail open
  const laneReal = probe.realpath(lane);
  if (laneReal === null) {
    log({ event: "lane-unresolvable", lane });
    return null; // cannot resolve the lane → fail open
  }
  const cwd =
    typeof payload.cwd === "string" && payload.cwd.length > 0
      ? payload.cwd
      : lane;
  for (const raw of collectTargets(payload)) {
    const reason = classifyTarget(
      raw,
      cwd,
      laneReal,
      probe,
      log,
      grantOverride,
    );
    if (reason !== null) return denyEnvelope(reason);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Production filesystem probe (node:fs).
// ---------------------------------------------------------------------------

/** Canonicalize `abs`, falling back to the nearest existing ancestor + missing
 *  tail for a create-new path; null when nothing on the chain resolves. */
function realpathNearest(abs: string): string | null {
  try {
    return realpathSync(abs);
  } catch {
    const tail: string[] = [];
    let cur = abs;
    for (let guard = 0; guard < 4096; guard++) {
      const parent = dirname(cur);
      if (parent === cur) return null; // reached filesystem root unresolved
      tail.unshift(basename(cur));
      cur = parent;
      try {
        return join(realpathSync(cur), ...tail);
      } catch {
        // keep walking up
      }
    }
    return null;
  }
}

/** The nearest ancestor directory of the already-canonical `resolved` holding a
 *  `.git` entry (a worktree's `.git` FILE counts), or null when none. */
function repoToplevelOf(resolved: string): string | null {
  let cur: string;
  try {
    cur =
      existsSync(resolved) && statSync(resolved).isDirectory()
        ? resolved
        : dirname(resolved);
  } catch {
    cur = dirname(resolved);
  }
  for (let guard = 0; guard < 4096; guard++) {
    try {
      if (existsSync(join(cur, ".git"))) return cur;
    } catch {
      // treat a probe error as "no marker here" and keep walking up
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/** The node:fs-backed probe wired into production. */
export function fsProbe(): TreeProbe {
  return {
    realpath: realpathNearest,
    repoToplevel: repoToplevelOf,
  };
}

// ---------------------------------------------------------------------------
// Private logging — single-line JSON, size-bounded, NEVER host stdout.
// ---------------------------------------------------------------------------

function logPath(env: Record<string, string | undefined>): string {
  const override = (env.KEEPER_WRONG_TREE_GUARD_LOG ?? "").trim();
  if (override !== "") return override;
  return join(homedir(), ".local", "state", "keeper", "wrong-tree-guard.log");
}

function makeLogSink(env: Record<string, string | undefined>): LogSink {
  return (record) => {
    try {
      const p = logPath(env);
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      let line = JSON.stringify({ ts: new Date().toISOString(), ...record });
      if (line.length > 4096) line = `${line.slice(0, 4096)}…`;
      appendFileSync(p, `${line}\n`, { mode: 0o600 });
    } catch {
      // best-effort; a logging failure is never fatal and never surfaces.
    }
  };
}

// ---------------------------------------------------------------------------
// Entry point — always exit 0; fail OPEN on any internal error.
// ---------------------------------------------------------------------------

/** Read all of stdin as text. `Bun.stdin.stream()` avoids the macOS
 *  `process.stdin` buffer-until-close hang (Bun #18239). */
async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

async function main(): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    raw = "";
  }
  let payload: WrongTreeGuardPayload | null = null;
  try {
    payload = JSON.parse(raw) as WrongTreeGuardPayload;
  } catch {
    payload = null;
  }
  if (payload === null) return; // malformed → fail open (no output)
  const now = Date.now();
  const decision = decideWrongTreeGuard(
    payload,
    env,
    fsProbe(),
    makeLogSink(env),
    (canonicalTarget) =>
      grantCoversWrite(env, payload?.agent_type, canonicalTarget, now),
  );
  if (decision !== null) {
    process.stdout.write(`${JSON.stringify(decision)}\n`);
  }
}

if (import.meta.main) {
  main().catch(() => {
    // Fail open: any dispatcher-internal error must let the tool call proceed.
  });
}
