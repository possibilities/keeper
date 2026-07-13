/**
 * resume-resolve tests — disk-anchored claude cwd resolution and the non-claude
 * artifact-existence gates, exercised against an in-memory {@link ResumeResolveFs}
 * fake (no real fs, hermetic). Covers the four claude cases the epic names —
 * rehomed transcript, zero-match, multi-match with tail-cwd disambiguation,
 * multi-match unresolvable — plus torn-tail safety, the vanished-resolved-cwd
 * risk guard, realpath dedup, and the pi/codex/hermes existence gates.
 */
import { expect, test } from "bun:test";
import { basename, dirname, join } from "node:path";
import {
  claudeCwdSlug,
  makeResumeResolver,
  newestTailCwd,
  type ResumeResolveFs,
  resolveClaudeCwd,
  resolveNonClaudeArtifact,
} from "../src/resume-resolve";

// ---------------------------------------------------------------------------
// In-memory fs fake — files keyed by absolute path, dirs derived from ancestors.
// ---------------------------------------------------------------------------
interface FakeFsSpec {
  /** Absolute file path → contents. */
  files?: Record<string, string>;
  /** Extra directories that exist with no files under them (e.g. a live cwd). */
  dirs?: string[];
  /** path → realpath target, for the symlinked-projects dedup case. */
  symlinks?: Record<string, string>;
}
function makeFakeFs(spec: FakeFsSpec): ResumeResolveFs {
  const files = spec.files ?? {};
  const symlinks = spec.symlinks ?? {};
  const filePaths = Object.keys(files);
  const dirSet = new Set<string>(spec.dirs ?? []);
  for (const p of [...filePaths, ...(spec.dirs ?? [])]) {
    let d = dirname(p);
    while (d !== "" && d !== "/" && d !== ".") {
      dirSet.add(d);
      d = dirname(d);
    }
  }
  // Follow a symlinked prefix, mirroring how readdir/stat resolve a symlinked
  // directory — so a path UNDER a symlinked dir reaches the physical contents.
  const canon = (p: string): string => {
    for (const [src, target] of Object.entries(symlinks)) {
      if (p === src) {
        return target;
      }
      if (p.startsWith(`${src}/`)) {
        return target + p.slice(src.length);
      }
    }
    return p;
  };
  return {
    listDir(dir) {
      const real = canon(dir);
      const children = new Set<string>();
      for (const p of [...filePaths, ...dirSet]) {
        if (p !== real && dirname(p) === real) {
          children.add(basename(p));
        }
      }
      return [...children];
    },
    exists(path) {
      const real = canon(path);
      return files[real] !== undefined || dirSet.has(real);
    },
    realpath(path) {
      return canon(path);
    },
    readTail(path, maxBytes) {
      const content = files[canon(path)];
      if (content === undefined) {
        return null;
      }
      const bytes = Buffer.from(content, "utf8");
      const start = bytes.length > maxBytes ? bytes.length - maxBytes : 0;
      return { text: bytes.toString("utf8", start), fromStart: start === 0 };
    },
  };
}
/** A claude transcript line carrying a top-level `cwd`, newline-terminated. */
function transcriptLine(cwd: string): string {
  return `${JSON.stringify({ type: "user", cwd })}\n`;
}
const ROOT = "/home/tester/.claude";
const UUID = "51ee6f32-dead-beef-0000-000000000001";
// ---------------------------------------------------------------------------
// claudeCwdSlug — the lossy forward-only slug
// ---------------------------------------------------------------------------
test("claudeCwdSlug collapses both / and . to -", () => {
  // Hand-computed against the spec: `/` and `.` both become `-`.
  expect(claudeCwdSlug("/Users/mike/code/keeper")).toBe(
    "-Users-mike-code-keeper",
  );
  expect(claudeCwdSlug("/Users/mike/.pi/agent")).toBe("-Users-mike--pi-agent");
});
// ---------------------------------------------------------------------------
// newestTailCwd — torn-tail safety
// ---------------------------------------------------------------------------
test("newestTailCwd returns the newest COMPLETE line's cwd, dropping torn head + tail", () => {
  // A torn head (read began mid-line), two complete lines, then a torn trailing
  // partial (mid-write, no newline). The newest COMPLETE cwd is `/b`.
  const text = `rbage","cwd":"/torn-head"}\n${transcriptLine("/a")}${transcriptLine("/b")}{"type":"user","cwd":"/torn`;
  expect(newestTailCwd({ text, fromStart: false })).toBe("/b");
});
test("newestTailCwd keeps the first line when the read began at byte 0", () => {
  const text = transcriptLine("/only");
  expect(newestTailCwd({ text, fromStart: true })).toBe("/only");
});
test("newestTailCwd drops the first line when the read did NOT begin at byte 0", () => {
  // fromStart false ⇒ the sole segment is a torn head and is dropped.
  const text = transcriptLine("/only");
  expect(newestTailCwd({ text, fromStart: false })).toBeNull();
});
test("newestTailCwd skips lines with no cwd and returns null when none carries one", () => {
  const text = `${JSON.stringify({ type: "summary" })}\n${JSON.stringify({ type: "system" })}\n`;
  expect(newestTailCwd({ text, fromStart: true })).toBeNull();
});
// ---------------------------------------------------------------------------
// resolveClaudeCwd — the four cases
// ---------------------------------------------------------------------------
test("rehomed transcript resolves to the transcript's holding dir, not the recorded cwd", () => {
  // Recorded cwd A drifted; the transcript lives under the slug of B and its
  // tail carries cwd B. Resolution must be B (independent fixture constant).
  const A = "/Users/mike/old-worktree";
  const B = "/Users/mike/code/keeper";
  const slugB = "-Users-mike-code-keeper";
  const fs = makeFakeFs({
    files: {
      [join(ROOT, "projects", slugB, `${UUID}.jsonl`)]: transcriptLine(B),
    },
    dirs: [B], // B still exists on disk (the risk guard checks this).
  });
  const res = resolveClaudeCwd(fs, {
    sessionId: UUID,
    recordedCwd: A,
    projectRoots: [ROOT],
    observedCwds: [A],
  });
  expect(res).toEqual({ kind: "resolved", cwd: B });
});
test("zero-match: no transcript on disk is a preflight failure with the fixing command", () => {
  const fs = makeFakeFs({ files: {} });
  const res = resolveClaudeCwd(fs, {
    sessionId: UUID,
    recordedCwd: "/Users/mike/gone",
    projectRoots: [ROOT],
    observedCwds: ["/Users/mike/gone"],
  });
  expect(res.kind).toBe("preflight-failed");
  if (res.kind === "preflight-failed") {
    expect(res.found).toEqual([]);
    expect(res.reason).toContain(UUID);
    expect(res.fixCommand).toContain("no transcript");
  }
});
test("multi-match with tail-cwd disambiguation resolves to the slug-matching holding dir", () => {
  // The same uuid.jsonl copied under two holding dirs (a rehome). Only the copy
  // under slug(B) has a tail cwd that slug-matches its holding dir ⇒ resolves B.
  const A = "/Users/mike/old-a";
  const B = "/Users/mike/code/keeper";
  const slugA = claudeCwdSlug(A);
  const slugB = claudeCwdSlug(B);
  const fs = makeFakeFs({
    files: {
      // Rehomed copy under A's slug still carries B in its tail (slug mismatch).
      [join(ROOT, "projects", slugA, `${UUID}.jsonl`)]: transcriptLine(B),
      [join(ROOT, "projects", slugB, `${UUID}.jsonl`)]: transcriptLine(B),
    },
    dirs: [B],
  });
  const res = resolveClaudeCwd(fs, {
    sessionId: UUID,
    recordedCwd: A,
    projectRoots: [ROOT],
    observedCwds: [A],
  });
  expect(res).toEqual({ kind: "resolved", cwd: B });
});
test("multi-match unresolvable (two confident cwds) is a preflight failure naming both", () => {
  const A = "/Users/mike/proj-a";
  const B = "/Users/mike/proj-b";
  const slugA = claudeCwdSlug(A);
  const slugB = claudeCwdSlug(B);
  const fs = makeFakeFs({
    files: {
      // Each copy's tail slug-matches its OWN holding dir ⇒ two confident cwds.
      [join(ROOT, "projects", slugA, `${UUID}.jsonl`)]: transcriptLine(A),
      [join(ROOT, "projects", slugB, `${UUID}.jsonl`)]: transcriptLine(B),
    },
    dirs: [A, B],
  });
  const res = resolveClaudeCwd(fs, {
    sessionId: UUID,
    recordedCwd: A,
    projectRoots: [ROOT],
    observedCwds: [A],
  });
  expect(res.kind).toBe("preflight-failed");
  if (res.kind === "preflight-failed") {
    expect(res.found.sort()).toEqual([A, B].sort());
    expect(res.reason).toContain("ambiguous");
    expect(res.fixCommand).toContain(`claude --resume "${UUID}"`);
  }
});
test("observed-cwd history disambiguates when no transcript tail carries a cwd", () => {
  // The transcript exists under slug(B) but its tail has no cwd field; the
  // observed-cwd history's B slug-matches the holding dir ⇒ resolves B.
  const B = "/Users/mike/code/keeper";
  const slugB = claudeCwdSlug(B);
  const fs = makeFakeFs({
    files: {
      [join(ROOT, "projects", slugB, `${UUID}.jsonl`)]:
        `${JSON.stringify({ type: "summary" })}\n`,
    },
    dirs: [B],
  });
  const res = resolveClaudeCwd(fs, {
    sessionId: UUID,
    recordedCwd: B,
    projectRoots: [ROOT],
    observedCwds: [B],
  });
  expect(res).toEqual({ kind: "resolved", cwd: B });
});
test("a resolved cwd that no longer exists on disk fails preflight, naming the project dir", () => {
  // Torn-down worktree: the transcript resolves to B, but B is gone from disk.
  const B = "/Users/mike/torn-down-worktree";
  const slugB = claudeCwdSlug(B);
  const projectDir = join(ROOT, "projects", slugB);
  const fs = makeFakeFs({
    files: { [join(projectDir, `${UUID}.jsonl`)]: transcriptLine(B) },
    // NOTE: B is intentionally NOT in dirs — it no longer exists.
  });
  const res = resolveClaudeCwd(fs, {
    sessionId: UUID,
    recordedCwd: B,
    projectRoots: [ROOT],
    observedCwds: [B],
  });
  expect(res.kind).toBe("preflight-failed");
  if (res.kind === "preflight-failed") {
    expect(res.reason).toContain("no longer exists");
    expect(res.found).toEqual([projectDir]);
    expect(res.fixCommand).not.toContain("cd $HOME");
  }
});
test("realpath-deduped roots never double-count a symlinked projects dir", () => {
  // Two roots whose projects/ realpath to the SAME physical dir (profiles share
  // projects/ via symlink). A single transcript must resolve, NOT read as an
  // ambiguous multi-match from being seen twice.
  const B = "/Users/mike/code/keeper";
  const slugB = claudeCwdSlug(B);
  const altRoot = "/home/tester/.claude-profiles/other";
  const canonicalProjects = join(ROOT, "projects");
  const fs = makeFakeFs({
    files: {
      [join(canonicalProjects, slugB, `${UUID}.jsonl`)]: transcriptLine(B),
    },
    dirs: [B],
    // The alt profile's projects/ is a symlink to the canonical one.
    symlinks: { [join(altRoot, "projects")]: canonicalProjects },
  });
  const res = resolveClaudeCwd(fs, {
    sessionId: UUID,
    recordedCwd: B,
    projectRoots: [altRoot, ROOT],
    observedCwds: [B],
  });
  expect(res).toEqual({ kind: "resolved", cwd: B });
});
// ---------------------------------------------------------------------------
// resolveNonClaudeArtifact — the existence gates
// ---------------------------------------------------------------------------
const HOME = "/home/tester";
const PI_TARGET = "d98a2d54-pi00-0000-0000-000000000002";
test("pi: a session file under the cwd's pi project dir is resumable", () => {
  const cwd = "/Users/mike/code/arthack";
  // encodePiCwd(cwd) = --Users-mike-code-arthack--
  const piDir = join(
    HOME,
    ".pi",
    "agent",
    "sessions",
    "--Users-mike-code-arthack--",
  );
  const fs = makeFakeFs({
    files: { [join(piDir, `2026-07-07T00:00:00_${PI_TARGET}.jsonl`)]: "{}\n" },
  });
  const res = resolveNonClaudeArtifact(fs, {
    harness: "pi",
    resumeTarget: PI_TARGET,
    cwd,
    homeDir: HOME,
    env: {},
  });
  expect(res).toEqual({ kind: "resumable" });
});
test("pi: a target with no on-disk session file is not-resumable with a reason", () => {
  const fs = makeFakeFs({ files: {} });
  const res = resolveNonClaudeArtifact(fs, {
    harness: "pi",
    resumeTarget: PI_TARGET,
    cwd: "/Users/mike/code/arthack",
    homeDir: HOME,
    env: {},
  });
  expect(res.kind).toBe("not-resumable");
  if (res.kind === "not-resumable") {
    expect(res.reason).toContain(PI_TARGET);
  }
});
test("pi: a session drifted onto a DIFFERENT cwd dir is still found by the sessions scan", () => {
  // The recorded cwd is /Users/mike/here, but the session file sits under a
  // different cwd's dir — the fallback scan of sessions/* finds it by uuid.
  const otherDir = join(
    HOME,
    ".pi",
    "agent",
    "sessions",
    "--Users-mike-elsewhere--",
  );
  const fs = makeFakeFs({
    files: {
      [join(otherDir, `2026-07-07T00:00:00_${PI_TARGET}.jsonl`)]: "{}\n",
    },
  });
  const res = resolveNonClaudeArtifact(fs, {
    harness: "pi",
    resumeTarget: PI_TARGET,
    cwd: "/Users/mike/here",
    homeDir: HOME,
    env: {},
  });
  expect(res).toEqual({ kind: "resumable" });
});
test("hermes: gated on the session store's presence", () => {
  const store = join(HOME, ".hermes", "state.db");
  const present = makeFakeFs({ files: { [store]: "sqlite" } });
  expect(
    resolveNonClaudeArtifact(present, {
      harness: "hermes",
      resumeTarget: "hermes-id",
      cwd: "/repo",
      homeDir: HOME,
      env: {},
    }),
  ).toEqual({ kind: "resumable" });
  const absent = makeFakeFs({ files: {} });
  expect(
    resolveNonClaudeArtifact(absent, {
      harness: "hermes",
      resumeTarget: "hermes-id",
      cwd: "/repo",
      homeDir: HOME,
      env: {},
    }).kind,
  ).toBe("not-resumable");
});
test("non-claude with an empty resume target is not-resumable (no artifact to name)", () => {
  const fs = makeFakeFs({ files: {} });
  const res = resolveNonClaudeArtifact(fs, {
    harness: "pi",
    resumeTarget: "",
    cwd: "/repo",
    homeDir: HOME,
    env: {},
  });
  expect(res.kind).toBe("not-resumable");
});
// ---------------------------------------------------------------------------
// makeResumeResolver — the candidate → verdict seam
// ---------------------------------------------------------------------------
test("makeResumeResolver routes claude to disk anchoring and non-claude to the gate", () => {
  const B = "/Users/mike/code/keeper";
  const slugB = claudeCwdSlug(B);
  const piDir = join(
    HOME,
    ".pi",
    "agent",
    "sessions",
    "--Users-mike-code-keeper--",
  );
  const fs = makeFakeFs({
    files: {
      [join(HOME, ".claude", "projects", slugB, `${UUID}.jsonl`)]:
        transcriptLine(B),
      [join(piDir, `ts_${PI_TARGET}.jsonl`)]: "{}\n",
    },
    dirs: [B],
  });
  const resolver = makeResumeResolver({ fs, homeDir: HOME, env: {} });
  expect(
    resolver({
      job_id: UUID,
      resume_target: UUID,
      cwd: "/stale",
      harness: "claude",
    }),
  ).toEqual({ kind: "resolved", cwd: B });
  expect(
    resolver({
      job_id: "pi-job",
      resume_target: PI_TARGET,
      cwd: B,
      harness: "pi",
    }),
  ).toEqual({ kind: "resumable" });
  expect(
    resolver({
      job_id: "pi-gone",
      resume_target: "no-such-pi",
      cwd: B,
      harness: "pi",
    }).kind,
  ).toBe("not-resumable");
});
