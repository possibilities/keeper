# 90. Keeper owns Pi shorthands and skill discovery

## Status

Accepted. Extends ADR 0039's shared-skill model and ADR 0043's launch-scoped Pi extension boundary.

## Context

Keeper owns the canonical Hack and Plan Agent Skills, and its tracked Pi extension already adapts Keeper-specific behavior for each managed Pi launch. Pi's native skill command names remain `skill:hack` and `skill:plan`, while the human-facing shorthand should match Claude's `/hack` and `/plan` entry points.

A globally installed alias extension or global skill links split that contract across repositories and affect standalone Pi sessions. Registering shorthand as extension commands is also the wrong processing boundary: extension commands bypass Pi's native input transformation and skill expansion pipeline.

Pi supports both input transformation and dynamic resource discovery inside one launch-scoped extension. Those surfaces can expose Keeper's canonical skill bodies without copying them or installing persistent Pi configuration.

## Decision

Keeper's existing tracked Pi extension owns the complete shorthand and discovery path for Hack and Plan.

- An input handler rewrites only a leading `/hack` or `/plan` command token, preserving its remaining text and Pi's native input payload, to `/skill:hack` or `/skill:plan`. It returns the transformed input to Pi so native skill expansion remains authoritative.
- The transformation preserves the established behavior across Pi input sources and streaming modes; it does not introduce source-specific policy.
- The extension contributes exactly Keeper's Hack and Plan skill directories through `resources_discover`. Paths resolve from the extension module, never the launch cwd or another repository.
- The autocomplete provider presents `/hack` and `/plan` as discoverable shorthand without registering extension commands or depending on a pre-discovery command snapshot.
- Registration and discovery remain independently fail-open so an optional shorthand failure cannot disable Keeper's Task facade, Agent Bus presence, event logging, footer, or commit-work integration.
- The feature exists only in Keeper-managed Pi launches. Standalone Pi does not receive Keeper's shorthand or skills through this path.
- No global Pi extension or global Hack/Plan skill links are part of Keeper's contract, and another repository does not install them on Keeper's behalf.
- Keeper does not mediate conflicting ambient skills named `hack` or `plan`. Pi's existing discovery and collision behavior applies; conflicting installations may fail or resolve away from Keeper's canonical body.

## Alternatives considered

- **Install a dedicated global Pi alias extension.** Rejected because it affects non-Keeper sessions and splits one Keeper lifecycle across extensions.
- **Register `/hack` and `/plan` as extension commands.** Rejected because command dispatch bypasses native skill expansion.
- **Copy the skill bodies into Pi-specific resources.** Rejected because the long shared skills would drift from Keeper's canonical sources.
- **Install persistent global skill symlinks from Keeper.** Rejected because launch-scoped resource discovery supplies the same behavior without mutating ambient Pi state.
- **Force Keeper's skills to override same-name ambient skills.** Rejected because deterministic override would require suppressing or reordering user-owned Pi resources; collisions are outside this contract.

## Consequences

Keeper-launched Pi exposes `/hack` and `/plan` through the same native skill expansion path as explicit `/skill:hack` and `/skill:plan` invocations. Skill edits are visible from Keeper's source tree without an install copy, while fresh and upgraded environments require no global alias or skill artifacts.

The extension's local structural Pi types cover return-bearing input and resource-discovery events without importing Pi as a Keeper runtime dependency. Tests prove the behavior in-process with an isolated resource surface rather than relying on ambient global configuration or a real Pi subprocess.

Standalone Pi sessions intentionally lack these Keeper entry points unless another independently owned installation provides them. Same-name ambient skills are unsupported collisions rather than a compatibility surface.
