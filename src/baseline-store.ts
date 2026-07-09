/**
 * The dependency-light CONTRACT for the suite-baseline store (docs/adr/0005):
 * the key, the on-disk spool/leaf layout, the result envelope, and the pure
 * helpers every downstream task (baseline worker, `keeper baseline` CLI, the
 * read verb) shares. Owning the union in ONE module is how the epic keeps its
 * "could not run cannot read as green" invariant structurally enforced — a
 * reader gets a typed envelope, never a re-derived boolean.
 *
 * A Baseline (glossary term — NEVER "cache" / "snapshot" / "golden") is the
 * daemon-computed suite result at a commit sha a worker consults to attribute a
 * test failure as pre-existing or self-inflicted. The persisted result file is a
 * "leaf"; the request queue is the "spool".
 *
 * DEPENDENCY POSTURE: `node:*` plus the two dep-free leaves `keeper-state-dir`
 * and `worktree-plan` (repoDirHash) — NEVER `bun:sqlite` / `src/db.ts`. Helpers
 * follow the restart-ledger shape (src/daemon.ts): fail-open parse, atomic
 * write, bounded eviction, pure verdict logic.
 *
 * SECURITY: leaf/spool content is attacker-influenced (test names, failure text
 * ride committed lane-sha code). Every persisted document is ONE bounded JSON
 * object; string/array fields are size-capped on both write and parse; this
 * module never shells out, so there is no interpolation surface at all.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { keeperStateDir } from "./keeper-state-dir";
import { repoDirHash } from "./worktree-plan";

// ── layout + bounds ──────────────────────────────────────────────────────────

/** `<state-dir>/baseline/` — the store root. */
const BASELINE_DIRNAME = "baseline";
/** `<root>/requests/` — the request spool (maildir shape). */
const SPOOL_DIRNAME = "requests";
/** `<root>/leafs/` — the baseline-worker-written per-key result files. */
const LEAF_DIRNAME = "leafs";

/**
 * Hard cap on retained result leafs. Retention is eviction (oldest first), never
 * invalidation — a key's result is immutable, so a re-ask after eviction is a
 * clean recompute. Disk is the DoS surface; this is the belt.
 */
export const LEAF_RETENTION_CAP = 256;
/** Max failing-test identities recorded per run / in a derived verdict. */
export const MAX_FAILING_TESTS = 500;
/** Max bytes of a single failing-test identity string. */
export const MAX_TEST_ID_LEN = 512;
/** Max bytes of an infra-error message. */
export const MAX_MESSAGE_LEN = 4096;
/** Max raw suite runs recorded in one envelope (run + bounded retries). */
export const MAX_RUNS = 8;
/** Reject a leaf/request body larger than this on parse (fail-open to a miss). */
export const MAX_DOC_BYTES = 1 << 20; // 1 MiB

// ── the key ──────────────────────────────────────────────────────────────────

/**
 * The toolchain half of the key. The suite DEFINITION rides the tree at the sha,
 * but the Bun version and host arch do not — so a bare sha would serve a stale
 * result across a `bun` upgrade. Keeping the fingerprint in the key makes a
 * toolchain bump a fresh miss (Turborepo/Nx input-hash keying).
 */
export interface ToolchainFingerprint {
  bunVersion: string;
  /** `${process.platform}-${process.arch}`. */
  platform: string;
}

/** The three components a baseline key composes from. */
export interface BaselineKeyInput {
  repoDir: string;
  sha: string;
  toolchain: ToolchainFingerprint;
}

/** The live toolchain fingerprint — the only environment read in this module. */
export function currentToolchain(): ToolchainFingerprint {
  return {
    bunVersion: Bun.version,
    platform: `${process.platform}-${process.arch}`,
  };
}

/** FNV-1a 32-bit → base36. Pure, dep-free; same family as the worktree hash. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** A syntactically valid git sha (abbreviated or full). The CLI gates on this. */
export function isValidSha(sha: string): boolean {
  return /^[0-9a-fA-F]{7,64}$/.test(sha);
}

/**
 * Reduce a sha to a filesystem-safe token: lowercase hex only, ≤64 chars. A
 * malformed sha (upstream should have gated it with {@link isValidSha}) can never
 * escape into a path component — every separator / dot / `..` is stripped here,
 * so {@link leafPath} is traversal-proof regardless of caller hygiene.
 */
