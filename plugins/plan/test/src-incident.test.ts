import { afterEach, expect, test } from "bun:test";

import { resetExec, setExec } from "../src/exec.ts";
import {
  INCIDENT_READ_MAX_BUFFER_BYTES,
  INCIDENT_READ_TIMEOUT_MS,
  resolveIncident,
} from "../src/incident.ts";

afterEach(() => {
  resetExec();
});

function installResult(stdout: string, exitCode = 0): string[][] {
  const calls: string[][] = [];
  setExec({
    run(command, argv) {
      calls.push([command, ...argv]);
      return { exitCode, stdout, stderr: "" };
    },
  });
  return calls;
}

test("resolveIncident returns null when the keeper read fails", () => {
  installResult("", 1);
  expect(resolveIncident("work::fn-8-owner.1")).toBeNull();
});

test("resolveIncident returns null for unsuccessful, malformed, and conflict-free briefs", () => {
  for (const stdout of [
    "not json",
    JSON.stringify({ ok: false }),
    JSON.stringify({ ok: true, incident: { conflict: null } }),
  ]) {
    installResult(stdout);
    expect(resolveIncident("close::fn-8-owner")).toBeNull();
  }
});

test("resolveIncident bounds the read-only keeper subprocess", () => {
  let seenOptions: unknown = null;
  setExec({
    run(_command, _argv, options) {
      seenOptions = options;
      return { exitCode: 1, stdout: "", stderr: "" };
    },
  });

  expect(resolveIncident("work::fn-8-owner.1")).toBeNull();
  expect(seenOptions).toEqual({
    timeoutMs: INCIDENT_READ_TIMEOUT_MS,
    maxBufferBytes: INCIDENT_READ_MAX_BUFFER_BYTES,
  });
});

test("resolveIncident rejects output beyond the post-seam cap", () => {
  installResult("x".repeat(INCIDENT_READ_MAX_BUFFER_BYTES + 1));
  expect(resolveIncident("work::fn-8-owner.1")).toBeNull();
});

test("resolveIncident maps a well-formed unclaimed brief through the read-only keeper command", () => {
  const calls = installResult(
    JSON.stringify({
      ok: true,
      kind: "deconflict",
      incident: {
        conflict: {
          instance_event_id: 51,
          attempt_id: 9,
          claim: null,
        },
        grant_ref: null,
      },
    }),
  );

  expect(resolveIncident("work::fn-8-owner.1")).toEqual({
    incident_id: "work::fn-8-owner.1",
    kind: "deconflict",
    instance_event_id: 51,
    attempt_id: 9,
    brief_ref: "work::fn-8-owner.1",
    grant_ref: null,
    claim: null,
  });
  expect(calls).toEqual([["keeper", "escalation-brief", "work::fn-8-owner.1"]]);
});

test("resolveIncident maps claim and grant identities from a populated brief", () => {
  installResult(
    JSON.stringify({
      ok: true,
      kind: "deconflict",
      incident: {
        conflict: {
          instance_event_id: 61,
          attempt_id: 11,
          claim: {
            session_id: "session-owner",
            pid: 4242,
            start_time: "proc:4242:1",
            claimed_at: 1_700_000_001,
          },
        },
        grant_ref: "/state/grants/grant-owner.json",
      },
    }),
  );

  expect(resolveIncident("close::fn-8-owner")).toEqual({
    incident_id: "close::fn-8-owner",
    kind: "deconflict",
    instance_event_id: 61,
    attempt_id: 11,
    brief_ref: "close::fn-8-owner",
    grant_ref: "/state/grants/grant-owner.json",
    claim: {
      session_id: "session-owner",
      pid: 4242,
      start_time: "proc:4242:1",
      claimed_at: 1_700_000_001,
    },
  });
});
