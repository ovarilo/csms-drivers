#!/usr/bin/env bash
# The committed build must be what the sources actually produce.
#
# dist/ (ESM JavaScript and declarations) is generated but COMMITTED, because
# this package is consumed as a pinned git dependency and a git dependency
# does not reliably run prepack/prepare under bun -- a consumer would install
# a package whose `exports` point at files that do not exist. Node needs the
# JavaScript (it refuses to strip types under node_modules); TypeScript needs
# the declarations.
#
# Committing a generated artifact is only safe with a guard that regenerates
# and diffs, which is this file. It also makes the public API surface a
# readable diff in a pull request instead of an invisible
# consequence of an edit somewhere else.
#
# Emits into a temporary directory, never over dist/: a check that repairs
# what it is checking always passes.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [ ! -x node_modules/.bin/tsc ]; then
  echo "FAIL: node_modules/.bin/tsc is missing — run 'bun install' first." >&2
  exit 1
fi

if [ ! -d dist ]; then
  echo "FAIL: dist/ is missing — the exports map points into it." >&2
  echo "  → generate it with: bun run build" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

if ! node_modules/.bin/tsc -p tsconfig.build.json --outDir "$work/dist" >"$work/tsc.log" 2>&1; then
  echo "FAIL: the build failed." >&2
  cat "$work/tsc.log" >&2
  exit 1
fi

if ! diff -ru dist "$work/dist"; then
  echo >&2
  echo "FAIL: dist/ is stale — the committed build does not match the sources." >&2
  echo "  → regenerate and commit: bun run build" >&2
  echo "  → the .d.ts part of the diff above IS the change to this package's public API. Read it." >&2
  exit 1
fi

echo "Committed build matches the sources ($(find dist -name '*.js' | wc -l | tr -d ' ') modules, $(find dist -name '*.d.ts' | wc -l | tr -d ' ') declarations)."
