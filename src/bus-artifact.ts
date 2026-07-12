/**
 * Agent Bus message artifacts — the content-independent claim-check contract
 * shared by the chat sender, the inbox watcher, and the bus worker.
 *
 * A Bus message artifact is the private immutable file carrying one message's
 * body; the bus itself carries only a typed, versioned REFERENCE to it. The
 * reference holds an opaque collision-safe id, the UTF-8 byte length, and the
 * SHA-256 of the body — never the body and never an arbitrary absolute path. The
 * transport stays same-host and same-account by contract (the local UDS + the
 * shared Keeper state root), so a peer only ever hands over an opaque id resolved
 * BENEATH a Keeper-owned root, never a path it chose.
 *
 * Two layers live here, deliberately split so the pure gate unit-tests without a
 * filesystem:
 *  - PURE codec/validation — {@link encodeBusArtifactRef} / {@link
 *    decodeBusArtifactRef} discriminate a reference by its versioned payload tag
 *    (never by path-looking text): a non-reference string is the LEGACY-inline
 *    branch, while a tagged-but-bad reference fails loud and is never reread as a
 *    body.
 *  - THIN filesystem ops — {@link publishBusArtifact} (atomic private create),
 *    {@link resolveBusArtifact} (confined verify), {@link removeBusArtifact}
 *    (fail-soft delete), and {@link listBusArtifactIds} (bounded enumeration).
 *
 * Confinement rests on the opaque id itself: an id is exactly 32 lowercase hex
 * chars, so it can carry no separator, `.`, `..`, or NUL and `join(root, id)` can
 * never escape the root — a stronger primitive than the handoff spill's
 * realpath-an-arbitrary-path gate, because this contract never accepts a path.
 * A symlink or non-regular inode PLANTED at the resolved path is rejected by an
 * `lstat` regular-file check that never follows the final link.
 *
 * This module adds INERT primitives only: no sender emits references and no
 * lifecycle row depends on them yet. It introduces no new unsandboxed state class
 * — the artifact root derives from the existing bus state location, so a
 * `KEEPER_BUS_DB` override relocates it under the per-test tmpdir with everything
 * else.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, resolveBusDbPath } from "./db";

/**
 * The reference version this codec produces and the sole version it accepts.
 * Bump only alongside a coordinated sender/watcher/worker change; an older or
 * newer tag fails loud at decode rather than silently mis-parsing.
 */
export const BUS_ARTIFACT_REF_VERSION = 1;

/**
 * The typed discriminator that marks a bus payload as an artifact reference. Its
 * PRESENCE (not any path-looking text) is what tells a decoder "this is a
 * reference": absent → legacy inline body; present-but-bad → fail loud.
 */
export const BUS_ARTIFACT_REF_TAG = "bus-artifact-ref";

/**
 * Body ceiling in bytes — the existing one-mebibyte bus envelope cap. A body
 * over this is refused at publish and, defensively, at resolve, so an oversize
 * file is never read into memory.
 */
export const BUS_ARTIFACT_MAX_BYTES = 1024 * 1024;

/** Opaque artifact id shape: exactly 32 lowercase hex chars (128 random bits). */
const ARTIFACT_ID_RE = /^[0-9a-f]{32}$/;
/** SHA-256 hex digest shape. */
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * A typed, versioned claim-check reference to a Bus message artifact. Carries
 * only integrity metadata — the opaque id, the UTF-8 byte length, and the
 * SHA-256 of the body — and never the body content itself.
 */
export interface BusArtifactRef {
  /** Opaque collision-safe id (matches {@link ARTIFACT_ID_RE}). */
  readonly id: string;
  /** UTF-8 byte length of the original body. */
  readonly len: number;
  /** Lowercase-hex SHA-256 of the body bytes. */
  readonly sha256: string;
}

/** Discriminated outcome of {@link decodeBusArtifactRef}. */
export type DecodeRefResult =
  | { ok: true; ref: BusArtifactRef }
  /**
   * The payload carries no reference tag — it is a legacy inline body. Callers
   * take their existing inline path; this is NOT an error.
   */
  | { ok: false; reason: "not-a-reference" }
  /** Tagged as a reference but at an unsupported version — fail loud. */
  | { ok: false; reason: "unsupported-version"; version: unknown }
  /** Tagged as a reference but structurally invalid — fail loud. */
  | { ok: false; reason: "malformed"; detail: string };

/** Discriminated outcome of {@link resolveBusArtifact}. */
export type ResolveArtifactResult =
  | { ok: true; path: string; body: string; size: number }
  | { ok: false; code: ResolveRejection };

/** Every way a reference can fail to resolve to a trusted, verified artifact. */
export type ResolveRejection =
  /** `id` is not a well-formed opaque id (covers traversal / separators). */
  | "malformed-id"
  /** `len`/`sha256` are structurally invalid. */
  | "malformed-ref"
  /** No inode at the resolved path. */
  | "missing"
  /** The inode is not a regular file (symlink, dir, fifo, …). */
  | "not-regular"
  /** The on-disk body exceeds the one-mebibyte cap. */
  | "oversize"
  /** The on-disk byte length disagrees with `len`. */
  | "length-mismatch"
  /** The on-disk SHA-256 disagrees with `sha256`. */
  | "digest-mismatch";

