#!/usr/bin/env bun
/**
 * Merge-time schema-ladder renumber tool. Mechanizes the ADR-0020 rule: a
 * landed trunk migration keeps its number forever; an unlanded lane that
 * collided on a version renumbers onto main-tip+1..+k — but ONLY when every
 * colliding step is provably additive-idempotent. Anything version-guarded,
 * rewinding, dropping, backfilling, or reshaping a table is REFUSED for a human.
 *
 * Two layers, cleanly split:
 *
 *   - PURE CORE `apply(mainFiles, laneFiles)` — takes file CONTENTS as strings
 *     (never paths, never git, never fs). Parses the `SCHEMA_STEPS` ladder on
 *     both sides via the TS parser (structured entries, not regex-over-source),
 *     detects the lane's branch-local steps, proof-gates each, and returns
 *     either the rewritten lane file set or a machine-readable refusal envelope.
 *
 *   - IMPURE ENTRYPOINT (`import.meta.main` only) — reads the real files (lane =
 *     working tree, main = `git show <base>:<path>`), runs the pure core, writes
 *     the rewritten files, then re-pins `SCHEMA_FINGERPRINT` by opening
 *     `openDb(":memory:")` in-process and recomputing it. In-process bun:sqlite,
 *     never a subprocess.
 *
 * WHY the renumber is safe to do mechanically, and why re-pinning the
 * fingerprint is not masking drift: a pure renumber shifts version NUMBERS only
 * and leaves DDL semantics byte-identical, so the fingerprint's hash body is
 * invariant under it — only the `v<N>` prefix moves. The proof gate asserts the
 * "pure renumber" precondition (additive-idempotent, no destructive body) rather
 * than assuming it. Run the tool as the FINAL step against the fully-merged
 * working tree so the in-process recompute observes the merged ladder.
 *
 * WHY the denylist body scan is token-based (comments stripped): real historical
 * `additive` steps carry comments that MENTION `DELETE` / `cursor rewind` /
 * `UPDATE` precisely to explain what they do NOT do. A raw substring scan would
 * false-refuse them. The scan inspects the apply body's non-trivia tokens only —
 * SQL keywords inside string literals, helper identifiers — so a comment can
 * never trip it and a `//`-in-a-string can never hide a real one.
 *
 * Usage:
 *   bun scripts/rebase-schema-migration.ts --help
 *   bun scripts/rebase-schema-migration.ts [--base <ref>]   # default base: main
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { openDb } from "../src/db";

// ---------------------------------------------------------------------------
// Types — the pure core's input/output contract.
// ---------------------------------------------------------------------------

/** The colliding-schema surfaces the tool rewrites, keyed by role. `tests` maps
 * a test file path to its contents so the core can shift pinned assertions in
 * any number of files. */
export interface FileSet {
  db: string;
  apiPy: string;
  tests: Record<string, string>;
}

/** The machine-readable reasons a renumber fails closed. Aligned to the ladder's
 * `kind` discriminants plus the body-denylist / collision classes. */
export type RefusalReason =
  | "rewind"
  | "drop"
  | "backfill"
  | "create-literal"
  | "identical-content"
  | "unknown";

export interface RefusalEnvelope {
  refused: true;
  step: number;
  reason: RefusalReason;
  message: string;
}

/** One `from → to` version move in the lane's renumber. */
export interface VersionShift {
  from: number;
  to: number;
}

export interface RenumberOk {
  refused: false;
  /** Empty ⇒ no branch-local colliding steps (a no-op / already-renumbered lane);
   * `files` then equals the lane input unchanged. */
  shifts: VersionShift[];
  files: FileSet;
}

export type ApplyResult = RefusalEnvelope | RenumberOk;

// ---------------------------------------------------------------------------
// TS tokenizer — non-trivia tokens (comments/whitespace dropped). Mirrors the
// scanner discipline in assert-comment-only.ts: templates and their `${}`
// substitutions are tracked via a brace stack so a `}` re-scans as a template
// continuation instead of swallowing the rest of the source.
// ---------------------------------------------------------------------------

interface Token {
  kind: ts.SyntaxKind;
  text: string;
}

