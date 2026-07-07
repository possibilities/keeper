## Description

**Size:** M
**Files:** plugins/plan/template/agents/worker.md.tmpl, plugins/plan/template/_partials/worker-implement-native.md, plugins/plan/template/_partials/worker-implement-wrapped.md, plugins/prompt/test/oracle/fixtures/render-plugin-templates.json, plugins/prompt/test/oracle/fixtures/check-generated.json

### Approach

worker.md.tmpl becomes the composed shell rendering both cell kinds. Frontmatter branches
on the driver binding: native keeps model=current_model, effort=current_effort,
maxTurns 300; wrapped bakes model=wrapper_model, effort=wrapper_effort, maxTurns 160.
The shared spine — identity self-check, context load, authoritative test discipline, plan
done, the return contract, the BLOCKED taxonomy — stays single-sourced in the shell. The
divergent implement/commit middle moves to two Liquid includes under a new
plugins/plan/template/_partials/ directory (creating it makes plugins/plan/template the
include loader root; the shared snippet root is appended separately — verify with one
render). The native partial is a faithful extraction of today's implement and commit
phases; byte-level semantic parity with the current worker is the bar.

The wrapped partial carries the full delegate-adjudicate-commit contract: capture the
pre-launch base sha; resolve providers for the baked capability and effort via the
providers resolve verb; launch the first candidate as a DETACHED run (panel-style nohup
double-fork with pidfile, deterministic name wrapped::<task-id>, output envelope path,
system-file contract) — never one blocking call, the Bash tool caps at ten minutes; wait
in chunks via keeper agent wait under the configured stop_timeout_ms budget, killing the
leg by pidfile on abandon, taking over a stale same-name leg on retry. The system-file
contract instructs the foreign agent: implement to acceptance in place, run tests, no
commits, no branches, no keeper commands, return strict JSON {status, summary,
files_changed, tests, commit_message}. Parse the return defensively — size-bound,
fence-strip, one repair pass; it is attacker-influenced text, never shell-interpolated.
Failure map: launch failure falls through to the next provider; timeout retries the same
provider up to max_attempts then BLOCKED EXTERNAL_BLOCKED; malformed args or an absent
envelope are BLOCKED TOOLING_FAILURE; a no-message completion with a non-empty diff is
treated as completed. The wrapper then re-runs the authoritative test pass per the shared
spine, soft-resets to the base sha if the foreign agent committed anyway, stages the
git-derived change set (diff against base plus untracked, reconciled both directions
against files_changed), sanitizes the commit message through the forbidden-trailer gate,
and lands ONE commit carrying the wrapper's own Task line and Job-Id trailer so the
trailer-keyed projections discharge normally. Close-out and the five-line return are the
shared spine — reconcile cannot tell wrapped from native.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/template/agents/worker.md.tmpl — the phases being extracted; preserve them faithfully
- plugins/prompt/src/render_engine.ts:101-109 and :182-219 — strictVariables, include loader-root walk
- src/pair/panel.ts:523-542 and :81-90 — the nohup detach wrapper and chunked-wait pattern to mirror
- cli/commit-work.ts:81 and :95-96 and :334-372 — Task line, FORBIDDEN_TRAILER_RE, Job-Id via interpret-trailers
- src/agent/run-capture.ts:136-224 — system-file plumbing and the run envelope fields

**Optional** (reference as needed):
- src/agent/main.ts:1240-1269 — keeper agent wait, the single-run wait verb
- src/commit-work/attribution.ts:205-232 — why a bare explicit-path commit leaves the clean-check green
- src/git-worker.ts:967-971 and :1088-1112 — trailer parsing and global discharge of bare commits

### Risks

- First use of Liquid block tags in the template corpus — render gates and sidecars all
  move; keep the native path byte-faithful so parity diffs stay reviewable.
- The wrapper's foreground bash windows can inferred-attribute foreign edits to the
  wrapper session; the explicit-path commit clears them, but the clean-check must run
  after the commit, never between edit and commit.
- Foreign agents are not branch-guarded the way claude subagents are; the system-file
  contract is the only rail against branch mutations — state it imperatively.

### Test notes

Render-level in the fast suite: both cell kinds render, frontmatter branches correctly,
wrapped body carries the baked capability/effort and the full contract; strictVariables
failure when bindings are absent. Runtime behavior is task 8's slow-tier e2e.

## Acceptance

- [ ] Rendered native cells are semantically identical to today's worker across the full
      matrix and all render gates stay green.
- [ ] A rendered wrapped cell bakes the capability model, keeper effort, and wrapper
      driver, and its body carries the complete delegate, adjudicate, normalize, commit,
      and failure-map contract including detached launch with chunked waits.
- [ ] A cell rendered without driver bindings fails the render loudly rather than
      emitting a partial agent.

## Done summary
Composed worker.md.tmpl into a native/wrapped cell shell: frontmatter branches on the driver (wrapped bakes the wrapper driver at maxTurns 160), the implement/commit middle moves to two template/_partials/ Liquid includes (native byte-faithful, wrapped carries the full delegate-adjudicate-normalize-commit contract), and a missing driver binding fails the render loudly.
## Evidence