function sanitizeSha(sha: string): string {
  const hex = sha
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "")
    .slice(0, 64);
  return hex || "invalid";
}

/**
 * Compose the durable key from (repo identity, commit sha, toolchain
 * fingerprint). PURE — takes the fingerprint as data so key composition is
 * testable without touching the environment. The result is filesystem-safe
 * (base36 + hex + hyphen) and doubles as the leaf filename stem.
 */
export function baselineKey(input: BaselineKeyInput): string {
  const repo = repoDirHash(input.repoDir);
  const sha = sanitizeSha(input.sha);
  const tc = fnv1a(
    `${input.toolchain.bunVersion}\x00${input.toolchain.platform}`,
  );
  return `${repo}-${sha}-${tc}`;
}

// ── paths ────────────────────────────────────────────────────────────────────

/** Strip anything a key/id could not legitimately contain — traversal guard. */
function sanitizeComponent(s: string): string {
  return s.replace(/[^0-9a-zA-Z_-]/g, "").slice(0, 128) || "invalid";
}

/** `<state-dir>/baseline/`. */
export function baselineRoot(stateDir: string = keeperStateDir()): string {
  return join(stateDir, BASELINE_DIRNAME);
}

/** `<root>/requests/` — the request spool dir. */
export function spoolDir(stateDir?: string): string {
  return join(baselineRoot(stateDir), SPOOL_DIRNAME);
}

/** `<root>/leafs/` — the result-leaf dir. */
export function leafDir(stateDir?: string): string {
  return join(baselineRoot(stateDir), LEAF_DIRNAME);
}

/** The result-leaf path for a composed key. */
export function leafPath(key: string, stateDir?: string): string {
  return join(leafDir(stateDir), `${sanitizeComponent(key)}.json`);
}

/** The spool-file path for a request id. */
export function requestPath(requestId: string, stateDir?: string): string {
  return join(spoolDir(stateDir), `${sanitizeComponent(requestId)}.json`);
}

// ── the result envelope (discriminated union) ────────────────────────────────

/** A single RAW suite run. Verdicts are derived from runs, never stored over them. */
export interface SuiteRun {
  startedAt: number;
  durationMs: number;
  exitCode: number;
  /** Failing-test identities observed this run. */
  failingTests: string[];
}

/** A failing test in a derived verdict, marked flaky when it did not fail every run. */
export interface FailingTest {
  id: string;
  /** True when the test failed some runs but not all at the same sha. */
  flakySuspect: boolean;
}

/** Why a run could not happen. Distinct from a suite that ran and went red. */
export type InfraKind = "checkout" | "install" | "spawn";

interface ResultBase {
  key: string;
  sha: string;
  toolchain: ToolchainFingerprint;
  computedAt: number;
}

/** The suite ran clean — the ONLY status a reader may treat as "no pre-existing failures". */
export interface GreenResult extends ResultBase {
  status: "green";
  runs: SuiteRun[];
}

/** The suite ran and tests failed, with derived flaky-suspect marks. */
export interface SuiteRedResult extends ResultBase {
  status: "suite-red";
  failing: FailingTest[];
  runs: SuiteRun[];
}

/** The run could not happen. Carries NO test list — never reads as green. */
export interface InfraErrorResult extends ResultBase {
  status: "infra-error";
  kind: InfraKind;
  message: string;
}

/** The run exceeded its deadline. Partial runs kept; never reads as green. */
export interface TimeoutResult extends ResultBase {
  status: "timeout";
  deadlineMs: number;
  runs: SuiteRun[];
}

/** The durable result a leaf stores — the four terminal outcomes. */
export type BaselineResult =
  | GreenResult
  | SuiteRedResult
  | InfraErrorResult
  | TimeoutResult;

/** No leaf exists for the key — nobody has asked, or it was evicted. */
export interface MissState {
  status: "miss";
  key: string;
}

/** A request is spooled but no leaf exists yet — computation is in flight. */
export interface ComputingState {
  status: "computing";
  key: string;
}

/** What a reader observes: a durable result, or a not-yet-computed read state. */
export type BaselineReadState = BaselineResult | MissState | ComputingState;

