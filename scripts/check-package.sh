#!/usr/bin/env bash
# The packed tarball must carry what the exports map points at, and nothing of the
# development tree: `files` in package.json is the allowlist, this is its guard.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

listing="$(npm pack --dry-run --json --ignore-scripts | bun -e '
  const [pack] = JSON.parse(await Bun.stdin.text());
  for (const file of pack.files) console.log(file.path);
')"

if [ -z "$listing" ]; then
  echo "FAIL: npm pack listed no file." >&2
  exit 1
fi

status=0
for required in package.json LICENSE README.md tsconfig.base.json src/index.ts src/server/index.ts types/index.d.ts types/server/index.d.ts; do
  if ! grep -qx "$required" <<<"$listing"; then
    echo "FAIL: $required is missing from the package." >&2
    status=1
  fi
done
if forbidden="$(grep -E '^(tests|scripts|examples|\.github|\.vite-hooks|node_modules)/' <<<"$listing")"; then
  echo "FAIL: development files are packed:" >&2
  echo "$forbidden" >&2
  status=1
fi
[ "$status" -eq 0 ] && echo "Package: $(wc -l <<<"$listing" | tr -d ' ') files, exports targets present, no development files."
exit "$status"