function tokenize(source: string): Token[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ true,
    ts.LanguageVariant.Standard,
    source,
  );
  const tokens: Token[] = [];
  const braceStack: ("template" | "block")[] = [];
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    if (
      kind === ts.SyntaxKind.CloseBraceToken &&
      braceStack[braceStack.length - 1] === "template"
    ) {
      braceStack.pop();
      kind = scanner.reScanTemplateToken(/* isTaggedTemplate */ false);
    }
    tokens.push({ kind, text: scanner.getTokenText() });
    if (
      kind === ts.SyntaxKind.TemplateHead ||
      kind === ts.SyntaxKind.TemplateMiddle
    ) {
      braceStack.push("template");
    } else if (kind === ts.SyntaxKind.OpenBraceToken) {
      braceStack.push("block");
    } else if (kind === ts.SyntaxKind.CloseBraceToken) {
      braceStack.pop();
    }
    kind = scanner.scan();
  }
  return tokens;
}

function isStringLike(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === ts.SyntaxKind.TemplateHead ||
    kind === ts.SyntaxKind.TemplateMiddle ||
    kind === ts.SyntaxKind.TemplateTail
  );
}

// ---------------------------------------------------------------------------
// Ladder parsing — extract structured `SCHEMA_STEPS` entries from db.ts source.
// ---------------------------------------------------------------------------

interface LadderStep {
  version: number;
  kind: string;
  /** Verbatim text of the `apply` arrow body — the denylist scan target. */
  bodyText: string;
  /** Comment/whitespace-insensitive signature of the apply body, for identity
   * comparison across the two sides. */
  bodySignature: string;
  /** Char offsets of the `version:` numeric literal in the source, for rewrite. */
  versionStart: number;
  versionEnd: number;
}

function bodySignatureOf(bodyText: string): string {
  return tokenize(bodyText)
    .map((t) => `${t.kind}:${t.text}`)
    .join("");
}

/** Parse `SCHEMA_STEPS` object entries. Throws (loud) if the ladder can't be
 * found — a malformed input is an operator error, not a silent empty ladder. */
export function parseLadder(dbSource: string): LadderStep[] {
  const sf = ts.createSourceFile(
    "db.ts",
    dbSource,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );

  let array: ts.ArrayLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (array) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "SCHEMA_STEPS" &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      array = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!array) {
    throw new Error(
      "could not find SCHEMA_STEPS array literal in db.ts source",
    );
  }

  const steps: LadderStep[] = [];
  for (const el of array.elements) {
    if (!ts.isObjectLiteralExpression(el)) {
      throw new Error("SCHEMA_STEPS entry is not an object literal");
    }
    let version: number | undefined;
    let versionStart = -1;
    let versionEnd = -1;
    let kind: string | undefined;
    let bodyText: string | undefined;
    for (const prop of el.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
        continue;
      }
      const name = prop.name.text;
      if (name === "version" && ts.isNumericLiteral(prop.initializer)) {
        version = Number(prop.initializer.text);
        versionStart = prop.initializer.getStart(sf);
        versionEnd = prop.initializer.getEnd();
      } else if (name === "kind" && ts.isStringLiteral(prop.initializer)) {
        kind = prop.initializer.text;
      } else if (
        name === "apply" &&
        (ts.isArrowFunction(prop.initializer) ||
          ts.isFunctionExpression(prop.initializer))
      ) {
        bodyText = prop.initializer.body.getText(sf);
      }
    }
    if (
      version === undefined ||
      kind === undefined ||
      bodyText === undefined ||
      versionStart < 0
    ) {
      throw new Error(
        `SCHEMA_STEPS entry missing version/kind/apply (near version ${version ?? "?"})`,
      );
    }
    steps.push({
      version,
      kind,
      bodyText,
      bodySignature: bodySignatureOf(bodyText),
      versionStart,
      versionEnd,
    });
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Proof gate — a branch-local step may be renumbered ONLY if it is additive by
// `kind` AND its body carries no destructive operation. `kind` is the primary
// discriminant; the token denylist is defense-in-depth against a mislabeled
// additive body. Returns a RefusalReason, or null to pass.
// ---------------------------------------------------------------------------

const DROP_HELPER_IDENTIFIERS = new Set(["dropColumnIfPresent"]);

/** Scan the apply body's non-trivia tokens for a destructive operation. Comments
 * are trivia (never scanned), and SQL keywords are only matched inside string
 * literals, so a comment that merely NAMES a destructive op never trips this. */