// ── the request spool record ─────────────────────────────────────────────────

/**
 * One spool entry. Two sanctioned writers — the `keeper baseline` CLI (a
 * worker-driven read/await) and the autopilot's tip-triggered producer (a fresh
 * trunk baseline on each default-branch tip); the worker coalesces both by `key`.
 */
export interface BaselineRequest {
  key: string;
  repoDir: string;
  sha: string;
  toolchain: ToolchainFingerprint;
  requestedAt: number;
}

/** Mint a fresh spool-file id. */
export function newRequestId(): string {
  return randomUUID();
}

/** Build a spool record from its key components. */
export function buildRequest(
  input: BaselineKeyInput,
  requestedAt: number,
): BaselineRequest {
  return {
    key: baselineKey(input),
    repoDir: input.repoDir,
    sha: input.sha,
    toolchain: input.toolchain,
    requestedAt,
  };
}

// ── verdict logic (pure) ─────────────────────────────────────────────────────

/**
 * The result of ATTEMPTING to compute a baseline. The discriminant forces the
 * caller through one branch — an infra failure or a timeout can never be handed
 * to the "ran" path, so {@link deriveResult} cannot classify a non-run as green.
 */
export type BaselineOutcome =
  | { kind: "ran"; runs: SuiteRun[] }
  | { kind: "timeout"; deadlineMs: number; runs: SuiteRun[] }
  | { kind: "infra"; infra: InfraKind; message: string };

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function boundString(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Bound a run's fields defensively — attacker-influenced test ids are capped. */
function boundRun(run: SuiteRun): SuiteRun {
  return {
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    failingTests: dedupe(run.failingTests)
      .slice(0, MAX_FAILING_TESTS)
      .map((t) => boundString(t, MAX_TEST_ID_LEN)),
  };
}

function boundRuns(runs: SuiteRun[]): SuiteRun[] {
  return runs.slice(0, MAX_RUNS).map(boundRun);
}

/**
 * Derive the per-test verdict from the raw runs. A test that failed in FEWER
 * runs than were recorded (i.e. failed then passed at the same sha) is a
 * flaky-suspect; one that failed EVERY run is a hard failure. Sorted by id for a
 * stable envelope. PURE.
 */
export function classifyFailures(runs: SuiteRun[]): FailingTest[] {
  const runCount = runs.length;
  const failedIn = new Map<string, number>();
  for (const run of runs) {
    for (const id of new Set(run.failingTests)) {
      failedIn.set(id, (failedIn.get(id) ?? 0) + 1);
    }
  }
  const out: FailingTest[] = [];
  for (const [id, n] of failedIn) {
    out.push({
      id: boundString(id, MAX_TEST_ID_LEN),
      flakySuspect: n < runCount,
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * Classify a completed computation into the durable envelope. The infra and
 * timeout branches return WITHOUT ever reaching the green/red decision, so an
 * "the run could not happen" outcome is structurally unable to type-check or
 * evaluate to green. A "ran" outcome is green ONLY when zero tests failed; any
 * failing test yields suite-red with derived flaky marks. PURE.
 *
 * Caller contract: `kind: "ran"` carries at least one completed run. A suite that
 * could not start at all is an `infra`/`spawn` outcome, not an empty "ran".
 */
export function deriveResult(params: {
  key: string;
  sha: string;
  toolchain: ToolchainFingerprint;
  computedAt: number;
  outcome: BaselineOutcome;
}): BaselineResult {
  const { key, sha, toolchain, computedAt, outcome } = params;
  const base: ResultBase = { key, sha, toolchain, computedAt };

  if (outcome.kind === "infra") {
    return {
      ...base,
      status: "infra-error",
      kind: outcome.infra,
      message: boundString(outcome.message, MAX_MESSAGE_LEN),
    };
  }
  if (outcome.kind === "timeout") {
    return {
      ...base,
      status: "timeout",
      deadlineMs: outcome.deadlineMs,
      runs: boundRuns(outcome.runs),
    };
  }

  const runs = boundRuns(outcome.runs);
  const failing = classifyFailures(runs);
  if (failing.length === 0) {
    return { ...base, status: "green", runs };
  }
  return {
    ...base,
    status: "suite-red",
    failing: failing.slice(0, MAX_FAILING_TESTS),
    runs,
  };
}

/**
 * Fold a parsed leaf (or its absence) plus a pending-request flag into the state
 * a reader observes. A present leaf IS the answer; its absence is `computing`
 * when a request is spooled, else a `miss`. PURE.
 */
export function classifyRead(
  leaf: BaselineResult | null,
  hasPendingRequest: boolean,
  key: string,
): BaselineReadState {
  if (leaf) return leaf;
  return hasPendingRequest
    ? { status: "computing", key }
    : { status: "miss", key };
}

// ── retention eviction (pure selector + fs sweep) ────────────────────────────

/** A leaf on disk, for eviction ordering. */
export interface LeafEntry {
  name: string;
  mtimeMs: number;
}

/**
 * Select which leafs to evict to hold the count at `cap`: oldest `mtimeMs` first
 * (name-tiebroken for determinism), keeping the most-recent `cap`. Returns the
 * names to remove, empty when already within cap. PURE — mirrors the
 * restart-ledger's keep-most-recent-`cap` shape.
 */
export function selectEvictions(entries: LeafEntry[], cap: number): string[] {
  const keep = cap < 0 ? 0 : cap;
  if (entries.length <= keep) return [];
  const sorted = [...entries].sort(
    (a, b) =>
      a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return sorted.slice(0, entries.length - keep).map((e) => e.name);
}

/**
 * Enforce the leaf-count cap on disk: stat every `*.json` leaf, evict the oldest
 * beyond `cap`, return the evicted names. Fail-open — an unreadable dir yields
 * `[]`, a failed unlink is skipped; retention must never crash its caller.
 */
export function pruneLeafs(
  dir: string,
  cap: number = LEAF_RETENTION_CAP,
): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: LeafEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      entries.push({ name, mtimeMs: statSync(join(dir, name)).mtimeMs });
    } catch {
      // A leaf that vanished mid-sweep is already gone — skip it.
    }
  }
  const evict = selectEvictions(entries, cap);
  for (const name of evict) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Concurrent eviction / already-removed — nothing to do.
    }
  }
  return evict;
}

// ── fail-open parse + atomic write (restart-ledger shape) ────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // A genuine mkdir failure surfaces on the write that follows.
  }
}

