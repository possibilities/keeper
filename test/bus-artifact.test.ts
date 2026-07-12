/**
 * Pure in-process tests for `src/bus-artifact.ts` — the Agent Bus message
 * artifact claim-check contract (epic fn-1261). Exercises the pure codec (typed
 * reference round-trip, legacy-vs-reference discrimination, fail-loud version and
 * structure rejection) and the thin filesystem seams (private atomic publish,
 * confined verify, fail-soft remove, bounded orphan enumeration) against real
 * temp roots. No daemon, Worker, UDS socket, or subprocess.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  BUS_ARTIFACT_MAX_BYTES,
  BUS_ARTIFACT_REF_TAG,
  BUS_ARTIFACT_REF_VERSION,
  type BusArtifactRef,
  decodeBusArtifactRef,
  encodeBusArtifactRef,
  ensureBusArtifactRoot,
  isValidArtifactId,
  listBusArtifactIds,
  newBusArtifactId,
  publishBusArtifact,
  removeBusArtifact,
  resolveBusArtifact,
  resolveBusArtifactRoot,
} from "../src/bus-artifact";

/** Run `fn` with a fresh temp root that is always torn down. */
function withRoot<T>(fn: (root: string) => T): T {
  const base = mkdtempSync(join(tmpdir(), "bus-artifact-"));
  const root = join(base, "bus-artifacts");
  try {
    return fn(root);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** A deterministic, well-formed opaque id (32 lowercase hex chars). */
function hexId(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function goodRef(overrides: Partial<BusArtifactRef> = {}): BusArtifactRef {
  const body = "hello";
  return {
    id: hexId(1),
    len: Buffer.byteLength(body, "utf8"),
    sha256: sha256Hex(body),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isValidArtifactId
// ---------------------------------------------------------------------------

describe("isValidArtifactId", () => {
  test("accepts exactly 32 lowercase hex chars, rejects everything else", () => {
    expect(isValidArtifactId(hexId(1))).toBe(true);
    expect(isValidArtifactId(newBusArtifactId())).toBe(true);
    expect(isValidArtifactId("a".repeat(32))).toBe(true);

    expect(isValidArtifactId("a".repeat(31))).toBe(false); // too short
    expect(isValidArtifactId("a".repeat(33))).toBe(false); // too long
    expect(isValidArtifactId("A".repeat(32))).toBe(false); // uppercase
    expect(isValidArtifactId("g".repeat(32))).toBe(false); // non-hex
    expect(isValidArtifactId("../../etc/passwd")).toBe(false); // traversal
    expect(isValidArtifactId(`${hexId(1).slice(0, 30)}/x`)).toBe(false); // separator
    expect(isValidArtifactId("")).toBe(false);
    expect(isValidArtifactId(42 as unknown)).toBe(false);
  });

  test("newBusArtifactId is fresh each call", () => {
    const a = newBusArtifactId();
    const b = newBusArtifactId();
    expect(a).not.toBe(b);
    expect(isValidArtifactId(a)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pure codec: encode / decode
// ---------------------------------------------------------------------------

describe("encode/decode reference codec", () => {
  test("round-trips id, len, sha256 and carries no body content", () => {
    const ref = goodRef();
    const wire = encodeBusArtifactRef(ref);

    // The wire form carries only integrity metadata + the typed tag/version.
    expect(wire).toContain(BUS_ARTIFACT_REF_TAG);
    expect(wire).toContain(ref.id);
    expect(wire).toContain(ref.sha256);
    expect(wire).not.toContain("hello"); // never the body

    const decoded = decodeBusArtifactRef(wire);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.ref).toEqual(ref);
    }
  });

  test("encode refuses a malformed reference", () => {
    expect(() => encodeBusArtifactRef(goodRef({ id: "nope" }))).toThrow();
    expect(() => encodeBusArtifactRef(goodRef({ len: -1 }))).toThrow();
    expect(() =>
      encodeBusArtifactRef(goodRef({ len: BUS_ARTIFACT_MAX_BYTES + 1 })),
    ).toThrow();
    expect(() => encodeBusArtifactRef(goodRef({ sha256: "xyz" }))).toThrow();
  });

  test("non-reference payloads decode to the legacy-inline branch, not an error", () => {
    // Path-looking text is NEVER inferred as a reference (the rejected
    // alternative): it is a legacy inline body.
    for (const raw of [
      "just a plain chat message",
      "/etc/passwd",
      "read /Users/mike/secret.txt",
      "not json {",
      JSON.stringify({ hello: "world" }), // JSON object, but no tag
      JSON.stringify([1, 2, 3]), // JSON array
      JSON.stringify("a string"), // JSON string primitive
      JSON.stringify(null),
    ]) {
      const r = decodeBusArtifactRef(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("not-a-reference");
    }
  });

  test("a tagged reference at the wrong version fails loud (never inline)", () => {
    const wire = JSON.stringify({
      t: BUS_ARTIFACT_REF_TAG,
      v: BUS_ARTIFACT_REF_VERSION + 1,
      id: hexId(1),
      len: 5,
      sha256: sha256Hex("hello"),
    });
    const r = decodeBusArtifactRef(wire);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unsupported-version");
      if (r.reason === "unsupported-version") {
        expect(r.version).toBe(BUS_ARTIFACT_REF_VERSION + 1);
      }
    }
  });

  test("a tagged reference with a bad field fails loud as malformed", () => {
    const base = {
      t: BUS_ARTIFACT_REF_TAG,
      v: BUS_ARTIFACT_REF_VERSION,
      id: hexId(1),
      len: 5,
      sha256: sha256Hex("hello"),
    };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base, id: "../../etc/passwd" }, "id"],
      [{ ...base, id: "a".repeat(31) }, "id"],
      [{ ...base, len: -1 }, "len"],
      [{ ...base, len: 1.5 }, "len"],
      [{ ...base, len: BUS_ARTIFACT_MAX_BYTES + 1 }, "len"],
      [{ ...base, len: "5" }, "len"],
      [{ ...base, sha256: "xyz" }, "sha256"],
      [{ ...base, sha256: 123 }, "sha256"],
    ];
    for (const [obj, detail] of cases) {
      const r = decodeBusArtifactRef(JSON.stringify(obj));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("malformed");
        if (r.reason === "malformed") expect(r.detail).toBe(detail);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// publish: private, atomic, exact bytes
// ---------------------------------------------------------------------------

describe("publishBusArtifact", () => {
  test("creates a 0600 regular file beneath a 0700 root", () => {
    withRoot((root) => {
      const { ref, path } = publishBusArtifact(root, "hello");
      expect(isValidArtifactId(ref.id)).toBe(true);
      expect(path).toBe(join(root, ref.id));

      const fileSt = statSync(path);
      expect(fileSt.isFile()).toBe(true);
      expect(fileSt.mode & 0o777).toBe(0o600);

      const rootSt = statSync(root);
      expect(rootSt.isDirectory()).toBe(true);
      expect(rootSt.mode & 0o777).toBe(0o700);

      // The reference describes the body without containing it.
      expect(ref.len).toBe(5);
      expect(ref.sha256).toBe(sha256Hex("hello"));
    });
  });

  test("is atomically complete — no temp file lingers in the root", () => {
    withRoot((root) => {
      const { path } = publishBusArtifact(root, "some body");
      expect(existsSync(path)).toBe(true);
      const names = readdirSync(root);
      expect(names.some((n) => n.includes(".tmp."))).toBe(false);
      expect(names).toHaveLength(1);
    });
  });

  test("round-trips exact body bytes, including multibyte UTF-8", () => {
    withRoot((root) => {
      const body = "héllo 世界 🐛\n\ttrailing";
      const { ref, path } = publishBusArtifact(root, body);
      // len is BYTES, distinct from string length for a multibyte body.
      expect(ref.len).toBe(Buffer.byteLength(body, "utf8"));
      expect(ref.len).not.toBe(body.length);

      const resolved = resolveBusArtifact(root, ref);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.body).toBe(body);
        expect(resolved.size).toBe(ref.len);
        expect(resolved.path).toBe(path);
      }
    });
  });

  test("refuses an oversize body without writing anything", () => {
    withRoot((root) => {
      const tooBig = "x".repeat(BUS_ARTIFACT_MAX_BYTES + 1);
      expect(() => publishBusArtifact(root, tooBig)).toThrow(RangeError);
      // A one-mebibyte body at the exact cap is fine.
      const atCap = "x".repeat(BUS_ARTIFACT_MAX_BYTES);
      const { ref } = publishBusArtifact(root, atCap);
      expect(ref.len).toBe(BUS_ARTIFACT_MAX_BYTES);
    });
  });

  test("content-independent ids: identical bodies get distinct artifacts", () => {
    withRoot((root) => {
      const a = publishBusArtifact(root, "same body");
      const b = publishBusArtifact(root, "same body");
      expect(a.ref.id).not.toBe(b.ref.id);
      expect(a.ref.sha256).toBe(b.ref.sha256); // digest IS content-derived
      expect(a.path).not.toBe(b.path);

      expect(resolveBusArtifact(root, a.ref).ok).toBe(true);
      expect(resolveBusArtifact(root, b.ref).ok).toBe(true);
      expect(readdirSync(root)).toHaveLength(2);
    });
  });

  test("ensureBusArtifactRoot is idempotent and tightens an existing dir", () => {
    withRoot((root) => {
      mkdirSync(root, { recursive: true, mode: 0o755 });
      ensureBusArtifactRoot(root);
      expect(statSync(root).mode & 0o777).toBe(0o700);
      // Second call is a clean no-op.
      expect(() => ensureBusArtifactRoot(root)).not.toThrow();
      expect(statSync(root).mode & 0o777).toBe(0o700);
    });
  });
});

// ---------------------------------------------------------------------------
// resolve: confinement + integrity
// ---------------------------------------------------------------------------

describe("resolveBusArtifact confinement + integrity", () => {
  test("rejects a malformed / traversal id without touching the filesystem", () => {
    withRoot((root) => {
      for (const id of ["../../etc/passwd", "a".repeat(31), "NOTHEX", ""]) {
        const r = resolveBusArtifact(root, goodRef({ id }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("malformed-id");
      }
    });
  });

  test("rejects a structurally invalid reference", () => {
    withRoot((root) => {
      for (const ref of [
        goodRef({ len: -1 }),
        goodRef({ len: 1.5 }),
        goodRef({ len: BUS_ARTIFACT_MAX_BYTES + 1 }),
        goodRef({ sha256: "xyz" }),
      ]) {
        const r = resolveBusArtifact(root, ref);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("malformed-ref");
      }
    });
  });

  test("rejects a missing artifact", () => {
    withRoot((root) => {
      ensureBusArtifactRoot(root);
      const r = resolveBusArtifact(root, goodRef({ id: hexId(7) }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("missing");
    });
  });

  test("rejects a symlink planted at the artifact path (symlink escape)", () => {
    withRoot((root) => {
      ensureBusArtifactRoot(root);
      const secretDir = mkdtempSync(join(tmpdir(), "bus-secret-"));
      try {
        const secret = join(secretDir, "secret.txt");
        writeFileSync(secret, "TOP SECRET");
        const id = hexId(9);
        symlinkSync(secret, join(root, id));
        const ref = goodRef({
          id,
          len: Buffer.byteLength("TOP SECRET", "utf8"),
          sha256: sha256Hex("TOP SECRET"),
        });
        const r = resolveBusArtifact(root, ref);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("not-regular");
        // The peer reference never became an arbitrary-file read.
        expect(existsSync(secret)).toBe(true);
      } finally {
        rmSync(secretDir, { recursive: true, force: true });
      }
    });
  });

  test("rejects a directory standing in for an artifact", () => {
    withRoot((root) => {
      ensureBusArtifactRoot(root);
      const id = hexId(11);
      mkdirSync(join(root, id));
      const r = resolveBusArtifact(root, goodRef({ id }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("not-regular");
    });
  });

  test("rejects an oversize on-disk body before reading it", () => {
    withRoot((root) => {
      ensureBusArtifactRoot(root);
      const id = hexId(13);
      // On disk is > cap; the ref's len stays within the structurally-valid
      // range, so oversize (size gate) fires — never a slurp into memory.
      writeFileSync(join(root, id), Buffer.alloc(BUS_ARTIFACT_MAX_BYTES + 1));
      const r = resolveBusArtifact(
        root,
        goodRef({ id, len: BUS_ARTIFACT_MAX_BYTES, sha256: "a".repeat(64) }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("oversize");
    });
  });

  test("rejects a byte-length mismatch", () => {
    withRoot((root) => {
      const { ref } = publishBusArtifact(root, "hello");
      const r = resolveBusArtifact(root, { ...ref, len: ref.len + 1 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("length-mismatch");
    });
  });

  test("rejects a digest mismatch (same length, tampered bytes)", () => {
    withRoot((root) => {
      const { ref, path } = publishBusArtifact(root, "hello");
      // Overwrite with a same-length but different body: length passes, digest
      // must catch the tamper.
      writeFileSync(path, "world"); // 5 bytes, like "hello"
      const r = resolveBusArtifact(root, ref);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("digest-mismatch");
    });
  });
});

// ---------------------------------------------------------------------------
// remove: confined + fail-soft
// ---------------------------------------------------------------------------

describe("removeBusArtifact", () => {
  test("removes a regular artifact and is idempotent", () => {
    withRoot((root) => {
      const { ref, path } = publishBusArtifact(root, "bye");
      expect(removeBusArtifact(root, ref.id)).toBe(true);
      expect(existsSync(path)).toBe(false);
      // Second remove is a clean no-op.
      expect(removeBusArtifact(root, ref.id)).toBe(false);
    });
  });

  test("refuses a malformed id (never unlinks outside the contract)", () => {
    withRoot((root) => {
      ensureBusArtifactRoot(root);
      expect(removeBusArtifact(root, "../../etc/passwd")).toBe(false);
      expect(removeBusArtifact(root, "a".repeat(31))).toBe(false);
    });
  });

  test("refuses to unlink a non-regular inode planted at the path", () => {
    withRoot((root) => {
      ensureBusArtifactRoot(root);
      const secretDir = mkdtempSync(join(tmpdir(), "bus-secret-"));
      try {
        const secret = join(secretDir, "keep.txt");
        writeFileSync(secret, "keep me");
        const id = hexId(21);
        symlinkSync(secret, join(root, id));
        expect(removeBusArtifact(root, id)).toBe(false);
        // The symlink target survives — remove never followed the link.
        expect(existsSync(secret)).toBe(true);
      } finally {
        rmSync(secretDir, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// listBusArtifactIds: bounded orphan enumeration
// ---------------------------------------------------------------------------

describe("listBusArtifactIds bounded pages", () => {
  test("paginates at the limit boundary", () => {
    withRoot((root) => {
      ensureBusArtifactRoot(root);
      const all: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const id = hexId(i);
        writeFileSync(join(root, id), `body ${i}`, { mode: 0o600 });
        all.push(id);
      }

      // A partial page: exactly `limit` ids, and more may remain.
      const page = listBusArtifactIds(root, 3);
      expect(page.ids).toHaveLength(3);
      expect(page.complete).toBe(false);
      for (const id of page.ids) expect(all).toContain(id);

      // A limit past the count drains the whole set and reports complete.
      const full = listBusArtifactIds(root, 10);
      expect([...full.ids].sort()).toEqual([...all].sort());
      expect(full.complete).toBe(true);
    });
  });

  test("returns only well-formed regular artifact files", () => {
    withRoot((root) => {
      ensureBusArtifactRoot(root);
      const real = hexId(1);
      writeFileSync(join(root, real), "real", { mode: 0o600 });
      // Noise the enumeration must skip:
      writeFileSync(join(root, `${real}.tmp.123.abc`), "partial write");
      writeFileSync(join(root, "not-an-id.txt"), "junk");
      mkdirSync(join(root, hexId(2))); // a dir named like an id
      symlinkSync(join(root, real), join(root, hexId(3))); // a symlink

      const page = listBusArtifactIds(root, 100);
      expect(page.ids).toEqual([real]);
      expect(page.complete).toBe(true);
    });
  });

  test("is fail-soft on a missing root and rejects a non-positive limit", () => {
    withRoot((root) => {
      // Missing root: empty + complete, never throws.
      const missing = listBusArtifactIds(root, 5);
      expect(missing.ids).toEqual([]);
      expect(missing.complete).toBe(true);

      ensureBusArtifactRoot(root);
      writeFileSync(join(root, hexId(1)), "x", { mode: 0o600 });
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        const r = listBusArtifactIds(root, bad);
        expect(r.ids).toEqual([]);
        expect(r.complete).toBe(false);
      }
    });
  });

  test("enumerate + remove drains the tree across bounded passes", () => {
    withRoot((root) => {
      ensureBusArtifactRoot(root);
      for (let i = 1; i <= 7; i++) {
        writeFileSync(join(root, hexId(i)), `b${i}`, { mode: 0o600 });
      }
      let removed = 0;
      let guard = 0;
      for (;;) {
        if (guard++ > 100) throw new Error("drain loop did not terminate");
        const page = listBusArtifactIds(root, 2);
        for (const id of page.ids) {
          if (removeBusArtifact(root, id)) removed++;
        }
        if (page.ids.length === 0) break;
      }
      expect(removed).toBe(7);
      expect(readdirSync(root)).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveBusArtifactRoot: derived from sandboxable bus state
// ---------------------------------------------------------------------------

describe("resolveBusArtifactRoot", () => {
  test("derives from KEEPER_BUS_DB, adding no new state class", () => {
    const prev = process.env.KEEPER_BUS_DB;
    try {
      const busDb = join(tmpdir(), "sandbox-x", "bus.db");
      process.env.KEEPER_BUS_DB = busDb;
      expect(resolveBusArtifactRoot()).toBe(
        join(dirname(busDb), "bus-artifacts"),
      );
    } finally {
      if (prev === undefined) delete process.env.KEEPER_BUS_DB;
      else process.env.KEEPER_BUS_DB = prev;
    }
  });
});