function scanBodyDenylist(bodyText: string): RefusalReason | null {
  for (const tok of tokenize(bodyText)) {
    if (tok.kind === ts.SyntaxKind.Identifier) {
      if (DROP_HELPER_IDENTIFIERS.has(tok.text)) return "drop";
      if (/rewind/i.test(tok.text)) return "rewind";
      if (/^(?:last_event_id|reducer_state)$/.test(tok.text)) return "rewind";
      continue;
    }
    if (isStringLike(tok.kind)) {
      const s = tok.text.toUpperCase();
      if (/\bDROP\s+(?:TABLE|COLUMN)\b/.test(s)) return "drop";
      // CREATE TABLE reshapes/rebuilds; CREATE INDEX is additive and allowed.
      if (/\bCREATE\s+TABLE\b/.test(s)) return "create-literal";
      if (/\bDELETE\b/.test(s)) return "backfill";
      if (/\bUPDATE\b/.test(s)) return "backfill";
      if (/LAST_EVENT_ID|REDUCER_STATE/.test(s)) return "rewind";
    }
  }
  return null;
}

function proofGate(step: LadderStep): RefusalReason | null {
  if (step.kind !== "additive") {
    if (
      step.kind === "rewind" ||
      step.kind === "drop" ||
      step.kind === "backfill"
    ) {
      return step.kind;
    }
    // noop or an unrecognized kind: not provably additive → fail closed.
    return "unknown";
  }
  return scanBodyDenylist(step.bodyText);
}

// ---------------------------------------------------------------------------
// Rewriters — apply the version-shift map to each surface.
// ---------------------------------------------------------------------------

/** Rewrite the `version:` numeric literal of each shifted ladder entry in place.
 * Replacements run last-offset-first so earlier offsets stay valid. */
function rewriteLadderVersions(
  dbSource: string,
  steps: LadderStep[],
  shiftMap: Map<number, number>,
): string {
  const edits = steps
    .filter((s) => shiftMap.has(s.version))
    .map((s) => ({
      start: s.versionStart,
      end: s.versionEnd,
      // biome-ignore lint/style/noNonNullAssertion: filtered on has() above.
      text: String(shiftMap.get(s.version)!),
    }))
    .sort((a, b) => b.start - a.start);
  let out = dbSource;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

const FROZENSET_RE =
  /(SUPPORTED_SCHEMA_VERSIONS\s*=\s*frozenset\(\s*\{)([^}]*)(\}\s*\))/s;

/** Rewrite `keeper/api.py`'s `SUPPORTED_SCHEMA_VERSIONS` frozenset: shift the
 * lane-added versions and re-emit the whole set sorted ascending. The
 * derivability test compares the SET, so re-emitting sorted is semantically
 * exact (Black may reflow the literal on a later format pass). */
function rewriteApiPyFrozenset(
  apiPy: string,
  shiftMap: Map<number, number>,
): string {
  const m = apiPy.match(FROZENSET_RE);
  if (!m) return apiPy;
  const nums = m[2]
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .map((x) => Number.parseInt(x, 10))
    .map((n) => shiftMap.get(n) ?? n);
  const sorted = Array.from(new Set(nums)).sort((a, b) => a - b);
  return apiPy.replace(FROZENSET_RE, `$1${sorted.join(", ")}$3`);
}

/** Rewrite pinned version assertions in a test file, anchored to the two shapes
 * the schema tests establish: `toBe(N)` and the `vN:` fingerprint prefix. Only
 * numbers present in the shift map are touched — an unrelated `toBe(200)` is
 * left alone. This anchoring is the guard against over-eager number rewrites. */
function rewriteTestAssertions(
  testSource: string,
  shiftMap: Map<number, number>,
): string {
  return testSource
    .replace(/\btoBe\((\d+)\)/g, (whole, digits) => {
      const n = Number.parseInt(digits, 10);
      return shiftMap.has(n) ? `toBe(${shiftMap.get(n)})` : whole;
    })
    .replace(/\bv(\d+):/g, (whole, digits) => {
      const n = Number.parseInt(digits, 10);
      return shiftMap.has(n) ? `v${shiftMap.get(n)}:` : whole;
    });
}

// ---------------------------------------------------------------------------
// Pure core.
// ---------------------------------------------------------------------------

function refuse(step: number, reason: RefusalReason): RefusalEnvelope {
  const messages: Record<RefusalReason, string> = {
    rewind:
      "step rewinds the reducer cursor — a shared version corrupts replay",
    drop: "step drops a column/table — not additive-idempotent",
    backfill: "step backfills rows (UPDATE/DELETE) — not additive-idempotent",
    "create-literal":
      "step contains an inline CREATE TABLE — table shape is not mechanically renumberable",
    "identical-content":
      "lane and main added byte-identical bodies at the same version — dedup is a human judgment about intent, refusing",
    unknown: "step kind is not provably additive — refusing to renumber",
  };
  return { refused: true, step, reason, message: messages[reason] };
}

