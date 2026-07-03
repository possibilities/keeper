## Overview

The arthack-orphan cleanup deleted the committed `arthack.keeperd` LaunchAgent
symlink (keeper's own installer now owns that plist), but the section-6c comment
in arthack `scripts/install.sh` still narrates that symlink as present and
`processctl start-processes`-managed. This corrects the stale narrative so a
future editor cannot re-create the exact symlink the cleanup removed.

## Acceptance

- [ ] The section-6c comment describes keeper's own installer as the owner of the `arthack.keeperd` load path
- [ ] The comment no longer claims arthack's `processctl start-processes` manages `arthack.keeperd`

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Stale comment at arthack scripts/install.sh:593-595 narrates the deleted arthack.keeperd symlink as processctl-managed; symlink verified gone and keeper install.sh:92-121 owns the load path. |

## Out of scope

- Any behavior change to install.sh (this is a comment-accuracy fix only)
- The already-completed deletions and machine-config swap from the source epic
