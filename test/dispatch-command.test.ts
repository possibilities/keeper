/**
 * Unit tests for the dep-free `src/dispatch-command.ts` leaf module: the
 * `${verb}::${id}` validator (discriminated result), `defaultPlanPrompt`, the
 * byte-pinned `buildDispatchLaunchArgv` builder, and the prompt-bytes guard
 * (NUL / oversize rejection + adversarial byte-faithful pass-through).
 */

import { expect, test } from "bun:test";
import {
  buildDispatchLaunchArgv,
  defaultPlanPrompt,
  formatDispatchAttemptCarrier,
  isRetryableDispatchKey,
  PROMPT_MAX_BYTES,
  parseDispatchAttemptCarrier,
  parseDispatchKey,
  validatePromptBytes,
} from "../src/dispatch-command";

test("Dispatch-attempt carrier accepts only bounded positive safe integers", () => {
  expect(parseDispatchAttemptCarrier("42")).toBe(42);
  for (const value of [
    undefined,
    "",
    "0",
    "-1",
    "01",
    "1;echo",
    "9".repeat(20),
  ]) {
    expect(parseDispatchAttemptCarrier(value)).toBeNull();
  }
  expect(formatDispatchAttemptCarrier(42)).toBe("42");
  expect(formatDispatchAttemptCarrier(Number.NaN)).toBe("");
  expect(formatDispatchAttemptCarrier(-1)).toBe("");
});

// ---------------------------------------------------------------------------
// parseDispatchKey — discriminated result
// ---------------------------------------------------------------------------

test("parseDispatchKey: splits the composite key into {ok, verb, id}", () => {
  expect(parseDispatchKey("work::fn-1-foo.3")).toEqual({
    ok: true,
    verb: "work",
    id: "fn-1-foo.3",
  });
  expect(parseDispatchKey("close::fn-1-foo")).toEqual({
    ok: true,
    verb: "close",
    id: "fn-1-foo",
  });
  // `approve` is accepted SOLELY for the operator-clear path (fn-870) —
  // `retry_dispatch` on a resurrected/phantom `approve` pending. The
  // reconciler never dispatches `approve` itself.
  expect(parseDispatchKey("approve::fn-1-foo")).toEqual({
    ok: true,
    verb: "approve",
    id: "fn-1-foo",
  });
});

