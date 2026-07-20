import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRequest,
  INCIDENT_CLAIM_REQUEST_SCHEMA_VERSION,
  MAX_ID_BYTES,
  MAX_REQUEST_BYTES,
  parseRequest,
  readSpool,
  removeRequest,
  requestPath,
  writeRequest,
} from "../src/incident-claim-store";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "incident-claim-store-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function request() {
  return buildRequest({
    action: "claim",
    verb: "work",
    id: "fn-2-incident-store.1",
    instanceEventId: 73,
    claimantSessionId: "session-owner",
    requestedAt: 1_700_000_000_000,
  });
}

test("buildRequest and parseRequest round-trip the spool contract", () => {
  const built = request();
  expect(parseRequest(JSON.stringify(built))).toEqual(built);
});

test("parseRequest rejects oversized and structurally invalid request bodies", () => {
  const valid = request();
  const { instance_event_id: _instanceEventId, ...missingInstance } = valid;
  expect(parseRequest("x".repeat(MAX_REQUEST_BYTES + 1))).toBeNull();
  expect(
    parseRequest(JSON.stringify({ ...valid, schema_version: 999 })),
  ).toBeNull();
  expect(
    parseRequest(JSON.stringify({ ...valid, action: "takeover" })),
  ).toBeNull();
  expect(parseRequest(JSON.stringify(missingInstance))).toBeNull();
  expect(
    parseRequest(JSON.stringify({ ...valid, instance_event_id: 0 })),
  ).toBeNull();
  expect(
    parseRequest(JSON.stringify({ ...valid, instance_event_id: 1.5 })),
  ).toBeNull();
  expect(
    parseRequest(JSON.stringify({ ...valid, instance_event_id: "73" })),
  ).toBeNull();
  expect(parseRequest(JSON.stringify({ ...valid, verb: "repair" }))).toBeNull();
  expect(
    parseRequest(
      JSON.stringify({ ...valid, verb: "work", id: "fn-2-incident-store" }),
    ),
  ).toBeNull();
  expect(
    parseRequest(
      JSON.stringify({
        ...valid,
        claimant_session_id: "é".repeat(MAX_ID_BYTES),
      }),
    ),
  ).toBeNull();
  expect(
    parseRequest(JSON.stringify({ ...valid, requested_at: null })),
  ).toBeNull();
});

test("writeRequest, readSpool, and removeRequest round-trip in an isolated state dir", () => {
  const built = request();
  const path = requestPath("request-1", stateDir);
  writeRequest(path, built);

  expect(readSpool(stateDir)).toEqual([{ path, request: built }]);
  removeRequest(path);
  expect(readSpool(stateDir)).toEqual([]);
  expect(() => removeRequest(path)).not.toThrow();
});

test("a symlinked spool directory is neither read nor used for deletion", () => {
  const outside = mkdtempSync(join(tmpdir(), "incident-claim-outside-"));
  const unrelated = join(outside, "unrelated.json");
  writeFileSync(unrelated, "{}", "utf8");
  mkdirSync(join(stateDir, "incident-claims"), { recursive: true });
  symlinkSync(outside, join(stateDir, "incident-claims", "requests"));
  try {
    expect(readSpool(stateDir)).toEqual([]);
    expect(existsSync(unrelated)).toBe(true);
    expect(() =>
      writeRequest(requestPath("request-2", stateDir), request()),
    ).toThrow("incident-claim spool directory is not confined");
    expect(existsSync(join(outside, "request-2.json"))).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlinked incident-claim root cannot redirect spool reads or writes", () => {
  const outside = mkdtempSync(join(tmpdir(), "incident-claim-root-outside-"));
  mkdirSync(join(outside, "requests"), { recursive: true });
  symlinkSync(outside, join(stateDir, "incident-claims"));
  try {
    expect(readSpool(stateDir)).toEqual([]);
    expect(() =>
      writeRequest(requestPath("request-root-link", stateDir), request()),
    ).toThrow("incident-claim spool directory is not confined");
    expect(
      existsSync(join(outside, "requests", "request-root-link.json")),
    ).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("writeRequest rejects an invalid identity before touching the spool", () => {
  const invalid = { ...request(), verb: "repair" };
  const path = requestPath("invalid-request", stateDir);
  expect(() => writeRequest(path, invalid)).toThrow(
    "invalid incident-claim request",
  );
  expect(readSpool(stateDir)).toEqual([]);
});

test("the request schema version remains explicit in built records", () => {
  expect(request().schema_version).toBe(INCIDENT_CLAIM_REQUEST_SCHEMA_VERSION);
});