/**
 * Renumber the lane's branch-local schema steps onto main-tip+1..+k, or refuse.
 * Pure over its two {@link FileSet} inputs — no filesystem, no git.
 *
 * Branch-local detection walks the lane ladder ascending against main:
 *   - a leading run of steps byte-equal to main's same-version step is the
 *     shared landed prefix (kept, never renumbered);
 *   - the first differing (or main-absent) step marks divergence — everything
 *     from there is branch-local;
 *   - a branch-local step that is byte-identical to main's same-version step is
 *     a coincidental identical collision → REFUSE (never silently dedup).
 *
 * Only branch-local steps that COLLIDE (version ≤ main's tail) force a renumber;
 * a lane already sitting above main's tail is a no-op (this is what makes the
 * tool idempotent — a second run finds nothing to move).
 */
export function apply(main: FileSet, lane: FileSet): ApplyResult {
  const mainSteps = parseLadder(main.db);
  const laneSteps = parseLadder(lane.db).sort((a, b) => a.version - b.version);
  const mainByVersion = new Map(mainSteps.map((s) => [s.version, s]));
  const mainTail = mainSteps.reduce((mx, s) => Math.max(mx, s.version), 0);

  const branchLocal: LadderStep[] = [];
  let diverged = false;
  for (const l of laneSteps) {
    const m = mainByVersion.get(l.version);
    const identical = m !== undefined && m.bodySignature === l.bodySignature;
    if (!diverged && identical) {
      // still inside the shared landed prefix
      continue;
    }
    if (identical) {
      // past divergence, yet byte-identical at a colliding version
      return refuse(l.version, "identical-content");
    }
    diverged = true;
    branchLocal.push(l);
  }

  const colliding = branchLocal.filter((s) => s.version <= mainTail);
  if (colliding.length === 0) {
    // No branch-local colliding steps: no-op / already renumbered. Lane unchanged.
    return { refused: false, shifts: [], files: lane };
  }

  // Every step that will move must be provably additive-idempotent.
  for (const s of branchLocal) {
    const reason = proofGate(s);
    if (reason) return refuse(s.version, reason);
  }

  // Shift all branch-local steps onto main-tip+1.., preserving relative order.
  const shifts: VersionShift[] = branchLocal.map((s, i) => ({
    from: s.version,
    to: mainTail + 1 + i,
  }));
  const shiftMap = new Map(shifts.map((s) => [s.from, s.to]));

  const rewrittenTests: Record<string, string> = {};
  for (const [path, src] of Object.entries(lane.tests)) {
    rewrittenTests[path] = rewriteTestAssertions(src, shiftMap);
  }

  return {
    refused: false,
    shifts,
    files: {
      db: rewriteLadderVersions(lane.db, laneSteps, shiftMap),
      apiPy: rewriteApiPyFrozenset(lane.apiPy, shiftMap),
      tests: rewrittenTests,
    },
  };
}

// ---------------------------------------------------------------------------
// Fingerprint re-pin — the one impure-ish helper: opens an in-memory migrated
// DB in-process and recomputes the pinned fingerprint. Never a subprocess.
// ---------------------------------------------------------------------------

