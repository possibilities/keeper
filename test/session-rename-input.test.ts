import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  buildSessionRenameInput,
  buildSessionRenameInputFromSections,
  findSessionRenamePathReferences,
  SESSION_RENAME_MAX_AGGREGATE_FILE_BYTES,
  SESSION_RENAME_MAX_FILE_BYTES,
  SESSION_RENAME_MAX_INPUT_BYTES,
  type SessionRenameInputFileSystem,
  type SessionRenameInputStat,
} from "../src/session-rename-input";
import { projectClaudeNamingSections } from "../src/transcript/claude";

const PROJECT = "/project";

type FakeKind = "file" | "directory" | "symlink" | "special";

interface FakeEntry {
  kind: FakeKind;
  bytes: Buffer;
  canonical: string;
  identity: number;
  raceAfterRead?: boolean;
}

class FakeRenameFs implements SessionRenameInputFileSystem {
  readonly entries = new Map<string, FakeEntry>();
  readonly calls: string[] = [];
  readonly readBytes = new Map<string, number>();
  private readonly handles = new Map<
    number,
    { path: string; offset: number; read: boolean }
  >();
  private nextFd = 10;

  constructor() {
    this.add(PROJECT, "", "directory");
  }

  add(
    path: string,
    content: string | Uint8Array,
    kind: FakeKind = "file",
    canonical = path,
    raceAfterRead = false,
  ): void {
    this.entries.set(resolve(path), {
      kind,
      bytes:
        typeof content === "string"
          ? Buffer.from(content, "utf8")
          : Buffer.from(content),
      canonical: resolve(canonical),
      identity: this.entries.size + 1,
      raceAfterRead,
    });
  }

  private entry(path: string): FakeEntry {
    const entry = this.entries.get(resolve(path));
    if (entry === undefined) throw new Error("missing");
    return entry;
  }

  private statFor(entry: FakeEntry, changed = false): SessionRenameInputStat {
    const mode =
      entry.kind === "file"
        ? 0o100644
        : entry.kind === "directory"
          ? 0o040755
          : entry.kind === "symlink"
            ? 0o120777
            : 0o010644;
    return {
      dev: 1,
      ino: entry.identity,
      mode,
      size: entry.bytes.byteLength,
      mtimeMs: changed ? 2 : 1,
      ctimeMs: 1,
      isFile: () => entry.kind === "file",
      isSymbolicLink: () => entry.kind === "symlink",
    };
  }

  realpath(path: string): string {
    const absolute = resolve(path);
    this.calls.push(`realpath:${absolute}`);
    return this.entry(absolute).canonical;
  }

  lstat(path: string): SessionRenameInputStat {
    const absolute = resolve(path);
    this.calls.push(`lstat:${absolute}`);
    return this.statFor(this.entry(absolute));
  }

  open(path: string): number {
    const absolute = resolve(path);
    this.calls.push(`open:${absolute}`);
    const entry = this.entry(absolute);
    if (entry.kind !== "file") throw new Error("not regular");
    const fd = this.nextFd++;
    this.handles.set(fd, { path: absolute, offset: 0, read: false });
    return fd;
  }

  fstat(fd: number): SessionRenameInputStat {
    const handle = this.handles.get(fd);
    if (handle === undefined) throw new Error("bad fd");
    const entry = this.entry(handle.path);
    return this.statFor(entry, entry.raceAfterRead === true && handle.read);
  }

  read(fd: number, buffer: Uint8Array, offset: number, length: number): number {
    const handle = this.handles.get(fd);
    if (handle === undefined) throw new Error("bad fd");
    const entry = this.entry(handle.path);
    const count = Math.min(length, entry.bytes.byteLength - handle.offset);
    if (count <= 0) return 0;
    buffer.set(
      entry.bytes.subarray(handle.offset, handle.offset + count),
      offset,
    );
    handle.offset += count;
    handle.read = true;
    this.readBytes.set(
      handle.path,
      (this.readBytes.get(handle.path) ?? 0) + count,
    );
    return count;
  }

  close(fd: number): void {
    this.handles.delete(fd);
  }
}

