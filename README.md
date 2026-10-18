# @ovarilo/csms-driver

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

The package ships TypeScript sources and is consumed with [Bun](https://bun.sh)
as a git dependency pinned to a tag or commit:

```sh
bun add github:ovarilo/csms-driver#<tag-or-commit>
```

The generated declarations in `types/` are committed, because a git dependency
does not reliably run `prepare` under Bun. The consumer's TypeScript needs
`"moduleResolution": "bundler"`; `@ovarilo/csms-driver/tsconfig` is a base
configuration that sets it:

```json
{ "extends": "@ovarilo/csms-driver/tsconfig", "include": ["src/**/*.ts"] }
```

| import | contents |
|---|---|
| `@ovarilo/csms-driver` | contracts, errors, charge-point model, `createSteveCsmsDriver`, `createCitrineOsCsmsDriver` |
| `@ovarilo/csms-driver/server` | `createCsmsHttpHandler` and the HTTP route table |

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
} from "@ovarilo/csms-driver";

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

`@ovarilo/csms-driver/server` serves a driver over HTTP/JSON for applications
in any language. See [`src/server/README.md`](src/server/README.md).

## Development

```sh
bun install
bun run typecheck
bun run test          # boundary guard, committed types check, tests, example
bun run build:types   # regenerate types/ after an API change, and commit it
```

## License

Apache-2.0. See [LICENSE](LICENSE).