/** A published artifact: its reference plus the trusted path it was written to. */
export interface PublishedBusArtifact {
  readonly ref: BusArtifactRef;
  readonly path: string;
}

/** One bounded page of artifact ids present on disk. */
export interface BusArtifactIdPage {
  /** Up to `limit` opaque ids of regular artifact files. */
  readonly ids: string[];
  /**
   * `true` iff the directory stream was fully consumed. `false` means the page
   * filled to `limit` and more entries MAY remain — call again (after deleting
   * this page's orphans) to make progress.
   */
  readonly complete: boolean;
}

/** True iff `id` is a well-formed opaque artifact id. */
export function isValidArtifactId(id: unknown): id is string {
  return typeof id === "string" && ARTIFACT_ID_RE.test(id);
}

/** Mint a fresh opaque, collision-safe artifact id (128 random bits, hex). */
export function newBusArtifactId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * The Keeper-owned artifact root, derived from the bus state location so it needs
 * no new env var and rides the existing `KEEPER_BUS_DB` sandbox override. Pure.
 */
export function resolveBusArtifactRoot(): string {
  return join(dirname(resolveBusDbPath()), "bus-artifacts");
}

// ---------------------------------------------------------------------------
// Pure codec / validation
// ---------------------------------------------------------------------------

function isWellFormedRef(ref: BusArtifactRef): boolean {
  return (
    isValidArtifactId(ref.id) &&
    Number.isInteger(ref.len) &&
    ref.len >= 0 &&
    ref.len <= BUS_ARTIFACT_MAX_BYTES &&
    typeof ref.sha256 === "string" &&
    SHA256_RE.test(ref.sha256)
  );
}

/**
 * Serialize a reference to its wire form — a compact, key-tagged JSON object.
 * Throws on a structurally invalid reference so a bad reference can never enter
 * the bus. Pure.
 */
export function encodeBusArtifactRef(ref: BusArtifactRef): string {
  if (!isWellFormedRef(ref)) {
    throw new TypeError("refusing to encode a malformed bus artifact reference");
  }
  return JSON.stringify({
    t: BUS_ARTIFACT_REF_TAG,
    v: BUS_ARTIFACT_REF_VERSION,
    id: ref.id,
    len: ref.len,
    sha256: ref.sha256,
  });
}

/**
 * Parse and structurally validate a wire payload. The tag's PRESENCE decides the
 * branch: a payload without it is a legacy inline body (`not-a-reference`, not an
 * error); a tagged payload at the wrong version or with bad fields fails loud
 * (`unsupported-version` / `malformed`) and must NEVER be reinterpreted as a
 * body. Pure — no filesystem access.
 */
export function decodeBusArtifactRef(raw: string): DecodeRefResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not-a-reference" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not-a-reference" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.t !== BUS_ARTIFACT_REF_TAG) {
    return { ok: false, reason: "not-a-reference" };
  }
  // From here the payload CLAIMS to be a reference — every failure is loud.
  if (obj.v !== BUS_ARTIFACT_REF_VERSION) {
    return { ok: false, reason: "unsupported-version", version: obj.v };
  }
  if (!isValidArtifactId(obj.id)) {
    return { ok: false, reason: "malformed", detail: "id" };
  }
  if (
    typeof obj.len !== "number" ||
    !Number.isInteger(obj.len) ||
    obj.len < 0 ||
    obj.len > BUS_ARTIFACT_MAX_BYTES
  ) {
    return { ok: false, reason: "malformed", detail: "len" };
  }
  if (typeof obj.sha256 !== "string" || !SHA256_RE.test(obj.sha256)) {
    return { ok: false, reason: "malformed", detail: "sha256" };
  }
  return { ok: true, ref: { id: obj.id, len: obj.len, sha256: obj.sha256 } };
}

// ---------------------------------------------------------------------------
// Thin filesystem operations
// ---------------------------------------------------------------------------

/**
 * Create the artifact root if absent and tighten it to `0700`. The recursive
 * `mode` is umask-masked, so an explicit `chmod` follows to guarantee the exact
 * bits (best-effort — a pre-existing looser dir is not fatal here).
 */
export function ensureBusArtifactRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
  } catch {
    // best-effort tighten; ownership/mode edge cases are not fatal
  }
}

/**
 * Write `body` to a fresh private `0600` artifact beneath `root` and return its
 * reference. The write is atomic (same-dir temp → rename with the mode landing
 * on the temp BEFORE the rename, via the shared {@link atomicWriteFile}), so the
 * file is complete and never briefly world-readable before this returns. The id
 * is random and content-independent, so concurrent senders — even of identical
 * bodies — never collide. Refuses an oversize body up front.
 */