function claudeRecord(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function message(
  type: "user" | "assistant",
  uuid: string,
  parentUuid: string | null,
  content: unknown,
  extra: Record<string, unknown> = {},
): string {
  return claudeRecord({
    type,
    uuid,
    parentUuid,
    message: { role: type, content },
    ...extra,
  });
}

describe("Claude Session rename projection", () => {
  test("follows the selected active branch and retains compaction chronology", () => {
    const lines = [
      message("user", "old-user", null, "Old context"),
      message("assistant", "abandoned", "old-user", "Abandoned answer"),
      claudeRecord({
        type: "system",
        subtype: "compact_boundary",
        uuid: "boundary",
        parentUuid: null,
      }),
      message("user", "summary", "boundary", "Compacted goal", {
        isCompactSummary: true,
      }),
      message(
        "user",
        "request",
        "summary",
        "<command-name>/fix</command-name><command-args>Fix ranking</command-args>",
      ),
      message("assistant", "answer", "request", [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "Ranking is ready" },
        { type: "tool_use", name: "Read", input: { path: "/secret" } },
        { type: "image", source: { data: "image-data" } },
      ]),
      message("user", "meta", "answer", "injected metadata", { isMeta: true }),
      claudeRecord({ type: "custom-title", customTitle: "Native title" }),
      claudeRecord({ type: "last-prompt", leafUuid: "answer" }),
    ];
    const transcript = `${lines.join("\n")}\n`;

    expect(
      buildSessionRenameInput({
        transcript,
        cutoffBytes: Buffer.byteLength(transcript),
        projectDir: PROJECT,
      }),
    ).toBe(
      "Conversation summary: Compacted goal\n\nUser: Fix ranking\n\nAssistant: Ranking is ready",
    );
  });

  test("honors a byte cutoff and drops a partial trailing record", () => {
    const first = message("user", "one", null, "First request");
    const second = message("assistant", "two", "one", "Later answer");
    const title = claudeRecord({
      type: "custom-title",
      uuid: "title-record",
      parentUuid: null,
      customTitle: "Native title",
    });
    const transcript = `${first}\n${second}\n${title}\n`;
    const partialCutoff = Buffer.byteLength(`${first}\n${second.slice(0, 12)}`);

    expect(projectClaudeNamingSections(transcript, partialCutoff)).toEqual([
      { role: "user", text: "First request" },
    ]);
    expect(
      projectClaudeNamingSections(transcript, Buffer.byteLength(transcript)),
    ).toEqual([
      { role: "user", text: "First request" },
      { role: "assistant", text: "Later answer" },
    ]);
  });

  test("caps final UTF-8 output and preserves the 2:1 user allocation", () => {
    const output = buildSessionRenameInputFromSections(
      [
        { role: "user", text: "u".repeat(500) },
        { role: "assistant", text: "a".repeat(500) },
      ],
      { projectDir: PROJECT, maxBytes: 79 },
    );

    expect(Buffer.byteLength(output ?? "", "utf8")).toBe(79);
    const users = /User: (u*)/.exec(output ?? "")?.[1]?.length ?? 0;
    const assistants = /Assistant: (a*)/.exec(output ?? "")?.[1]?.length ?? 0;
    expect(users).toBe(assistants * 2);
  });
});

