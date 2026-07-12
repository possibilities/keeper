## Overview

The `engineering/panel-strength` snippet is the panel-choosing methodology keeper bakes into
its hack and panel skill bodies (vendored from this repo's snippet corpus). It currently tells
agents to infer a panel's strength from member count and harness diversity. This epic rewrites
the arthack-side source to the described-roster rubric: read the roster live, match stakes to
each panel's authored strength band and description, prefer the weakest covering rung. The
keeper-side epic (described-panel-roster-ladder) re-vendors and re-bakes it after this lands.

## Quick commands

- grep -n "presets list --json" claude/arthack/template/_partials/snippets/engineering/panel-strength.md.tmpl

## Acceptance

- [ ] The snippet source carries the described-roster choosing rubric, methodology-only, with no hard-coded panel names.
- [ ] The embedded summary header matches the new body.
