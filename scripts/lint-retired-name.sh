#!/usr/bin/env bash
# Runtime entrypoint for the importable retired-name classifier. Fixture coverage
# lives in TypeScript; this command alone scans the live tree.
set -euo pipefail
exec bun "$(dirname "$0")/lint-retired-name.ts"
