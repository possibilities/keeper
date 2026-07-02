/**
 * Unit tests for `keeper session-summary`'s pure core `loadSessionSummary`
 * (fn-1074.3). Driven in-process via `freshMemDb()` with synthetic `jobs` +
 * `events` rows — no daemon, no fs. Asserts the bounded summary shape, the
 * prompt-snippet truncation guard (the whole point of the verb), and the
 * not-found split (neither a job row nor any event).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { loadSessionSummary, MAX_SNIPPET_CHARS } from "../cli/session-summary";
import { freshMemDb } from "./helpers/template-db";

let db: Database;

beforeEach(() => {
  db = freshMemDb().db;
});

function seedJob(id: string, over: Record<string, unknown> = {}): void {
  db.query(
    `INSERT INTO jobs
       (job_id, created_at, updated_at, state, title, title_source,
        transcript_path, plan_verb, plan_ref, epic_links)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    (over.created_at as number) ?? 1000,
    (over.updated_at as number) ?? 2000,
    (over.state as string) ?? "ended",
    (over.title as string) ?? "My Session",
    (over.title_source as string) ?? "prompt",
    (over.transcript_path as string) ?? "/x/transcript.jsonl",
    (over.plan_verb as string) ?? null,
    (over.plan_ref as string) ?? null,
    (over.epic_links as string) ?? "[]",
  );
}

let ts = 0;
function seedEvent(
  sessionId: string,
  hook: string,
  data: string | null = null,
): void {
  db.query(
    `INSERT INTO events (ts, session_id, hook_event, event_type, data)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(++ts, sessionId, hook, hook, data);
}

const prompt = (text: string): string => JSON.stringify({ prompt: text });

describe("loadSessionSummary", () => {
  test("assembles title, prompts, counts, transcript_path from job + events", () => {
    seedJob("sess-A", { plan_verb: "work", plan_ref: "fn-9.1" });
    seedEvent("sess-A", "UserPromptSubmit", prompt("first human prompt"));
    seedEvent("sess-A", "PreToolUse");
    seedEvent("sess-A", "UserPromptSubmit", prompt("second/last prompt"));
    seedEvent("sess-A", "Stop");

    const r = loadSessionSummary(db, "sess-A");
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    const d = r.data;
    expect(d.session_id).toBe("sess-A");
    expect(d.title).toBe("My Session");
    expect(d.state).toBe("ended");
    expect(d.plan_verb).toBe("work");
    expect(d.plan_ref).toBe("fn-9.1");
    expect(d.transcript_path).toBe("/x/transcript.jsonl");
    expect(d.counts).toEqual({ events: 4, prompts: 2, tool_calls: 1 });
    expect(d.first_prompt?.text).toBe("first human prompt");
    expect(d.first_prompt?.truncated).toBe(false);
    expect(d.last_prompt?.text).toBe("second/last prompt");
  });

  test("truncates a long prompt snippet at maxSnippet (bounded output)", () => {
    seedJob("sess-B");
    const long = "x".repeat(MAX_SNIPPET_CHARS + 250);
    seedEvent("sess-B", "UserPromptSubmit", prompt(long));

    const r = loadSessionSummary(db, "sess-B", MAX_SNIPPET_CHARS);
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.data.first_prompt?.truncated).toBe(true);
    expect(r.data.first_prompt?.text.length).toBe(MAX_SNIPPET_CHARS);
  });

  test("a job with no events → ok, null prompts, zero counts", () => {
    seedJob("sess-C");
    const r = loadSessionSummary(db, "sess-C");
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.data.first_prompt).toBeNull();
    expect(r.data.last_prompt).toBeNull();
    expect(r.data.counts.events).toBe(0);
    expect(r.data.title).toBe("My Session");
  });

  test("events but no job row → ok, null job fields, real counts", () => {
    seedEvent("sess-D", "UserPromptSubmit", prompt("orphan prompt"));
    const r = loadSessionSummary(db, "sess-D");
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.data.title).toBeNull();
    expect(r.data.transcript_path).toBeNull();
    expect(r.data.counts.events).toBe(1);
    expect(r.data.first_prompt?.text).toBe("orphan prompt");
  });

  test("neither a job row nor any event → not_found", () => {
    seedJob("sess-A");
    seedEvent("sess-A", "UserPromptSubmit", prompt("x"));
    expect(loadSessionSummary(db, "ghost-session").kind).toBe("not_found");
  });

  test("decodes epic_links; a malformed blob folds to []", () => {
    seedJob("sess-E", { epic_links: '[{"kind":"created","epic_id":"fn-9"}]' });
    seedEvent("sess-E", "UserPromptSubmit", prompt("hi"));
    const r = loadSessionSummary(db, "sess-E");
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.data.epic_links).toEqual([{ kind: "created", epic_id: "fn-9" }]);

    seedJob("sess-F", { epic_links: "not json" });
    seedEvent("sess-F", "UserPromptSubmit", prompt("hi"));
    const r2 = loadSessionSummary(db, "sess-F");
    if (r2.kind !== "ok") throw new Error("expected ok");
    expect(r2.data.epic_links).toEqual([]);
  });
});