export function publishBusArtifact(
  root: string,
  body: string,
): PublishedBusArtifact {
  const len = Buffer.byteLength(body, "utf8");
  if (len > BUS_ARTIFACT_MAX_BYTES) {
    throw new RangeError(
      `bus message body is ${len} bytes, over the ${BUS_ARTIFACT_MAX_BYTES}-byte artifact cap`,
    );
  }
  ensureBusArtifactRoot(root);
  const id = newBusArtifactId();
  const path = join(root, id);
  const sha256 = createHash("sha256").update(body, "utf8").digest("hex");
  atomicWriteFile(path, body, 0o600);
  return { ref: { id, len, sha256 }, path };
}

/**
 * Resolve a decoded reference to a trusted, verified artifact — the confined
 * READ side. Every step is a rejection gate, never a throw:
 *   1. re-validate the opaque id (blocks traversal / separators independent of
 *      decode, so even a hand-built ref cannot escape);
 *   2. `lstat` the `join(root, id)` path — a missing inode is `missing`, and a
 *      non-regular inode (a planted symlink, dir, or fifo) is `not-regular`
 *      because `lstat` never follows the final link;
 *   3. gate on size BEFORE reading — `oversize` / `length-mismatch` — so an
 *      oversize or wrong-length file is never slurped into memory;
 *   4. read the bounded bytes and verify the SHA-256.
 * Returns the trusted display PATH (never executed) plus the verified body.
 */
export function resolveBusArtifact(
  root: string,
  ref: BusArtifactRef,
): ResolveArtifactResult {
  if (!isValidArtifactId(ref.id)) {
    return { ok: false, code: "malformed-id" };
  }
  if (
    !Number.isInteger(ref.len) ||
    ref.len < 0 ||
    ref.len > BUS_ARTIFACT_MAX_BYTES ||
    typeof ref.sha256 !== "string" ||
    !SHA256_RE.test(ref.sha256)
  ) {
    return { ok: false, code: "malformed-ref" };
  }
  const path = join(root, ref.id);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return { ok: false, code: "missing" };
  }
  if (!st.isFile()) {
    return { ok: false, code: "not-regular" };
  }
  if (st.size > BUS_ARTIFACT_MAX_BYTES) {
    return { ok: false, code: "oversize" };
  }
  if (st.size !== ref.len) {
    return { ok: false, code: "length-mismatch" };
  }
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return { ok: false, code: "missing" };
  }
  const digest = createHash("sha256").update(buf).digest("hex");
  if (digest !== ref.sha256) {
    return { ok: false, code: "digest-mismatch" };
  }
  return { ok: true, path, body: buf.toString("utf8"), size: st.size };
}

/**
 * Delete the artifact named by `id`. Confined and fail-soft: a malformed id, an
 * absent file, and a non-regular inode all no-op to `false` (never unlink
 * outside the opaque-id contract, never follow a planted link), and any unlink
 * error is swallowed to `false` so cleanup stays retryable. Returns `true` only
 * when a regular artifact file was removed.
 */
export function removeBusArtifact(root: string, id: string): boolean {
  if (!isValidArtifactId(id)) {
    return false;
  }
  const path = join(root, id);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return false;
  }
  if (!st.isFile()) {
    return false;
  }
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enumerate up to `limit` artifact ids present on disk — the BOUNDED orphan-scan
 * primitive. It streams the directory one entry at a time via `opendirSync` and
 * STOPS at `limit`, so a single call never materializes the whole listing the
 * way `readdirSync` would; a directory of any size costs at most ~`limit` reads.
 * Only regular files whose name is a well-formed opaque id are returned, so
 * in-flight `.tmp.` writes and any stray inode are skipped. Fail-soft: an absent
 * or unreadable root yields an empty, complete page. See {@link
 * BusArtifactIdPage} for the `complete` semantics.
 */
export function listBusArtifactIds(
  root: string,
  limit: number,
): BusArtifactIdPage {
  if (!Number.isInteger(limit) || limit < 1) {
    return { ids: [], complete: false };
  }
  let dir: ReturnType<typeof opendirSync>;
  try {
    dir = opendirSync(root);
  } catch {
    return { ids: [], complete: true };
  }
  const ids: string[] = [];
  let complete = true;
  try {
    for (;;) {
      let ent: ReturnType<typeof dir.readSync>;
      try {
        ent = dir.readSync();
      } catch {
        // Bun defers the `scandir` to the first read, so a missing or
        // unreadable root surfaces HERE rather than at `opendirSync` — fail-soft
        // to a complete page instead of throwing.
        complete = true;
        break;
      }
      if (ent === null) {
        complete = true;
        break;
      }
      if (!ent.isFile() || !isValidArtifactId(ent.name)) {
        continue;
      }
      ids.push(ent.name);
      if (ids.length >= limit) {
        complete = false;
        break;
      }
    }
  } finally {
    try {
      dir.closeSync();
    } catch {
      // best-effort close
    }
  }
  return { ids, complete };
}