/**
 * Atomic write: stage into a same-dir temp file, then rename over the
 * destination. A killed process leaves the old file or the new one, never a torn
 * write. A write failure THROWS — a lost leaf/spool entry is a real error the
 * sole-writer caller handles, not a fail-open no-op.
 */
function atomicWrite(path: string, content: string): void {
  ensureDir(dirname(path));
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // Swallow — the original write error is what the caller cares about.
    }
    throw err;
  }
}

function coerceToolchain(v: unknown): ToolchainFingerprint | null {
  if (!isRecord(v)) return null;
  if (typeof v.bunVersion !== "string" || typeof v.platform !== "string") {
    return null;
  }
  return {
    bunVersion: boundString(v.bunVersion, MAX_TEST_ID_LEN),
    platform: boundString(v.platform, MAX_TEST_ID_LEN),
  };
}

function coerceRun(v: unknown): SuiteRun | null {
  if (!isRecord(v)) return null;
  if (
    !isFiniteNum(v.startedAt) ||
    !isFiniteNum(v.durationMs) ||
    !isFiniteNum(v.exitCode) ||
    !Array.isArray(v.failingTests)
  ) {
    return null;
  }
  const failingTests = v.failingTests
    .filter((t): t is string => typeof t === "string")
    .slice(0, MAX_FAILING_TESTS)
    .map((t) => boundString(t, MAX_TEST_ID_LEN));
  return {
    startedAt: v.startedAt,
    durationMs: v.durationMs,
    exitCode: v.exitCode,
    failingTests,
  };
}

function coerceRuns(v: unknown): SuiteRun[] | null {
  if (!Array.isArray(v)) return null;
  const out: SuiteRun[] = [];
  for (const raw of v.slice(0, MAX_RUNS)) {
    const run = coerceRun(raw);
    if (!run) return null;
    out.push(run);
  }
  return out;
}