describe("Session rename path references", () => {
  test("recognizes prose grammar while excluding code and emails", () => {
    const text = [
      "Read @src/a.ts, @\"docs/name file.md\" and @'docs/other file.md'.",
      "Also @/project/absolute.ts @~/home.ts @file:///project/url.ts.",
      "Ignore me@example.com and `@inline.ts`.",
      "```ts",
      "@fenced.ts",
      "```",
      "After @src/final.ts!",
    ].join("\n");

    expect(findSessionRenamePathReferences(text)).toEqual([
      "src/a.ts",
      "docs/name file.md",
      "docs/other file.md",
      "/project/absolute.ts",
      "~/home.ts",
      "file:///project/url.ts",
      "src/final.ts",
    ]);
  });

  test("performs no filesystem calls when ordinary text has no references", () => {
    const fs = new FakeRenameFs();
    const output = buildSessionRenameInputFromSections(
      [
        { role: "user", text: "Mail me@example.com or use `@code.ts`" },
        { role: "assistant", text: "Assistant mentions @never-read.ts" },
      ],
      { projectDir: PROJECT, fileSystem: fs },
    );

    expect(output).toContain("Mail me@example.com");
    expect(fs.calls).toEqual([]);
  });

  test("expands contained regular files once with project-relative labels", () => {
    const fs = new FakeRenameFs();
    fs.add("/project/src/a.ts", "ranking implementation");
    fs.add("/project/docs/name file.md", "design notes");
    fs.add("/project/home.ts", "home-relative context");
    fs.add("/project/url.ts", "file URL context");
    const output = buildSessionRenameInputFromSections(
      [
        {
          role: "user",
          text: 'Use @missing.ts, @src/a.ts, @/project/src/a.ts, @"docs/name file.md", @~/home.ts and @file:///project/url.ts.',
        },
      ],
      { projectDir: PROJECT, homeDir: PROJECT, fileSystem: fs },
    );

    expect(output).toContain('[Referenced file unavailable: "missing.ts"]');
    expect(output).toContain(
      '[Referenced file: "src/a.ts"]\nranking implementation',
    );
    expect(output).toContain(
      '[Referenced file: "docs/name file.md"]\ndesign notes',
    );
    expect(output).toContain(
      '[Referenced file: "home.ts"]\nhome-relative context',
    );
    expect(output).toContain('[Referenced file: "url.ts"]\nfile URL context');
    expect(output?.match(/ranking implementation/g)).toHaveLength(1);
    expect(
      fs.calls.filter((call) => call === "open:/project/src/a.ts"),
    ).toHaveLength(1);
    expect(output).not.toContain('[Referenced file: "/project');
  });

  test("marks containment and file-type failures without reading content", () => {
    const fs = new FakeRenameFs();
    fs.add("/project/link.ts", "", "symlink", "/outside/secret.ts");
    fs.add("/project/folder", "", "directory");
    fs.add("/project/pipe", "", "special");
    fs.add("/project/binary", new Uint8Array([65, 0, 66]));
    fs.add("/project/invalid", new Uint8Array([0xc3, 0x28]));
    fs.add("/project/race", "transient", "file", "/project/race", true);
    const output = buildSessionRenameInputFromSections(
      [
        {
          role: "user",
          text: "Check @../secret.ts @/outside/secret.ts @link.ts @folder @pipe @binary @invalid @race",
        },
      ],
      { projectDir: PROJECT, fileSystem: fs },
    );

    expect(output?.match(/\[Referenced file unavailable/g)).toHaveLength(8);
    expect(output).not.toContain("transient");
    expect(fs.calls.some((call) => call.startsWith("open:/outside"))).toBe(
      false,
    );
    expect(fs.calls.some((call) => call === "open:/project/link.ts")).toBe(
      false,
    );
    expect(fs.calls.some((call) => call === "open:/project/folder")).toBe(
      false,
    );
    expect(fs.calls.some((call) => call === "open:/project/pipe")).toBe(false);
  });

  test("pins per-file, aggregate, UTF-8, unique-reference, and final ceilings", () => {
    const fs = new FakeRenameFs();
    fs.add(
      "/project/one",
      `${"a".repeat(SESSION_RENAME_MAX_FILE_BYTES - 1)}😀tail`,
    );
    fs.add("/project/two", "b".repeat(9_000));
    fs.add("/project/three", "c".repeat(9_000));
    for (let index = 4; index <= 10; index += 1) {
      fs.add(`/project/${index}`, `file-${index}`);
    }
    const output = buildSessionRenameInputFromSections(
      [
        {
          role: "user",
          text: `Keep intent @one @one @two @three ${Array.from({ length: 7 }, (_, index) => `@${index + 4}`).join(" ")}`,
        },
      ],
      { projectDir: PROJECT, fileSystem: fs },
    );

    expect(Buffer.byteLength(output ?? "", "utf8")).toBeLessThanOrEqual(
      SESSION_RENAME_MAX_INPUT_BYTES,
    );
    expect(output).toContain("Keep intent");
    expect(output).not.toContain("�");
    expect(output).toContain("[Referenced file truncated]");
    expect(fs.readBytes.get("/project/one")).toBe(
      SESSION_RENAME_MAX_FILE_BYTES,
    );
    expect(fs.readBytes.get("/project/two")).toBe(
      SESSION_RENAME_MAX_AGGREGATE_FILE_BYTES - SESSION_RENAME_MAX_FILE_BYTES,
    );
    expect(fs.readBytes.has("/project/three")).toBe(false);
    expect(output?.match(/\[Referenced file(?::| unavailable:)/g)).toHaveLength(
      8,
    );
    expect(
      [...fs.readBytes.values()].reduce((total, bytes) => total + bytes, 0),
    ).toBe(SESSION_RENAME_MAX_AGGREGATE_FILE_BYTES);
    expect(fs.calls.filter((call) => call.startsWith("open:"))).toHaveLength(2);
  });
});
