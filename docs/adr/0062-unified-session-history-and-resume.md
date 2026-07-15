# 62. Unified session history and foreground resume

## Status

Accepted.

## Context

Keeper exposes Harness session information through several independent surfaces. Native transcript readers discover conversations across projects, while database readers expose tracked jobs, events, titles, and file attribution. Their selectors and coverage differ: some require a Keeper job id, transcript reads require a harness-native id, title lookup is available only on selected job commands, and prompt and file searches are separate top-level verbs.

A Harness session may exist without a Keeper job, and a tracked job id may differ from its harness-native resume target. Session titles are mutable and reusable; Keeper's bounded job-name history is useful lookup metadata but is not a complete title timeline. Native transcript artifacts remain the broadest source for conversation content and title records.

Keeper's main database is an event-sourced control-data store. Full-text transcript search is disposable derived data over external artifacts, with different rebuild, retention, and privacy needs. File-path text in a transcript also does not prove that a mutation occurred.

Foreground continuation has a different interaction contract from detached partner resume and crash restore. A human-facing command needs cross-harness selection, visible ambiguity, project-directory validation, native trust prompts, and terminal job-control behavior.

## Decision

Keeper has one Session catalog for supported Claude and Pi Harness sessions. The catalog joins native transcript artifacts with optional Keeper job aliases, resume targets, title records, and lifecycle metadata without making a job row or title the session's identity.

A Session reference resolves in deterministic tiers: an explicitly harness-qualified native id, an exact Keeper job id, an exact native id, then an exact case-insensitive current or historical Session title. The unqualified native-id tier requires native artifact evidence; an artifact-less job's claimed resume target remains addressable by qualified native id or exact job id but cannot shadow the title of an artifact-backed Session. Distinct matching Harness sessions remain ambiguous; normal reads return structured candidates, and foreground resume may offer a TTY picker. No resolver silently chooses the newest title match. Titles select a Harness session but never become a Harness resume key.

`keeper history` is the canonical traversal surface:

- `list` discovers cataloged sessions across projects;
- `show` renders bounded transcript content;
- `search` searches normalized transcript entries with structured session, project, role, source, and time filters;
- `files` returns provenance-graded file evidence and keeps observed mutation, possible mutation, and textual mention distinct;
- `index` reports, refreshes, rebuilds, and purges the derived search store.

Existing session-targeting reads resolve through the same Session reference contract while retaining honest capability errors for cataloged sessions that are not Keeper-tracked. The specialist transcript surface remains available for harness-specific operations such as Claude subagent selection and Pi branch-aware latest-turn extraction.

Full-text search uses a private, independently versioned SQLite FTS History index under Keeper's state directory. Native transcript artifacts are authoritative; the History index is disposable, incrementally refreshed from source fingerprints, and replaced atomically on rebuild or incompatible schema. It never joins Keeper's migration ladder or Re-fold contract. Literal search is the default; advanced FTS syntax is explicit. Semantic embeddings are not part of this contract.

File evidence carries source and confidence. Canonical successful mutation facts may establish an observed mutation; bounded shell inference may establish only a possible mutation; transcript text and tool references establish a mention. Path normalization never upgrades uncertain evidence.

`keeper resume <session-reference>` resolves to one harness-native target, applies Refuse-live when positive process identity exists, validates the artifact-derived project directory, and delegates foreground execution to the supported harness through Keeper's existing descriptor and process-control seams. A wrong directory launches nothing and emits a shell-safe command that changes to the resolved directory and re-invokes `keeper resume` with an unambiguous reference. Missing artifacts, conflicting identities, absent directories, unsupported harnesses, and unreadable resume targets fail rather than falling back to another session or directory.

The separate prompt-only and live-attribution history verbs are removed from the public CLI in the same cutover as their in-repository callers, help, completions, skills, tests, and documentation.

This decision supersedes ADR 0034. Its title-is-not-identity and Refuse-live rules remain in force through the catalog and foreground-resume contracts; its detached partner implementation remains a separate surface.

## Alternatives considered

- **Expand every existing command independently.** Rejected because selector precedence, ambiguity, standalone-session coverage, and title history would continue to drift.
- **Use Keeper jobs as the catalog.** Rejected because supported native sessions may exist without Keeper lifecycle rows and job identity may differ from the native resume target.
- **Put FTS tables in `keeper.db`.** Rejected because transcript search is rebuildable derived data over external files and must not enlarge the deterministic event-sourced projection contract.
- **Search native files from scratch for every query.** Rejected because repeated multi-project scans make agent traversal unnecessarily expensive and cannot cheaply retain complete alias metadata.
- **Treat path mentions as mutations.** Rejected because model text, attempted tools, reads, and arbitrary shell commands do not prove filesystem effects.
- **Keep newest-match resume behavior.** Rejected because mutable or reused titles make an implicit recency choice capable of resuming the wrong conversation.
- **Add semantic embeddings with full-text search.** Rejected from this contract because provider choice, content disclosure, model versioning, cost, and purge semantics require an explicit separate decision.

## Consequences

- Agents and humans use one selector grammar across session traversal and continuation.
- Standalone Claude and Pi sessions are discoverable, searchable, and resumable when their native artifacts provide the required facts; Keeper-only reads report that an otherwise valid session is not tracked.
- Complete historical-title resolution depends on native title records when available and reports reduced coverage for artifact-less jobs.
- Search results carry stable session and entry provenance suitable for opening surrounding context.
- The History index duplicates sensitive local transcript text and therefore requires owner-only directories/files, redacted diagnostics, bounded queries, and whole-store purge/rebuild behavior; it does not add at-rest encryption beyond the existing local-user trust boundary.
- Pi's tree remains one Harness session. Search retains branch/entry provenance, display defaults to the selected branch, and Pi owns which native branch continuation resumes.
- Foreground resume preserves native harness trust and permission behavior and remains distinct from detached partner resume and generation restore.
