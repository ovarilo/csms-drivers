#!/usr/bin/env bash
# The library has no runtime dependency, and its HTTP adapter depends only on
# the generic contract.
#
# Every specifier under src/ is relative or a Node built-in (`node:x`): a bare
# one (`some-package`) would give the library a runtime dependency, and it has
# none. `export ... from` and `import(...)` count as much as `import`.
#
# The server is a transport adapter over the generic contract
# (juherr/open-ocpp-tck#156): an allowlist rather than a list of drivers, so a
# third bundled driver is covered the day it is added. Every relative
# specifier under src/server/ is a sibling or one of the contract modules.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

[ -d src ] || { echo "FAIL: src/ is missing." >&2; exit 1; }

specifier='(from|import)[[:space:]]*\(?[[:space:]]*["'"'"']'

bare="$(grep -R -n -E "${specifier}[^.\"'n]" src --include='*.ts' || true)"
bare="${bare}$(grep -R -n -E "${specifier}n" src --include='*.ts' | grep -v -E "[\"']node:" || true)"
if [ -n "$bare" ]; then
  echo "FAIL: the library imports a package:" >&2
  printf '%s\n' "$bare" >&2
  exit 1
fi

server_imports="$(grep -R -n -E "${specifier}\.\.?/" src/server --include='*.ts' \
  | grep -v -E "[\"'](\./[^/\"']+|\.\./(contracts|models|charge-points))[\"']" || true)"
if [ -n "$server_imports" ]; then
  echo "FAIL: the HTTP adapter imports beyond the generic contract:" >&2
  printf '%s\n' "$server_imports" >&2
  exit 1
fi

echo "CSMS library dependency boundary holds."
