/**
 * cwd-confirm gate: a project dir exactly two levels under home passes silently;
 * anywhere else warns and gates on a keystroke (y/Y continues, anything else
 * exits 1). The keystroke read, exit, and stdout are injected.
 */

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkCwdInProjectRoot } from "../src/agent/cwd-confirm";

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}
const throwingExit = (code: number): never => {
  throw new ExitSignal(code);
};

describe("checkCwdInProjectRoot", () => {
  test("a two-levels-under-home dir passes silently", () => {
    const log: string[] = [];
    const out: string[] = [];
    checkCwdInProjectRoot(
      log,
      () => "n",
      throwingExit,
      (s) => out.push(s),
      { PWD: join(homedir(), "code", "foo") },
    );
    expect(out).toEqual([]);
    expect(log[0]).toContain("CWD is a project dir under home");
  });

  test("too-shallow warns and 'y' continues", () => {
    const log: string[] = [];
    const out: string[] = [];
    checkCwdInProjectRoot(
      log,
      () => "y",
      throwingExit,
      (s) => out.push(s),
      { PWD: join(homedir(), "code") },
    );
    expect(out.join("")).toContain("not a project directory");
    expect(log.some((l) => l.includes("Human confirmed"))).toBe(true);
  });

  test("a non-'y' keystroke exits 1", () => {
    const log: string[] = [];
    expect(() =>
      checkCwdInProjectRoot(
        log,
        () => "n",
        throwingExit,
        () => {},
        {
          PWD: "/tmp",
        },
      ),
    ).toThrow(ExitSignal);
  });

  test("outside home warns (depth 0)", () => {
    const out: string[] = [];
    expect(() =>
      checkCwdInProjectRoot(
        [],
        () => "n",
        throwingExit,
        (s) => out.push(s),
        {
          PWD: "/",
        },
      ),
    ).toThrow(ExitSignal);
    expect(out.join("")).toContain("not a project directory");
  });

  test("deeper-than-two warns", () => {
    const out: string[] = [];
    expect(() =>
      checkCwdInProjectRoot(
        [],
        () => "N",
        throwingExit,
        (s) => out.push(s),
        {
          PWD: join(homedir(), "code", "foo", "bar"),
        },
      ),
    ).toThrow(ExitSignal);
  });
});
