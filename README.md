# @ovarilo/csms-drivers

Reusable CSMS driver library: OCPP operation contracts, dispatch errors,
capability declarations, typed session and connector read interfaces, the
bundled SteVe and CitrineOS operation factories, and an HTTP/JSON handler over
any driver. OCPP 1.6 and OCPP 2.0.1 remain separate contracts.

Extracted from [open-ocpp-tck](https://github.com/juherr/open-ocpp-tck)
(`packages/csms-driver`), with the history of that directory; earlier
commits, from before the code moved there out of `drivers/` and
`tck/driver.ts`, stay upstream. The library has no runtime
dependency and no tie back to the TCK.

## Install

The package runs on [Bun](https://bun.sh) and on Node 26. It ships its
TypeScript sources, which Bun loads through the `bun` export condition, and the
ESM JavaScript and declarations built from them in `dist/`, which Node and
TypeScript load.

Install the versions published to GitHub Packages. Map the scope to that
registry with a token holding `read:packages`, in `bunfig.toml`:

```toml
[install.scopes]
"@ovarilo" = { url = "https://npm.pkg.github.com", token = "$GITHUB_TOKEN" }
```

or in `.npmrc`:

```ini
@ovarilo:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

then `bun add @ovarilo/csms-drivers`.

A git dependency (`github:ovarilo/csms-drivers#…`) is not a supported way to
install the package: `dist/` is generated at release time and not committed,
so a checkout lacks what Node and TypeScript load unless the consumer runs
`bun install && bun run build` in it. The consumer's TypeScript resolves the package with
`"moduleResolution": "bundler"` or `"nodenext"`; `@ovarilo/csms-drivers/tsconfig`
is a base configuration that sets `bundler`:

```json
{ "extends": "@ovarilo/csms-drivers/tsconfig", "include": ["src/**/*.ts"] }
```

| import | contents |
|---|---|
| `@ovarilo/csms-drivers` | contracts, errors, charge-point model, `createSteveCsmsDriver`, `createCitrineOsCsmsDriver` |
| `@ovarilo/csms-drivers/server` | `createCsmsHttpHandler` and the HTTP route table |

## Usage

Generic capabilities describe only the operations the returned factory can
dispatch.

The factories accept CSMS configuration, a transport, and any lookups needed
to translate opaque CSMS handles. Read APIs can be supplied where a deployment
exposes them. Test-harness concerns (scope declarations, expected failures,
fixture lifecycle, simulator transport, assertion records) stay in the
consumer, as open-ocpp-tck's `drivers/` adapters do.

For a complete executable consumer example, see
[`examples/csms-driver-smoke.ts`](examples/csms-driver-smoke.ts). It
creates the CitrineOS factory with a fake HTTP transport and sends an OCPP 2.0.1
Reset.

```ts
import {
  createCitrineOsCsmsDriver,
  type FetchLike,
} from "@ovarilo/csms-drivers";

const fetch: FetchLike = async () => new Response(
  JSON.stringify([{ success: true, payload: { status: "Accepted" } }]),
  { status: 200 },
);

const driver = createCitrineOsCsmsDriver({
  config: {
    variant: "v2",
    apiUrl: "http://localhost:8080",
    tenantId: 1,
  },
  refs: { ocppTransactionId: async () => 1 },
  fetch,
});

await driver.operations201?.execute("station-1", {
  action: "Reset",
  type: "Immediate",
});
```

## Charge-point administration

Registering a station with the CSMS before it connects is administrative
provisioning, not an OCPP message, so it is a surface of its own:
`driver.chargePoints`. It is optional. A consumer detects it from the
capabilities alone, without knowing which CSMS is behind the driver:

```ts
const profiles = driver.capabilities.chargePoints?.securityProfiles;
if (driver.chargePoints && profiles?.has(1)) {
  const existing = await driver.chargePoints.get("CP-1");
  const security = { profile: 1, basicAuthPassword: "secret" } as const;
  if (existing === null) {
    await driver.chargePoints.create({ id: "CP-1", registration: "Accepted", security });
  } else {
    await driver.chargePoints.update("CP-1", { registration: "Accepted", security });
  }
}
```

The model names what OCPP defines (the station identity, its registration
status, security profiles 0 to 3 and the HTTP Basic password profiles 1 and 2
carry) and an optional description; CSMS form fields stay inside each driver.
Every driver answers the edge cases alike:

| call     | missing id                        | existing id                           |
|----------|-----------------------------------|---------------------------------------|
| `create` | creates                           | throws `ChargePointAlreadyExistsError` |
| `get`    | `null`                            | its details, never the password       |
| `update` | throws `ChargePointNotFoundError` | changes only the members it names     |
| `delete` | resolves                          | deletes                               |

An omitted registration means `Accepted` and omitted security means profile 0,
which a driver that does not declare profile 0 refuses like any other.
An update's `security` replaces the whole block, so moving a station to
profile 0 or 3 discards its stored password; `description: null` clears the
description.
A profile outside `capabilities.chargePoints.securityProfiles` is refused with
`UnsupportedOperationError`. `create` is deliberately not an upsert: the
password cannot be read back, so whether an existing station matches a
definition is undecidable, and the `get`-then-`create`-or-`update` idiom above
is how a caller provisions idempotently.

The SteVe driver implements the surface, on every security profile, through
the manager UI: SteVe has no REST endpoint for charge points
([steve-community/steve#2068](https://github.com/steve-community/steve/issues/2068)).
Three things follow from that UI. A refusal (a password outside SteVe's 16 to
20 characters, say) is a plain `Error` carrying the page's error text. SteVe
cannot clear a stored password, so a move to profile 0 or 3 replaces it with
a random one nobody holds. And a security change on a station that is
connected is pushed to it as `ChangeConfiguration`; if the station refuses,
`update` throws although the record has changed. The CitrineOS driver does not
implement the surface yet.

## Over HTTP

`@ovarilo/csms-drivers/server` serves a driver over HTTP/JSON for applications
in any language. See [`src/server/README.md`](src/server/README.md).

## Development

```sh
bun install
bunx vp config --no-agent  # once: installs the pre-commit and commit-msg hooks
bun run check         # format, lint, type-check, build, test, package content: what CI runs
bun run format        # rewrite with Oxfmt (Vite+)
bun run build         # generate dist/ (ESM JavaScript and declarations)
bun run test          # build, then every test and the Node 26/Bun package smoke
```

`dist/` is generated and ignored by git; `bun run test` builds it first, so
`bun run check` works from a fresh checkout.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/),
checked by commitlint in the `commit-msg` hook and in CI (commits and pull
request title). Notable changes go under `## [Unreleased]` in
[`CHANGELOG.md`](CHANGELOG.md), which follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), in the same pull
request as the change. Renovate keeps dependencies and action digests current.

### Releasing

1. `bun scripts/release.ts prepare X.Y.Z` dates the Unreleased section and bumps
   `package.json`; open a pull request titled `chore(release): X.Y.Z` and merge it.
2. Run the **Release** workflow from `main` with `version=X.Y.Z`, first with
   `dry_run` (validation, the full gate and the check of the build handed to
   the publish job; nothing is published), then without.
3. It builds and validates the package, publishes that same build to GitHub
   Packages (the publish job refuses a package whose pack integrity differs from
   the validated one), then creates the `vX.Y.Z` tag and the GitHub
   Release from the changelog section. Each step is idempotent: re-run a failed
   run instead of dispatching again.

## License

Apache-2.0. See [LICENSE](LICENSE).
