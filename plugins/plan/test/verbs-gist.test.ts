// Engine-agnostic conformance spec for `planctl gist <epic_id>` — translated
// from tests/test_gist.py, every node mapped by a source-comment. gist renders
// an epic's TOC + epic spec + every task spec into a temp dir and shells
// `gh gist create --desc <desc> [--public] <files...>`, taking the last stdout
// line as the URL. The gh dependency is the whole contract, so every test stubs
// gh through the external-command driver registry (fakeCommand) that records its
// argv and returns a controlled URL/exit — no PATH shim, no real binary.
//
// --no-open on every call so no browser opens. Runs in the default tier
// in-process; zero real git, zero binary spawn.

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fakeCommand, runCli, seedState, withTmpdir } from "./harness.ts";

// First JSON object on stdout carrying a gist/error/success key. Port of the
// pytest _envelope raw-decode scan (format_output pretty-prints, so the
// envelope spans lines).
function envelope(output: string): Record<string, unknown> {
  let i = 0;
  while (i < output.length) {
    const brace = output.indexOf("{", i);
    if (brace === -1) {
      break;
    }
    for (let end = output.length; end > brace; end--) {
      if (output[end - 1] !== "}") {
        continue;
      }
      try {
        const obj = JSON.parse(output.slice(brace, end)) as Record<
          string,
          unknown
        >;
        if ("gist_url" in obj || "error" in obj || "success" in obj) {
          return obj;
        }
      } catch {
        // shrink
      }
    }
    i = brace + 1;
  }
  throw new Error(`no gist envelope in ${output}`);
}

let root: string;
const getTmp = withTmpdir("planctl-gist-");
beforeEach(() => {
  root = getTmp();
});

function seed(nTasks = 2): string {
  const [epicId] = seedState(root, { epicId: "fn-7-gist-demo", nTasks });
  return epicId;
}

describe("gist", () => {
  test("success envelope pins {gist_url, epic_id, file_count, public}", () => {
    // test_gist.py::test_gist_success_envelope
    fakeCommand("gh", { stdout: "https://gist.github.com/deadbeef" });
    const epicId = seed(2);
    const r = runCli(["gist", epicId, "--no-open"], { cwd: root });
    expect(r.code).toBe(0);
    const env = envelope(r.output);
    expect(env.gist_url).toBe("https://gist.github.com/deadbeef");
    expect(env.epic_id).toBe(epicId);
    // TOC + epic spec + one file per task.
    expect(env.file_count).toBe(2 + 2);
    expect(env.public).toBe(false);
  });

  test("file set passed to gh: `gist create --desc <desc> <files...>`", () => {
    // test_gist.py::test_gist_file_set_passed_to_gh
    const gh = fakeCommand("gh", { stdout: "https://gist.github.com/abc123" });
    const epicId = seed(2);
    const r = runCli(["gist", epicId, "--no-open"], { cwd: root });
    expect(r.code).toBe(0);
    const argv = gh.lastArgv();
    expect(argv.slice(0, 3)).toEqual(["gist", "create", "--desc"]);
    expect(argv).not.toContain("--public");
    const files = argv.slice(4).filter((a) => a.endsWith(".md"));
    expect(files.length).toBe(4);
    expect(files.some((f) => f.endsWith("00-TOC.md"))).toBe(true);
  });

  test("--public rides into the gh argv and the envelope", () => {
    // test_gist.py::test_gist_public_flag
    const gh = fakeCommand("gh", { stdout: "https://gist.github.com/abc123" });
    const epicId = seed(1);
    const r = runCli(["gist", epicId, "--public", "--no-open"], { cwd: root });
    expect(r.code).toBe(0);
    expect(envelope(r.output).public).toBe(true);
    expect(gh.lastArgv()).toContain("--public");
  });

  test("the rendered TOC carries no Branch line", () => {
    const captureDir = join(root, "captured");
    fakeCommand("gh", {
      stdout: "https://gist.github.com/abc123",
      captureDir,
    });
    const epicId = seed(1);
    const r = runCli(["gist", epicId, "--no-open"], { cwd: root });
    expect(r.code).toBe(0);
    const toc = readFileSync(join(captureDir, "00-TOC.md"), "utf-8");
    expect(toc).not.toContain("**Branch:**");
  });

  test("a non-zero gh exit surfaces an error envelope, not a URL", () => {
    // test_gist.py::test_gist_gh_failure
    fakeCommand("gh", { exitCode: 1 });
    const epicId = seed(1);
    const r = runCli(["gist", epicId, "--no-open"], { cwd: root });
    expect(r.code).not.toBe(0);
    const env = envelope(r.output);
    const errMsg =
      typeof env.error === "object" && env.error !== null
        ? ((env.error as Record<string, unknown>).message as string)
        : String(env.error ?? "");
    expect(errMsg).toContain("gh gist create failed");
  });
});
