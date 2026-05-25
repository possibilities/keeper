import { expect, test } from "bun:test";
import { extractFileTouches, parsePorcelainV2 } from "../src/git-worker";

test("parsePorcelainV2 captures branch metadata and dirty file statuses", () => {
  const raw = [
    "# branch.oid abc123",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 aaaaa bbbbb src/a.ts",
    "? src/new file.ts",
    "2 R. N... 100644 100644 100644 aaaaa bbbbb R100 src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0");

  const parsed = parsePorcelainV2(raw);
  expect(parsed.branch).toBe("main");
  expect(parsed.head_oid).toBe("abc123");
  expect(parsed.upstream).toBe("origin/main");
  expect(parsed.ahead).toBe(2);
  expect(parsed.behind).toBe(1);
  expect(parsed.files).toEqual([
    {
      path: "src/a.ts",
      xy: ".M",
      index: ".",
      worktree: "M",
      kind: "ordinary",
    },
    {
      path: "src/new file.ts",
      xy: "??",
      index: "?",
      worktree: "?",
      kind: "untracked",
    },
    {
      path: "src/new-name.ts",
      xy: "R.",
      index: "R",
      worktree: ".",
      kind: "renamed",
      orig_path: "src/old-name.ts",
    },
  ]);
});

test("extractFileTouches resolves Claude file-tool paths relative to the git root", () => {
  const touches = extractFileTouches(
    {
      tool_name: "Edit",
      cwd: "/repo/packages/app",
      data: JSON.stringify({
        tool_input: { file_path: "src/page.tsx" },
      }),
    },
    "/repo",
  );

  expect(touches).toEqual([
    { path: "packages/app/src/page.tsx", ops: ["update"] },
  ]);
});

test("extractFileTouches drops paths outside the git root", () => {
  const touches = extractFileTouches(
    {
      tool_name: "Write",
      cwd: "/repo",
      data: JSON.stringify({
        tool_input: { file_path: "/tmp/outside.txt" },
      }),
    },
    "/repo",
  );

  expect(touches).toEqual([]);
});

test("extractFileTouches ignores Read so reads don't get attributed as dirty", () => {
  const touches = extractFileTouches(
    {
      tool_name: "Read",
      cwd: "/repo",
      data: JSON.stringify({
        tool_input: { file_path: "src/page.tsx" },
      }),
    },
    "/repo",
  );

  expect(touches).toEqual([]);
});