function coerceFailing(v: unknown): FailingTest[] | null {
  if (!Array.isArray(v)) return null;
  const out: FailingTest[] = [];
  for (const raw of v.slice(0, MAX_FAILING_TESTS)) {
    if (!isRecord(raw)) return null;
    if (typeof raw.id !== "string" || typeof raw.flakySuspect !== "boolean") {
      return null;
    }
    out.push({
      id: boundString(raw.id, MAX_TEST_ID_LEN),
      flakySuspect: raw.flakySuspect,
    });
  }
  return out;
}

/**
 * Coerce arbitrary parsed JSON into a typed {@link BaselineResult}, or `null`.
 * The `status` discriminant is checked BEFORE any status-specific field, so an
 * infra-error leaf can never be coerced into a green result — the fail-open path
 * preserves the "could not run is not green" invariant just as the write path
 * does.
 */
function coerceResult(v: unknown): BaselineResult | null {
  if (!isRecord(v)) return null;
  const toolchain = coerceToolchain(v.toolchain);
  if (
    typeof v.key !== "string" ||
    typeof v.sha !== "string" ||
    !toolchain ||
    !isFiniteNum(v.computedAt)
  ) {
    return null;
  }
  const base: ResultBase = {
    key: boundString(v.key, 128),
    sha: boundString(v.sha, 128),
    toolchain,
    computedAt: v.computedAt,
  };
  switch (v.status) {
    case "green": {
      const runs = coerceRuns(v.runs);
      return runs ? { ...base, status: "green", runs } : null;
    }
    case "suite-red": {
      const runs = coerceRuns(v.runs);
      const failing = coerceFailing(v.failing);
      return runs && failing
        ? { ...base, status: "suite-red", runs, failing }
        : null;
    }
    case "infra-error": {
      if (v.kind !== "checkout" && v.kind !== "install" && v.kind !== "spawn") {
        return null;
      }
      const message =
        typeof v.message === "string"
          ? boundString(v.message, MAX_MESSAGE_LEN)
          : "";
      return { ...base, status: "infra-error", kind: v.kind, message };
    }
    case "timeout": {
      const runs = coerceRuns(v.runs);
      if (!runs || !isFiniteNum(v.deadlineMs)) return null;
      return { ...base, status: "timeout", runs, deadlineMs: v.deadlineMs };
    }
    default:
      return null;
  }
}

function coerceRequest(v: unknown): BaselineRequest | null {
  if (!isRecord(v)) return null;
  const toolchain = coerceToolchain(v.toolchain);
  if (
    typeof v.key !== "string" ||
    typeof v.repoDir !== "string" ||
    typeof v.sha !== "string" ||
    !toolchain ||
    !isFiniteNum(v.requestedAt)
  ) {
    return null;
  }
  return {
    key: boundString(v.key, 128),
    repoDir: boundString(v.repoDir, MAX_MESSAGE_LEN),
    sha: boundString(v.sha, 128),
    toolchain,
    requestedAt: v.requestedAt,
  };
}

/**
 * FAIL-OPEN parse of a leaf body → a typed result or `null`. Any malformed body
 * (not JSON, wrong shape, unknown status, oversized) yields `null` so the reader
 * folds it to a `miss` — a corrupt leaf NEVER throws and NEVER reads as green.
 */
export function parseLeaf(raw: string): BaselineResult | null {
  if (raw.length > MAX_DOC_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return coerceResult(parsed);
}

/** Read + fail-open-parse the leaf at `path`. A missing/unreadable file → `null`. */
export function readLeaf(path: string): BaselineResult | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseLeaf(raw);
}

/** Atomically persist a result leaf. Sole writer: the baseline worker. */
export function writeLeaf(path: string, result: BaselineResult): void {
  atomicWrite(path, JSON.stringify(result));
}

/** FAIL-OPEN parse of a spool body → a typed request or `null`. */
export function parseRequest(raw: string): BaselineRequest | null {
  if (raw.length > MAX_DOC_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return coerceRequest(parsed);
}

/** Read + fail-open-parse the spool entry at `path`. Missing/unreadable → `null`. */
export function readRequest(path: string): BaselineRequest | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseRequest(raw);
}

/**
 * Atomically persist a spool entry. Sanctioned writers: the `keeper baseline`
 * CLI and the autopilot tip-triggered baseline producer.
 */
export function writeRequest(path: string, request: BaselineRequest): void {
  atomicWrite(path, JSON.stringify(request));
}
