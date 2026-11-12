#!/usr/bin/env bash
# The library has no runtime dependency, and its HTTP adapter depends only on
# the generic contract.
#
# Every specifier under src/ is relative or a Node built-in (`node:x`): a bare
# one (`some-package`) would give the library a runtime dependency, and it has
# none. `export ... from` and `import(...)` count as much as `import`.
#
# Every relative specifier names a `.ts` file: tsconfig.build.json rewrites
# those to `.js`, and leaves an extensionless or directory specifier as it is,
# which Node cannot resolve from dist/.
#
# The server is a transport adapter over the generic contract
# (juherr/open-ocpp-tck#156): an allowlist rather than a list of drivers, so a
# third bundled driver is covered the day it is added. Every relative
# specifier under src/server/ is a sibling or one of the contract modules.
#
# src/shared/ holds internal helpers several drivers import, so it follows the
# same allowlist: a helper that imported a driver would tie every driver to it.
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

extensionless="$(grep -R -n -E "${specifier}\.\.?/?[^\"']*[\"']" src --include='*.ts' \
  | grep -v -E "${specifier}\.\.?/[^\"']*\.ts[\"']" || true)"
if [ -n "$extensionless" ]; then
  echo "FAIL: a relative specifier does not name a .ts file:" >&2
  printf '%s\n' "$extensionless" >&2
  exit 1
fi

server_imports="$(grep -R -n -E "${specifier}\.\.?/" src/server --include='*.ts' \
  | grep -v -E "[\"'](\./[^/\"']+|\.\./(contracts|models|charge-points)\.ts)[\"']" || true)"
if [ -n "$server_imports" ]; then
  echo "FAIL: the HTTP adapter imports beyond the generic contract:" >&2
  printf '%s\n' "$server_imports" >&2
  exit 1
fi

shared_imports="$(grep -R -n -E "${specifier}\.\.?/" src/shared --include='*.ts' \
  | grep -v -E "[\"'](\./[^/\"']+|\.\./(contracts|models|charge-points)\.ts)[\"']" || true)"
if [ -n "$shared_imports" ]; then
  echo "FAIL: a shared helper imports beyond the generic contract:" >&2
  printf '%s\n' "$shared_imports" >&2
  exit 1
fi

echo "CSMS library dependency boundary holds."
