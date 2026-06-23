// Unit tests for src/format.ts — the emitter spine. Byte-parity is pinned
// against the Python wire spec (planctl/_util.py): pretty JSON with a single
// trailing newline + preserved unicode, and the compact trailer serializer.

import { describe, expect, test } from "bun:test";

import { compactJson, jsonDumps } from "../src/format.ts";

describe("jsonDumps", () => {
  test("2-space indent + one trailing newline", () => {
    expect(jsonDumps({ success: true, epics: [] })).toBe(
      '{\n  "success": true,\n  "epics": []\n}\n',
    );
  });

  test("preserves unicode unescaped (ensure_ascii=False parity)", () => {
    expect(jsonDumps({ title: "Café résumé ☕" })).toBe(
      '{\n  "title": "Café résumé ☕"\n}\n',
    );
  });

  test("nested objects pretty-print like the Python pins", () => {
    expect(
      jsonDumps({
        success: true,
        project: { name: "x", path: "/r", schema_version: 0 },
      }),
    ).toBe(
      "{\n" +
        '  "success": true,\n' +
        '  "project": {\n' +
        '    "name": "x",\n' +
        '    "path": "/r",\n' +
        '    "schema_version": 0\n' +
        "  }\n" +
        "}\n",
    );
  });
});

describe("compactJson", () => {
  test("no spaces — the trailer serializer", () => {
    const envelope = {
      plan_invocation: {
        files: null,
        op: "state-path",
        target: null,
        subject: null,
        touched_path_files: [],
        repo_root: "/r",
        state_repo: "/r",
      },
    };
    expect(compactJson(envelope)).toBe(
      '{"plan_invocation":{"files":null,"op":"state-path","target":null,' +
        '"subject":null,"touched_path_files":[],"repo_root":"/r","state_repo":"/r"}}',
    );
  });
});
