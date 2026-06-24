/**
 * Ports system/tests/test_launcher_plan_role_names.py. The launcher hands
 * `--name <slug>` to the claude binary it spawns; this defends the launcher →
 * child-process arg for slash-command + slug-shaped-token prompts. Plan-role
 * `<role>::<id>` prefixes are owned upstream by keeper (passed via --name when
 * it dispatches); the launcher's slug-shortcut branch returns the BARE id for
 * every `/plan:*` slug launch — `/plan:close fn-388` → `fn-388`.
 *
 * Drives main() with the prompt as the sole arg; PWD is a real two-levels-under-
 * home project dir so the cwd gate passes silently, and the auto router is inert
 * (empty profile list + a "default" picker). The recorded spawn command carries
 * the resolved --name.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { main } from "../src/agent/main";
import {
  makeHarness,
  nameArg,
  runAndCapture,
} from "./helpers/agent-main-harness";

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = process.env;
});
afterEach(() => {
  process.env = savedEnv;
});

// A real project dir two levels under home → the cwd gate passes without a
// prompt (the gate reads the shell's logical $PWD).
const PROJECT_PWD = join(homedir(), "code", "proj");

async function nameForPrompt(prompt: string): Promise<string | null> {
  const h = makeHarness({
    argv: [prompt],
    env: { PWD: PROJECT_PWD },
  });
  const cmd = await runAndCapture(h, main);
  return nameArg(cmd);
}

describe("slug-shortcut yields the bare id in the launcher argv", () => {
  // /plan:* launches resolve to the bare id — keeper supplies the
  // `<role>::<id>` prefix via --name when it dispatches.
  test.each([
    ["/plan:close fn-388", "fn-388"],
    ["/plan:work fn-388.1", "fn-388.1"],
    ["/plan:work fn-7", "fn-7"],
  ])("%s -> --name %s", async (prompt, expected) => {
    expect(await nameForPrompt(prompt)).toBe(expected);
  });

  test("/plan:plan is also a slash-command + slug token → bare id", async () => {
    expect(await nameForPrompt("/plan:plan fn-388")).toBe("fn-388");
  });
});