const FINGERPRINT_RE = /(SCHEMA_FINGERPRINT\s*=\s*\n?\s*")([^"]*)(")/;

/** Recompute the schema fingerprint's `v<N>:<digest>` from a fresh in-memory
 * migrate, version-prefixed with the RENUMBERED ladder's tail rather than the
 * process-start-imported `../src/db` module's `SCHEMA_VERSION`.
 *
 * `openDb(":memory:")` still runs the imported module's own `SCHEMA_STEPS` —
 * that's fine because a renumber (proof-gated pure core `apply()`, above)
 * shifts version NUMBERS only and never touches an `apply` body or step
 * order, so the migrated DDL shape is byte-identical whether it's produced by
 * the pre-renumber (colliding) ladder or the post-renumber one; only the
 * `v<N>` label the shape gets hashed under is allowed to move. Passing the
 * REWRITTEN `db.ts` source (`renumberedDbSource`, i.e. `result.files.db`) and
 * parsing its tail via {@link parseLadder} is what makes that label track the
 * renumber instead of going stale — the bug this fixes is entirely that the
 * import-time module's `SCHEMA_VERSION` still reflects the pre-renumber tail
 * at the point this runs.
 */
export function computeRepinnedFingerprint(renumberedDbSource: string): string {
  const steps = parseLadder(renumberedDbSource);
  const tail = steps.reduce((mx, s) => Math.max(mx, s.version), 0);
  const { db } = openDb(":memory:");
  try {
    const rows = db
      .query(
        `SELECT type, name, sql FROM sqlite_master
          WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
          ORDER BY type, name`,
      )
      .all() as { type: string; name: string; sql: string }[];
    const dump = rows.map((r) => `${r.type}\t${r.name}\t${r.sql}`).join("\n");
    const hash = createHash("sha256").update(`v${tail}\n${dump}`).digest("hex");
    return `v${tail}:${hash}`;
  } finally {
    db.close();
  }
}

/** Replace the `SCHEMA_FINGERPRINT = "..."` literal in db.ts source. Returns the
 * source unchanged if the literal is already the given value. */
export function applyFingerprintRepin(
  dbSource: string,
  fingerprint: string,
): string {
  return dbSource.replace(FINGERPRINT_RE, `$1${fingerprint}$3`);
}

// ---------------------------------------------------------------------------
// Impure entrypoint.
// ---------------------------------------------------------------------------

const DB_PATH = "src/db.ts";
const API_PY_PATH = "keeper/api.py";
const TEST_PATHS = ["test/schema-version.test.ts", "test/db.test.ts"];

const HELP = `rebase-schema-migration — renumber a colliding schema lane at merge time.

Renumbers the lane's branch-local SCHEMA_STEPS onto main-tip+1..+k when every
colliding step is provably additive-idempotent, updates the api.py whitelist and
pinned version assertions, and re-pins SCHEMA_FINGERPRINT via an in-process
recompute. REFUSES (exit non-zero, machine-readable envelope on stderr) on any
non-additive collision.

Usage:
  bun scripts/rebase-schema-migration.ts [--base <ref>]
  bun scripts/rebase-schema-migration.ts --help

Options:
  --base <ref>   Trunk ref whose landed numbers are immutable (default: main).

Reads lane-side files from the working tree and main-side files from
\`git show <base>:<path>\`. Run as the FINAL merge step so the fingerprint
recompute observes the merged ladder.`;

function gitShow(base: string, path: string): string | null {
  const res = Bun.spawnSync(["git", "show", `${base}:${path}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) return null;
  return res.stdout.toString();
}

function readWorkingTree(root: string, path: string): string | null {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
}

function main(argv: string[]): number {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const baseIdx = args.indexOf("--base");
  const base = baseIdx >= 0 ? (args[baseIdx + 1] ?? "main") : "main";
  const root = process.cwd();

  const mainDb = gitShow(base, DB_PATH);
  const laneDb = readWorkingTree(root, DB_PATH);
  if (mainDb === null || laneDb === null) {
    console.error(
      `[rebase-schema] cannot read ${DB_PATH} on ${mainDb === null ? base : "working tree"}`,
    );
    return 2;
  }

  const buildTests = (side: "base" | "tree"): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const p of TEST_PATHS) {
      const src = side === "base" ? gitShow(base, p) : readWorkingTree(root, p);
      if (src !== null) out[p] = src;
    }
    return out;
  };

  const mainFiles: FileSet = {
    db: mainDb,
    apiPy: gitShow(base, API_PY_PATH) ?? "",
    tests: buildTests("base"),
  };
  const laneFiles: FileSet = {
    db: laneDb,
    apiPy: readWorkingTree(root, API_PY_PATH) ?? "",
    tests: buildTests("tree"),
  };

  const result = apply(mainFiles, laneFiles);
  if (result.refused) {
    console.error(JSON.stringify(result));
    return 1;
  }

  if (result.shifts.length === 0) {
    console.log(
      JSON.stringify({ renumbered: false, reason: "no branch-local steps" }),
    );
    return 0;
  }

  // Write the renumbered surfaces, then re-pin the fingerprint against the
  // RENUMBERED ladder's tail (result.files.db) — not the process-start
  // import, which still reflects the pre-renumber (colliding) tree.
  const fingerprint = computeRepinnedFingerprint(result.files.db);
  writeFileSync(
    join(root, DB_PATH),
    applyFingerprintRepin(result.files.db, fingerprint),
  );
  if (laneFiles.apiPy.length > 0) {
    writeFileSync(join(root, API_PY_PATH), result.files.apiPy);
  }
  for (const [p, src] of Object.entries(result.files.tests)) {
    writeFileSync(join(root, p), src);
  }

  console.log(
    JSON.stringify({
      renumbered: true,
      shifts: result.shifts,
      fingerprint,
    }),
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main(Bun.argv));
}
