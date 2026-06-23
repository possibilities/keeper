#!/usr/bin/env bun
/**
 * Keeper docs sidecar-writer hook (fn-884). A fail-open `PostToolUse` hook that
 * owns the `~/docs` metadata sidecar — the machinery relocated out of arthack's
 * `post_tool_use.ts` so the keeper plugin is the single owner of `~/docs`
 * control-data.
 *
 * Two jobs, both gated on the payload (the hooks.json matchers are tool-name,
 * NOT path, so the hook self-gates on path/command):
 *  - **Write to `~/docs/*.md`** → create-or-merge the doc's `.yaml` sidecar.
 *    The `.md` body is NEVER touched (the whole point of the migration: machine
 *    metadata lives ONLY in the sidecar now).
 *  - **Bash `gh gist create <doc>.md ...`** → parse the gist URL out of the
 *    tool-response and upsert `gist-url:` into the matching `.md`'s sidecar.
 *
 * It is ALSO the sole owner of `~/docs` git state (fn-885): after the sidecar
 * write (Write) — and on Edit/MultiEdit to a doc, and on a `rm`/`mv`/`git rm`
 * delete of one — it commits the dirty `~/docs` paths immediately, pathspec-
 * scoped, with a mechanical `docs: write|update|delete <relpath>` subject. The
 * commit is fail-open: a commit failure logs to stderr and the hook still
 * exits 0 (the sidecar write already succeeded).
 *
 * Hard guarantees (mirrors events-writer.ts):
 * - **Always exit 0** — even on parse failure, write failure, or any thrown
 *   exception, including `uncaughtException`/`unhandledRejection`. A hook MUST
 *   NOT block Claude; a non-zero exit can fail-CLOSE the human's session, which
 *   is far worse than a missed sidecar.
 * - **Minimal, dep-free import graph** — `node:fs`/`node:os`/`node:path`, the
 *   pure `src/derivers.ts` `tokenizeShell`, and the dep-free `src/sidecar.ts`.
 *   NO `bun:sqlite`, NO `src/db.ts`, NO `claudectl`: every import borrows from
 *   the cold-start budget.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  extractBashMutation,
  extractMutationPath,
  tokenizeShell,
} from "../../../../src/derivers";
import {
  CommitFailed,
  commitDocsPaths,
  type DocCommitVerb,
} from "../../../../src/doc-commit";
import {
  atomicWrite,
  extractGistUrl,
  loadSidecar,
  mergeSidecarFields,
  serializeSidecar,
  sidecarPathFor,
  upsertGistUrl,
} from "../../../../src/sidecar";

/**
 * Pull a string field from the payload, or null. Defensive against non-string
 * values — Claude Code occasionally puts objects in documented-string fields.
 * Mirrors events-writer.ts `strField`.
 */
function strField(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === "string" ? v : null;
}

/**
 * Resolve the `~/docs` directory. `KEEPER_DOCS_DIR` env wins (hermetic tests
 * point it at a tmpdir); otherwise default to `~/docs`. Mirrors
 * events-writer.ts `resolveEventsLogDir`'s env-override pattern.
 */
function resolveDocsDir(): string {
  const override = process.env.KEEPER_DOCS_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), "docs");
}

/**
 * Read all of stdin as a UTF-8 string. The hook payload is small (kilobytes);
 * a truncated/empty payload throws on `JSON.parse` and is caught by the outer
 * guard. Mirrors events-writer.ts `readStdin`.
 */
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** True when `path` is a `.md` directly under (any depth of) the docs dir. */
export function isDocsMarkdown(path: string, docsDir: string): boolean {
  if (!path.endsWith(".md")) {
    return false;
  }
  const prefix = docsDir.endsWith("/") ? docsDir : `${docsDir}/`;
  return path.startsWith(prefix);
}

