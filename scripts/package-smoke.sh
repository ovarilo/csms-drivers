#!/usr/bin/env bash
# The package as a consumer installs it: packed, installed by npm without
# devDependencies, then used from Node 26, from Bun, and from TypeScript with
# Node's own module resolution.
#
# Node refuses to strip types under node_modules, so this is what proves that
# the committed dist/ JavaScript is complete: every relative specifier
# rewritten to `.js`, no directory import, no Bun global.
#
#   bash scripts/package-smoke.sh
#
# NODE26 overrides how Node 26 is run (default: `mise exec node@26 -- node`,
# or plain `node` when it already is 26).
#
# Shared with ovarilo/csms-drivers-commercial (scripts/package-smoke.sh), which
# exercises its own exports the same way.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

if [ -n "${NODE26:-}" ]; then
  read -r -a node26 <<<"$NODE26"
elif node --version 2>/dev/null | grep -q '^v26\.'; then
  node26=(node)
elif command -v mise >/dev/null 2>&1; then
  node26=(mise exec node@26 -- node)
else
  echo "FAIL: Node 26 is needed (set NODE26, or install it through mise)." >&2
  exit 1
fi
# The npm that ships with that Node: its bin directory first on PATH.
PATH="$(dirname "$("${node26[@]}" -p 'process.execPath')"):$PATH"

echo "Node: $("${node26[@]}" --version), npm: $(npm --version)"

npm pack --silent --pack-destination "$work" >/dev/null
tarball="$(ls "$work"/*.tgz)"

mkdir "$work/app"
cat >"$work/app/package.json" <<'EOF'
{ "name": "consumer", "private": true, "type": "module" }
EOF
(cd "$work/app" && npm install --omit=dev --no-audit --no-fund --silent "$tarball")

# A driver and the HTTP adapter, from the installed package, against a scripted CSMS.
cat >"$work/app/consumer.mjs" <<'EOF'
import { createCitrineOsCsmsDriver, UnsupportedOperationError } from "@ovarilo/csms-drivers";
import { createCsmsHttpHandler } from "@ovarilo/csms-drivers/server";

const requests = [];
const fetch = async (input, init) => {
  requests.push({ url: String(input), body: await new Response(init?.body).text() });
  return new Response(JSON.stringify([{ success: true, payload: { status: "Accepted" } }]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const driver = createCitrineOsCsmsDriver({
  config: { variant: "v2", apiUrl: "http://citrine.example.invalid", tenantId: 1 },
  refs: { ocppTransactionId: async () => 1 },
  fetch,
});

await driver.operations201.execute("station-1", { action: "Reset", type: "Immediate" });
if (!requests[0]?.url.includes("/ocpp/2.0.1/configuration/reset?")) {
  throw new Error(`driver: unexpected request ${JSON.stringify(requests)}`);
}
if (!(new UnsupportedOperationError("x") instanceof Error)) throw new Error("UnsupportedOperationError");

const handler = createCsmsHttpHandler(driver, { about: { id: "citrineos", displayName: "CitrineOS" } });
const about = await handler(new Request("http://localhost/v1/driver"));
if (about.status !== 200) throw new Error(`server: GET /v1/driver answered ${about.status}`);

console.log(`${process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`}: the driver and the server work from the installed package.`);
EOF
(cd "$work/app" && "${node26[@]}" consumer.mjs)
(cd "$work/app" && bun consumer.mjs)

# The declarations, as a strict Node-resolution TypeScript consumer sees them.
cat >"$work/app/consumer.ts" <<'EOF'
import { createSteveCsmsDriver, type CsmsDriver, type FetchLike } from "@ovarilo/csms-drivers";
import { createCsmsHttpHandler, type CsmsHttpHandler } from "@ovarilo/csms-drivers/server";

const fetch: FetchLike = async () => new Response("");
const driver: CsmsDriver = createSteveCsmsDriver({
  config: { baseUrl: "http://steve.example.invalid", username: "u", password: "p" },
  fetch,
});
const handler: CsmsHttpHandler = createCsmsHttpHandler(driver, { about: { id: "steve", displayName: "SteVe" } });
export { handler };
EOF
cat >"$work/app/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "skipLibCheck": false,
    "noEmit": true,
    "types": []
  },
  "files": ["consumer.ts"]
}
EOF
if ! "$repo_root/node_modules/.bin/tsc" -p "$work/app/tsconfig.json"; then
  echo "FAIL: the installed declarations do not type-check under nodenext resolution." >&2
  exit 1
fi

echo "Package: installs without devDependencies; the driver and the server run on Node 26 and Bun; declarations resolve under nodenext."
