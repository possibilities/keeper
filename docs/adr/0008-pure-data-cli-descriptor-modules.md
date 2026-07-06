# 8. Pure-data CLI descriptor modules over a generated manifest

## Status

Accepted.

## Context

The keeper CLI surface spans two ecosystems: keeper-native leaves under `cli/`
parsing with `node:util` `parseArgs`, and the plan/prompt plugin CLIs with their
own hand-rolled command tables. Help text, the machine-readable `--help --json`
index, and shell completions were each fed by hand-maintained metadata
(`SUBCOMMAND_META`), which drifted from the real verb set within days of normal
work. Fixing the drift requires one source of truth for command metadata, but
two constraints shape where it can live: the plan/prompt verbs must stay out of
the root dispatch tree to preserve residual pass-through, and the help and
completion paths must not boot a plugin or touch the daemon — completion fires
on every Tab, and help must be pure. Prior art offers two shapes: a build-time
generated manifest (oclif's `oclif.manifest.json`) with a drift-check gate, or
descriptor modules imported at runtime.

## Decision

Each CLI owns a pure-data descriptor module: dependency-free TypeScript
exporting a recursive command tree — name, summary, visibility, mutates,
requires_daemon, requires_tty, format_modes, flags, exit_codes. The descriptor
is the source its own CLI consumes: native leaves derive their `parseArgs`
options from their descriptor, and the plan/prompt parsers and help renderers
read their own descriptor tables, so metadata and behavior cannot diverge — the
descriptor drives the parser rather than describing it. `keeper --help --json`,
usage text, leaf help, and completion generation lazily import the descriptor
modules directly; no generated artifact exists, so there is no manifest to
drift and no sync gate to go red. An import-graph purity test pins the
descriptor modules dependency-free, keeping the help and completion paths free
of plugin boot, daemon, and database imports.

The generated-manifest alternative was rejected because it exists to serve
dynamically discovered plugins; keeper's plugins are in-repo and statically
known, so a manifest would add generation machinery and a drift gate to solve a
problem direct imports do not have.

## Consequences

- Adding or changing a verb or flag is one edit in the owning CLI's descriptor;
  help, the JSON index, and completions follow automatically.
- The descriptor modules become a load-bearing contract: they must stay pure
  data, enforced by the import-graph test, or help/completion latency and
  purity regress.
- Machine consumers can introspect mutation, daemon, and format requirements
  per command from `--help --json` instead of scraping prose.
- Intentional per-command divergences (frozen exit-code seams, non-error
  non-zero exits) are declared in each descriptor's `exit_codes` rather than
  smoothed over silently.