/** `date +%Y-%m-%dT%H:%M:%S%z` parity: local time with a ±HHMM offset. */
export function isoWithOffset(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const stamp =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `${stamp}${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}

/**
 * Best-effort `git -C <cwd> rev-parse ...` → trimmed stdout, or null on ANY
 * failure (not a git repo, git missing, timeout). A single wrapped call per
 * field; never throws. No `claudectl`.
 */
function gitField(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      encoding: "utf8",
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Build the scalar fields for a doc's sidecar from the PostToolUse payload.
 * `created` is stamped now (merge preserves an existing one). `git-branch` /
 * `git-commit` are best-effort and OMITTED on any failure. Only emits the
 * fields it can resolve — a missing `session_id`/`cwd` just omits its line.
 */
export function buildSidecarFields(
  mdPath: string,
  data: Record<string, unknown>,
  now: Date,
  gitProbe: (cwd: string, args: string[]) => string | null,
): Map<string, string> {
  const fields = new Map<string, string>();
  fields.set("path", mdPath);
  fields.set("type", "doc");
  fields.set("created", isoWithOffset(now));

  const sessionId = strField(data, "session_id");
  const cwd = strField(data, "cwd");
  if (sessionId) {
    fields.set("session-id", sessionId);
  }
  if (cwd) {
    fields.set("cwd", cwd);
    const branch = gitProbe(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch) {
      fields.set("git-branch", branch);
    }
    const commit = gitProbe(cwd, ["rev-parse", "--short", "HEAD"]);
    if (commit) {
      fields.set("git-commit", commit);
    }
  }
  if (sessionId && cwd) {
    fields.set("resume", `cd ${cwd} && claude --resume ${sessionId}`);
  }
  return fields;
}

/**
 * Extract `.md` file-path arguments from a `gh gist create ...` command. Reuses
 * the shared {@link tokenizeShell} (no second hand-rolled splitter), then drops
 * flags and the values of value-bearing flags (`-d`/`--desc`/`-f`/`--filename`).
 * Returns absolute-or-as-written paths; the caller resolves them.
 */
const GIST_FLAGS_WITH_VALUE = new Set(["-d", "--desc", "-f", "--filename"]);

export function extractGistFileArgs(command: string): string[] {
  const tokens = tokenizeShell(command);
  // Find the `gh gist create` head.
  let i = 0;
  while (
    i < tokens.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")
  ) {
    i++;
  }
  if (
    tokens[i] !== "gh" ||
    tokens[i + 1] !== "gist" ||
    tokens[i + 2] !== "create"
  ) {
    return [];
  }
  const files: string[] = [];
  let skipNext = false;
  for (let j = i + 3; j < tokens.length; j++) {
    const t = tokens[j] as string;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (GIST_FLAGS_WITH_VALUE.has(t)) {
      skipNext = true;
      continue;
    }
    if (t.startsWith("-")) {
      continue;
    }
    files.push(t);
  }
  return files;
}

/** Resolve a path arg: expand a leading `~`, else lexically join to cwd. */
function resolveArg(p: string, cwd: string | null): string {
  const home = homedir();
  if (p === "~") {
    return home;
  }
  if (p.startsWith("~/")) {
    return join(home, p.slice(2));
  }
  if (p.startsWith("/")) {
    return p;
  }
  if (cwd && cwd.length > 0) {
    return join(cwd, p);
  }
  return p;
}

/**
 * Write/merge a doc's sidecar. Loads any existing sidecar, merges the incoming
 * fields (preserving `created`), and atomically writes it back. Never touches
 * the `.md`.
 */
function writeDocSidecar(mdPath: string, data: Record<string, unknown>): void {
  const sidecarPath = sidecarPathFor(mdPath);
  const incoming = buildSidecarFields(mdPath, data, new Date(), gitField);
  const existing = loadSidecar(sidecarPath);
  const merged = mergeSidecarFields(existing, incoming);
  atomicWrite(sidecarPath, serializeSidecar(merged));
}

/**
 * Pull the gist URL out of a PostToolUse:Bash tool-response. Bash responses
 * carry `stdout`/`stderr` strings; the created URL lands on stdout. Bounded
 * match (no JSON-tail swallow).
 */
function gistUrlFromResponse(data: Record<string, unknown>): string | null {
  const resp = data.tool_response;
  if (typeof resp !== "object" || resp === null) {
    return null;
  }
  const r = resp as Record<string, unknown>;
  for (const key of ["stdout", "stderr"]) {
    const v = r[key];
    if (typeof v === "string" && v.length > 0) {
      const url = extractGistUrl(v);
      if (url) {
        return url;
      }
    }
  }
  return null;
}

/**
 * Handle a `gh gist create` Bash event: resolve each `.md` file arg, and for
 * any that is a tracked docs `.md` with an existing sidecar, upsert the gist
 * URL into ITS SIDECAR ONLY (never the `.md`).
 */
function handleGistCreate(
  data: Record<string, unknown>,
  docsDir: string,
): void {
  const toolInput = data.tool_input;
  if (typeof toolInput !== "object" || toolInput === null) {
    return;
  }
  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command !== "string" || command.length === 0) {
    return;
  }
  if (!/(?:^|[;&|]\s*)gh\s+gist\s+create(?:\s|$)/.test(command)) {
    return;
  }
  const url = gistUrlFromResponse(data);
  if (!url) {
    return;
  }
  const cwd = strField(data, "cwd");
  for (const arg of extractGistFileArgs(command)) {
    const path = resolveArg(arg, cwd);
    if (!isDocsMarkdown(path, docsDir)) {
      continue;
    }
    const sidecarPath = sidecarPathFor(path);
    if (!existsSync(sidecarPath)) {
      continue;
    }
    const updated = upsertGistUrl(loadSidecar(sidecarPath), url);
    atomicWrite(sidecarPath, serializeSidecar(updated));
  }
}

/**
 * Commit `paths` in the docs repo (which IS `docsDir` — `~/docs` is its own git
 * repo). Fail-open: a {@link CommitFailed} (status/add/commit error, contention
 * exhaustion) logs to stderr and returns, never propagating up to abort the
 * already-succeeded sidecar write. Non-`CommitFailed` errors (a programming
 * bug) rethrow to the outer exit-0 guard. The committer self-skips a clean tree,
 * a mid-operation repo, and a detached/unborn HEAD — so a non-repo docs dir, a
 * mid-rebase, etc. all no-op cleanly.
 */
function commitDocsFailOpen(
  paths: string[],
  docsDir: string,
  verb: DocCommitVerb,
): void {
  if (paths.length === 0) {
    return;
  }
  try {
    commitDocsPaths({ paths, repoRoot: docsDir, verb });
  } catch (err) {
    if (err instanceof CommitFailed) {
      process.stderr.write(
        `keeper sidecar-writer: docs commit skipped: ${err}\n`,
      );
      return;
    }
    throw err;
  }
}

/** The commit-routing decision for a PostToolUse payload: which paths to commit
 * under which subject verb, or null for no commit. Pure given `exists`. */
export interface DocsCommitPlan {
  paths: string[];
  verb: DocCommitVerb;
}

/**
 * Decide what the sidecar-writer would commit for a PostToolUse `data` payload
 * — the pure routing the hook applies BEFORE it shells git. Returns the commit
 * plan (paths + subject verb) or null (no commit). `exists` is injected so the
 * decision is testable in-process with zero filesystem reads and zero git:
 *  - Write to a docs `.md` → commit `[md, sidecar]` as `write`;
 *  - Edit/MultiEdit to a docs `.md` → commit `[md]` as `update`;
 *  - Bash rm/mv/git-rm/git-mv of docs targets → commit them as `delete`;
 *  - anything outside the docs dir, or a non-existent target → null.
 * The gist-URL upsert is a sidecar-only side effect with no commit, so it is
 * intentionally NOT part of this decision.
 */
export function decideDocsCommit(
  data: Record<string, unknown>,
  docsDir: string,
  exists: (path: string) => boolean,
): DocsCommitPlan | null {
  const toolName = strField(data, "tool_name");

  if (toolName === "Write") {
    const filePath = extractMutationPath("PostToolUse", toolName, data);
    if (!filePath || !isDocsMarkdown(filePath, docsDir) || !exists(filePath)) {
      return null;
    }
    // Commit the doc + its sidecar together; `dirtyFilesForPathspecs` scopes to
    // whatever is actually dirty. A Write reads as `write` regardless of whether
    // the doc pre-existed — git's status distinguishes nothing useful here.
    return { paths: [filePath, sidecarPathFor(filePath)], verb: "write" };
  }

  if (toolName === "Edit" || toolName === "MultiEdit") {
    const filePath = extractMutationPath("PostToolUse", toolName, data);
    if (!filePath || !isDocsMarkdown(filePath, docsDir) || !exists(filePath)) {
      return null;
    }
    // Edit/MultiEdit do NOT (re)write the sidecar — only commit the modified
    // `.md`; its unchanged sidecar drops out of `dirtyFilesForPathspecs`.
    return { paths: [filePath], verb: "update" };
  }

  if (toolName === "Bash") {
    const cwd = strField(data, "cwd");
    const mutation = extractBashMutation("PostToolUse", "Bash", data, cwd);
    if (
      mutation &&
      (mutation.kind === "fs-remove" ||
        mutation.kind === "fs-move" ||
        mutation.kind === "git-rm" ||
        mutation.kind === "git-mv")
    ) {
      const prefix = docsDir.endsWith("/") ? docsDir : `${docsDir}/`;
      const docsTargets = mutation.targets.filter((t) => t.startsWith(prefix));
      if (docsTargets.length > 0) {
        return { paths: docsTargets, verb: "delete" };
      }
    }
  }

  return null;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const data = JSON.parse(raw) as Record<string, unknown>;

  if (strField(data, "hook_event_name") !== "PostToolUse") {
    return;
  }
  const toolName = strField(data, "tool_name");
  const docsDir = resolveDocsDir();

  // The sidecar write (Write) and gist-URL upsert (Bash gist) are file-only side
  // effects; the git commit routing is the pure `decideDocsCommit`.
  if (toolName === "Write") {
    const filePath = extractMutationPath("PostToolUse", toolName, data);
    if (filePath && isDocsMarkdown(filePath, docsDir) && existsSync(filePath)) {
      writeDocSidecar(filePath, data);
    }
  }
  if (toolName === "Bash") {
    handleGistCreate(data, docsDir);
  }

  const plan = decideDocsCommit(data, docsDir, existsSync);
  if (plan) {
    commitDocsFailOpen(plan.paths, docsDir, plan.verb);
  }
}

// Outer guard: ANY failure here exits 0 with a stderr log. The hook contract is
// "never block Claude" — a wedged sidecar-writer that propagates a non-zero exit
// can fail-CLOSE the human's session, which is far worse than a missed sidecar.
//
// `import.meta.main` gates the run so a plain `import` (tests pulling in the
// pure exported helpers) is inert — only direct invocation executes main.
if (import.meta.main) {
  process.on("uncaughtException", (err) => {
    process.stderr.write(`keeper sidecar-writer: uncaught: ${err}\n`);
    process.exit(0);
  });
  process.on("unhandledRejection", (err) => {
    process.stderr.write(`keeper sidecar-writer: unhandled: ${err}\n`);
    process.exit(0);
  });
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`keeper sidecar-writer: ${err}\n`);
      process.exit(0);
    });
}