test("parseDispatchKey: rejects empty / non-string / missing-separator inputs", () => {
  for (const bad of ["", undefined, null, 42, true, "no-sep", "work::"]) {
    const r = parseDispatchKey(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  }
});

test("isRetryableDispatchKey: a clearable composite vs. an un-retryable raw-path key", () => {
  // A normal plan/close key is retryable (the operator can `keeper autopilot retry` it).
  expect(isRetryableDispatchKey("close", "fn-1-foo")).toBe(true);
  expect(isRetryableDispatchKey("work", "fn-1-foo.3")).toBe(true);
  // A slugged recover key (separators stripped) is retryable too.
  expect(
    isRetryableDispatchKey("close", "worktree-recover:Users-mike-code-arthack"),
  ).toBe(true);
  // The legacy raw-path recover key embeds `/` → un-retryable; the boot GC sweeps it.
  expect(
    isRetryableDispatchKey(
      "close",
      "worktree-recover:/Users/mike/code/arthack",
    ),
  ).toBe(false);
});

test("parseDispatchKey: rejects unknown verbs (repair no longer a retry-wire verb)", () => {
  for (const bad of [
    "rm::fn-1-foo",
    "plan::fn-1-foo",
    "exec::fn-1-foo",
    "repair::keeper-qzvs8i",
  ]) {
    expect(parseDispatchKey(bad).ok).toBe(false);
  }
});

test("parseDispatchKey: rejects nested `::` separators (no command injection)", () => {
  expect(parseDispatchKey("work::fn-1::pwned").ok).toBe(false);
});

test("parseDispatchKey: rejects path-traversal tokens in the id half", () => {
  for (const bad of [
    "work::../etc/passwd",
    "work::/abs/path",
    "work::a/b",
    "work::a\\b",
    "work::.hidden",
    "work::a\0b",
  ]) {
    expect(parseDispatchKey(bad).ok).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// defaultPlanPrompt
// ---------------------------------------------------------------------------

test("defaultPlanPrompt: composes the canonical /plan:<verb> <id> prompt", () => {
  expect(defaultPlanPrompt("work", "fn-1-foo.3")).toBe("/plan:work fn-1-foo.3");
  expect(defaultPlanPrompt("close", "fn-1-foo")).toBe("/plan:close fn-1-foo");
});

// ---------------------------------------------------------------------------
// buildDispatchLaunchArgv — byte-pinned
// ---------------------------------------------------------------------------

test("buildDispatchLaunchArgv: emits the `$@` positional form with an explicit argv[0]", () => {
  const argv = buildDispatchLaunchArgv("/bin/zsh", {
    cwd: "/repo",
    claudeName: "work::fn-1-foo.1",
    prompt: "/plan:work fn-1-foo.1",
    noConfirm: true,
  });
  expect(argv).toEqual([
    "/bin/zsh",
    "-l",
    "-i",
    "-c",
    'exec claude "$@" ; exec "$0" -l -i',
    // explicit $0 slot — without it the first flag is eaten as $0
    "/bin/zsh",
    "--x-no-confirm",
    "--name",
    "work::fn-1-foo.1",
    // prompt is the FINAL positional element
    "/plan:work fn-1-foo.1",
  ]);
});

test("buildDispatchLaunchArgv: includes --model / --effort ONLY when supplied", () => {
  const argv = buildDispatchLaunchArgv("/bin/zsh", {
    cwd: "/repo",
    claudeName: "scratch",
    prompt: "investigate X",
    model: "sonnet",
    effort: "max",
    noConfirm: true,
  });
  expect(argv).toEqual([
    "/bin/zsh",
    "-l",
    "-i",
    "-c",
    'exec claude "$@" ; exec "$0" -l -i',
    "/bin/zsh",
    "--model",
    "sonnet",
    "--effort",
    "max",
    "--x-no-confirm",
    "--name",
    "scratch",
    "investigate X",
  ]);
});

test("buildDispatchLaunchArgv: omits --name entirely when claudeName is absent", () => {
  const argv = buildDispatchLaunchArgv("/bin/zsh", {
    cwd: "/repo",
    prompt: "investigate X",
    noConfirm: true,
  });
  expect(argv).not.toContain("--name");
  expect(argv).toEqual([
    "/bin/zsh",
    "-l",
    "-i",
    "-c",
    'exec claude "$@" ; exec "$0" -l -i',
    "/bin/zsh",
    "--x-no-confirm",
    // no --name pair — prompt is the FINAL positional
    "investigate X",
  ]);
});

test("buildDispatchLaunchArgv: emits --name verbatim when claudeName is supplied", () => {
  const argv = buildDispatchLaunchArgv("/bin/zsh", {
    cwd: "/repo",
    claudeName: "scratch",
    prompt: "investigate X",
    noConfirm: true,
  });
  const i = argv.indexOf("--name");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(argv[i + 1]).toBe("scratch");
});

test("buildDispatchLaunchArgv: omits --x-no-confirm when noConfirm is false", () => {
  const argv = buildDispatchLaunchArgv("/bin/bash", {
    cwd: "/repo",
    claudeName: "scratch",
    prompt: "hi",
    noConfirm: false,
  });
  expect(argv).not.toContain("--x-no-confirm");
  expect(argv).not.toContain("--model");
  expect(argv).not.toContain("--effort");
  // Still has the fixed scaffold + name + prompt.
  expect(argv).toEqual([
    "/bin/bash",
    "-l",
    "-i",
    "-c",
    'exec claude "$@" ; exec "$0" -l -i',
    "/bin/bash",
    "--name",
    "scratch",
    "hi",
  ]);
});

test("buildDispatchLaunchArgv: an adversarial prompt rides byte-faithful as the final positional (zero shell escaping)", () => {
  const nasty = [
    "single ' quote",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${...}` is the adversarial byte content under test
    "$VAR and ${BRACED}",
    "back`tick`s",
    "$(rm -rf /)",
    "line one\nline two",
    "semis ; and && pipes |",
    "-leading-dash",
  ].join(" :: ");
  const argv = buildDispatchLaunchArgv("/bin/zsh", {
    cwd: "/repo",
    claudeName: "adv",
    prompt: nasty,
    noConfirm: true,
  });
  // The prompt is the LAST element and is byte-identical to the input — no
  // quoting, no escaping, no interpolation. The `-c` body never references the
  // prompt text, so none of these classes can fire.
  expect(argv.at(-1)).toBe(nasty);
  expect(argv[4]).toBe('exec claude "$@" ; exec "$0" -l -i');
});

// ---------------------------------------------------------------------------
// validatePromptBytes — NUL / oversize rejection
// ---------------------------------------------------------------------------

test("validatePromptBytes: accepts an ordinary prompt", () => {
  expect(validatePromptBytes("investigate the flaky test")).toEqual({
    ok: true,
  });
});

test("validatePromptBytes: rejects a NUL byte", () => {
  const r = validatePromptBytes("before\0after");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/NUL/);
});

test("validatePromptBytes: accepts a prompt exactly at the cap, rejects one byte over", () => {
  const atCap = "a".repeat(PROMPT_MAX_BYTES);
  expect(validatePromptBytes(atCap)).toEqual({ ok: true });

  const overCap = "a".repeat(PROMPT_MAX_BYTES + 1);
  const r = validatePromptBytes(overCap);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/per-arg cap/);
});

test("validatePromptBytes: counts UTF-8 BYTES, not code points", () => {
  // A 4-byte emoji repeated to one byte over the cap (code-point count is
  // ~1/4 of PROMPT_MAX_BYTES, so a naive `.length` check would pass).
  const emoji = "😀"; // 4 UTF-8 bytes
  const count = Math.floor(PROMPT_MAX_BYTES / 4) + 1;
  const big = emoji.repeat(count);
  expect(big.length).toBeLessThan(PROMPT_MAX_BYTES);
  expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(PROMPT_MAX_BYTES);
  expect(validatePromptBytes(big).ok).toBe(false);
});
