import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import {
  gitInit,
  parseCliOutput,
  runCli,
  seedState,
  withTmpdir,
} from "./harness.ts";

describe("epics project identity", () => {
  const tmp = withTmpdir("planctl-epics-");

  test("JSON and human output identify the cwd-resolved project", () => {
    const parent = tmp();
    const project = join(parent, "alpha");
    mkdirSync(project);
    gitInit(project);
    seedState(project, { epicId: "fn-1-alpha", title: "Alpha board" });

    const json = runCli(["epics"], { cwd: project });
    const human = runCli(["epics", "--format", "human"], { cwd: project });
    const help = runCli(["epics", "--help"], { cwd: project });
    const root = realpathSync(project);
    const envelope = parseCliOutput(json.output) as {
      project: { name: string; path: string };
    };

    expect(json.code).toBe(0);
    expect(envelope.project).toEqual({ name: "alpha", path: root });
    expect(human.code).toBe(0);
    expect(human.stdout).toStartWith(`Project: alpha (${root})\n`);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("resolved project name and path");
  });

  test("separate project boards report distinct identities", () => {
    const parent = tmp();
    const alpha = join(parent, "alpha");
    const beta = join(parent, "beta");
    for (const project of [alpha, beta]) {
      mkdirSync(project);
      gitInit(project);
    }
    seedState(alpha, { epicId: "fn-1-alpha", title: "Alpha board" });
    seedState(beta, { epicId: "fn-1-beta", title: "Beta board" });

    const alphaEnvelope = parseCliOutput(
      runCli(["epics"], { cwd: alpha }).output,
    ) as {
      project: { name: string; path: string };
      epics: { id: string }[];
    };
    const betaEnvelope = parseCliOutput(
      runCli(["epics"], { cwd: beta }).output,
    ) as {
      project: { name: string; path: string };
      epics: { id: string }[];
    };

    expect(alphaEnvelope.project).toEqual({
      name: "alpha",
      path: realpathSync(alpha),
    });
    expect(betaEnvelope.project).toEqual({
      name: "beta",
      path: realpathSync(beta),
    });
    expect(alphaEnvelope.epics).toEqual([
      expect.objectContaining({ id: "fn-1-alpha" }),
    ]);
    expect(betaEnvelope.epics).toEqual([
      expect.objectContaining({ id: "fn-1-beta" }),
    ]);
  });

  test("no-project error remains unchanged", () => {
    const project = tmp();
    gitInit(project);

    const result = runCli(["epics"], { cwd: project });

    expect(result.code).toBe(1);
    expect(parseCliOutput(result.output)).toEqual({
      success: false,
      error: "No plan project found. Run 'keeper plan init' first.",
    });
  });
});
