import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  parseIncidentArgs,
  parseIncidentKey,
  runIncident,
} from "../cli/incident";
import type { IncidentClaimRequest } from "../src/incident-claim-store";

function sink() {
  let stdout = "";
  let stderr = "";
  return {
    value: {
      writeStdout: (text: string) => {
        stdout += text;
      },
      writeStderr: (text: string) => {
        stderr += text;
      },
      exit: (code: number): never => {
        throw new Error(`unexpected exit ${code}`);
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function parsedArgs(argv: string[]) {
  const parsed = parseIncidentArgs(argv);
  if (!parsed.ok) throw new Error(`expected parsed args: ${parsed.message}`);
  return parsed.args;
}

test("parseIncidentKey accepts work and close dispatch keys and rejects other shapes", () => {
  expect(parseIncidentKey("work::fn-1-owner.1")).toEqual({
    verb: "work",
    id: "fn-1-owner.1",
  });
  expect(parseIncidentKey("close::fn-1-owner")).toEqual({
    verb: "close",
    id: "fn-1-owner",
  });
  expect(parseIncidentKey("resolve::fn-1-owner.1")).toBeNull();
  expect(parseIncidentKey("work::fn-1-owner")).toBeNull();
  expect(parseIncidentKey("close::fn-1-owner.1")).toBeNull();
  expect(parseIncidentKey("work::")).toBeNull();
  expect(parseIncidentKey("work-fn-1-owner.1")).toBeNull();
});

test("parseIncidentArgs handles claim, release, help, bad subcommands, and a missing instance", () => {
  expect(
    parseIncidentArgs([
      "claim",
      "work::fn-1-owner.1",
      "--instance",
      "17",
      "--session-id",
      "session-owner",
    ]),
  ).toEqual({
    ok: true,
    args: {
      action: "claim",
      key: "work::fn-1-owner.1",
      instance: "17",
      sessionId: "session-owner",
    },
  });
  expect(
    parseIncidentArgs(["release", "close::fn-1-owner", "--instance", "18"]),
  ).toEqual({
    ok: true,
    args: {
      action: "release",
      key: "close::fn-1-owner",
      instance: "18",
      sessionId: null,
    },
  });
  expect(parseIncidentArgs(["--help"])).toEqual({
    ok: false,
    help: true,
    message: null,
  });
  expect(parseIncidentArgs(["claim", "--help"])).toEqual({
    ok: false,
    help: true,
    message: null,
  });
  expect(parseIncidentArgs(["take", "work::fn-1-owner.1"])).toMatchObject({
    ok: false,
    help: false,
  });
  expect(parseIncidentArgs(["claim", "work::fn-1-owner.1"])).toEqual({
    ok: true,
    args: {
      action: "claim",
      key: "work::fn-1-owner.1",
      instance: null,
      sessionId: null,
    },
  });
});

test("runIncident writes exactly one fully-fenced request and returns success", () => {
  const output = sink();
  const writes: Array<{ path: string; request: IncidentClaimRequest }> = [];
  const args = parsedArgs(["claim", "work::fn-1-owner.1", "--instance", "73"]);
  const result = runIncident(args, output.value, {
    env: { KEEPER_JOB_ID: "session-owner" },
    stateDir: "/isolated/state",
    now: () => 1_700_000_000_000,
    requestId: () => "request-id",
    write: (path, request) => writes.push({ path, request }),
  });

  const expectedPath = join(
    "/isolated/state",
    "incident-claims",
    "requests",
    "request-id.json",
  );
  expect(result).toEqual({
    exitCode: EXIT_OK,
    requestPath: expectedPath,
  });
  expect(writes).toEqual([
    {
      path: expectedPath,
      request: {
        schema_version: 1,
        action: "claim",
        verb: "work",
        id: "fn-1-owner.1",
        instance_event_id: 73,
        claimant_session_id: "session-owner",
        requested_at: 1_700_000_000_000,
      },
    },
  ]);
  expect(JSON.parse(output.stdout())).toMatchObject({
    ok: true,
    incident_id: "work::fn-1-owner.1",
    instance_event_id: 73,
    claimant_session_id: "session-owner",
  });
  expect(output.stderr()).toBe("");
});

test("runIncident reports persistence failure without claiming success", () => {
  const output = sink();
  const result = runIncident(
    parsedArgs(["claim", "work::fn-1-owner.1", "--instance", "73"]),
    output.value,
    {
      env: { KEEPER_JOB_ID: "session-owner" },
      write: () => {
        throw new Error("disk full");
      },
    },
  );

  expect(result).toEqual({ exitCode: EXIT_ERROR, requestPath: null });
  expect(output.stdout()).toBe("");
  expect(output.stderr()).toContain("disk full");
});

test("runIncident returns usage without writing for invalid keys, missing fences, and missing sessions", () => {
  const cases = [
    {
      argv: ["claim", "resolve::fn-1-owner.1", "--instance", "7"],
      env: { KEEPER_JOB_ID: "session-owner" },
    },
    {
      argv: ["claim", "work::fn-1-owner.1"],
      env: { KEEPER_JOB_ID: "session-owner" },
    },
    {
      argv: ["claim", "work::fn-1-owner.1", "--instance", "7"],
      env: {},
    },
  ];

  for (const fixture of cases) {
    const output = sink();
    let writes = 0;
    const result = runIncident(parsedArgs(fixture.argv), output.value, {
      env: fixture.env,
      write: () => {
        writes += 1;
      },
    });
    expect(result).toEqual({ exitCode: EXIT_USAGE, requestPath: null });
    expect(writes).toBe(0);
    expect(output.stderr().length).toBeGreaterThan(0);
  }
});
