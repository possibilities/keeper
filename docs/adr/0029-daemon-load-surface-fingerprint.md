# 29. Daemon load-surface fingerprint gates the install reload

## Status

Accepted.

## Context

CI reinstalls keeper on every green build, and the installer reloads the
keeperd LaunchAgent whenever its source fingerprint moves. Fingerprinting the
whole repo HEAD made every commit a reload trigger, yet most commits — plan
board checkpoints, docs, tests, skills — never reach the resident daemon
process: the CLI is bun-linked and re-read per invocation, and hooks, skills,
and the prompt engine run as fresh processes. Only keeperd holds code in
memory, so only changes to what keeperd actually loads warrant a bounce. The
board's own checkpoint commits dominated the stream, so the daemon restarted
near-continuously, dropping socket clients, watcher subscriptions, and
in-flight autopilot cycles.

A path-scoped fingerprint is only trustworthy if the daemon's import graph
stays inside the declared paths. At decision time a handful of backwards edges
existed (daemon code importing from the CLI layer and from hook modules), so
the boundary had to be cleaned and then enforced, not merely declared.

## Decision

A checked-in roots manifest declares the daemon's load surface: the source
tree the daemon entrypoint transitively imports, the plan-engine modules and
embedded matrix config it reaches, the dependency lockfile pair, and the
daemon's own plist. One TypeScript seam reads the manifest and composes a
content-addressed fingerprint from per-root `git rev-parse HEAD:<root>` tree
hashes; the installer calls that seam and reloads keeperd only when the
composite moves. The manifest file itself is part of the hash input, so
editing the declared roots invalidates the fingerprint.

A fast-tier boundary test walks the daemon entrypoint's transitive import
graph — including worker-thread spawn edges and attribute imports — and
asserts every reachable in-repo module falls under a manifest root. The test
and the installer consume the same seam, so the enforced boundary and the
hashed boundary cannot drift apart.

Layering is one-way: `cli/` may import `src/`, never the reverse; hooks may
import the sanctioned dep-free `src/` helpers, and daemon code never imports
hook modules. `plugins/plan/src` remains a declared root rather than moving
plan-owned contracts into `src/`.

Failure directions are asymmetric: a declared root that fails to resolve at
HEAD fails the install loudly (a manifest bug someone must fix), while git
being wholly undeterminable degrades to the plist-content gate alone, matching
fresh-machine installs. The weekly logrotate kickstart remains the eventual
backstop.

## Consequences

- keeperd restarts cluster around actual daemon-code merges instead of every
  commit; board-checkpoint and docs churn no longer bounce the daemon.
- A new backwards import edge fails CI rather than silently widening the
  daemon's real load surface past the fingerprint.
- Renaming or splitting a declared root requires a matching manifest edit; the
  loud install failure and the boundary test both surface a miss.
- Alternatives rejected: a buildbot-side install gate (leaves the fingerprint
  lying about the boundary) and daemon self-restart-on-quiesce (heavier, and
  restarts are already crash-safe by design — frequency, not timing, was the
  problem).
