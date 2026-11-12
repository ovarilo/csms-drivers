# @ovarilo/csms-drivers

Reusable CSMS driver library: OCPP operation contracts, dispatch errors,
capability declarations, typed session and connector read interfaces, the
bundled SteVe, CitrineOS, Codetics ev-server-lite and EVtivity operation factories, and an HTTP/JSON handler over
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
| `@ovarilo/csms-drivers` | contracts, errors, charge-point model, `createSteveCsmsDriver`, `createCitrineOsCsmsDriver`, `createCodeticsEvServerLiteCsmsDriver`, `createEvtivityCsmsDriver` |
| `@ovarilo/csms-drivers/server` | `createCsmsHttpHandler` and the HTTP route table |
| `@ovarilo/csms-drivers/steve/{api-client,ui-client,forms,charge-points}` | the SteVe driver's building blocks: WebAPI and manager-UI clients, form encoding, charge-point administration |
| `@ovarilo/csms-drivers/citrineos/{api-client,config,http,requests,variant}` | the CitrineOS driver's building blocks: message-API client, configuration, response reading, request mapping, `v1`/`v2` routing |

The building-block subpaths exist for adapters that compose a driver of
their own from these parts, as `juherr/open-ocpp-tck` does. Each is listed
explicitly in `package.json#exports`; a module not listed there is internal.

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
`UnsupportedOperationError`. So is a registration outside
`capabilities.chargePoints.registrations`, which is optional: absent means all
three, and present it is never empty and contains `Accepted`, the default. A
CSMS without `Pending` or `Rejected` declares the statuses it has, `get` never
returns one outside the declaration, and a refused `create` or `update` changes
nothing. `create` is deliberately not an upsert: the
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
`update` throws although the record has changed. The CitrineOS, Codetics
ev-server-lite and EVtivity drivers do not implement the surface yet.

## Codetics ev-server-lite

[ev-server-lite](https://github.com/codetics-software/ev-server-lite) is an OCPP 1.6J
CSMS with a REST admin API. `createCodeticsEvServerLiteCsmsDriver` queues every
OCPP 1.6 operation through its generic command endpoint,
`POST /api/v1/stations/{id}/commands`, then polls the command until the
server's dispatcher has written the CALL to the station:

```ts
import { createCodeticsEvServerLiteCsmsDriver } from "@ovarilo/csms-drivers";

const driver = createCodeticsEvServerLiteCsmsDriver({
  config: {
    apiUrl: "http://localhost:8380",
    tenant: "codetics",
    email: "admin@example.com",
    password: process.env.EVSL_PASSWORD!,
    dispatchTimeoutMs: 15_000, // the default
  },
  // Only needed by operations that carry a charging-profile ref.
  refs: { chargingProfileByRef: (ref) => myProfiles.get(ref) },
});

await driver.operations16.execute("CP-1", { action: "Reset", type: "Soft" });
```

- `execute()` resolves once the command has left `QUEUED` (`SENT`,
  `SUCCEEDED`, or `FAILED` with the station's CALLERROR), with the command row
  as its receipt. A command still `QUEUED` when `dispatchTimeoutMs` runs out
  (the station is not connected), `TIMED_OUT`, `CANCELLED` or `FAILED` without
  a result is a `CsmsNotDispatchedError`. The server cannot cancel a command,
  so an abandoned one may still reach the station later.
- The server counts every signin against a limit of ten per fifteen minutes per
  account, until it restarts. The driver logs in once per process, server,
  account and password, shared by every driver instance with those credentials
  (a driver with another password logs in itself). A signin refused 401, 403 or 429 is
  remembered for fifteen minutes instead of retried, and a request answered
  401 logs in again and is retried once, but only once the token has reached
  the `expires_at` its signin gave (or, without one, is five minutes old): a
  401 on a live token spends no signin.
- `GetConfiguration` with a key list is an `UnsupportedOperationError`: the
  server's validator refuses any array `key` member. Requesting every key works.
- Transaction refs are the OCPP `transactionId`, as the server uses it as its
  own id. `ReserveNow` without a reservation ref gets an id allocated by the
  driver.

The driver declares no OCPP 2.0.1 surface and no charge-point administration:
a station must be registered (and, without a password, on security profile 0)
before it can connect. The server's station API cannot meet the
administration contract:

- BootNotification is always answered `Accepted`, and there is no `Pending`;
  the only lever, `enabled: false`, answers every call with a `SecurityError`
  CALLERROR rather than a `Rejected` registration.
- The HTTP Basic password of profiles 1 and 2 is always generated by the
  server and returned once; a caller cannot set its own.
- Profile 0 needs the server started with `OCPP_ALLOW_UNAUTHENTICATED=true`,
  and profile 3 a client certificate authority: deployment settings, not
  something the API can declare.
- A station's `name` is required, so a description cannot be cleared.

## EVtivity

[EVtivity](https://github.com/EVtivity/evtivity-csms) is a TypeScript CSMS
(Fastify, PostgreSQL, Redis) published under the Business Source License 1.1.
It serves OCPP 1.6J and 2.x; `createEvtivityCsmsDriver` drives **OCPP 1.6J
only**, through one synchronous REST route per action,
`POST /v1/ocpp/commands/v16/{Action}`, which blocks until the station answers.
Measured against release `0.1.51`:

```ts
import { createEvtivityCsmsDriver } from "@ovarilo/csms-drivers";

const driver = createEvtivityCsmsDriver({
  config: {
    apiUrl: "http://localhost:8480",
    email: "admin@evtivity.local",
    password: process.env.EVTIVITY_PASSWORD!,
    dispatchTimeoutMs: 45_000, // the default
  },
  // Only needed by operations that carry a charging-profile ref.
  refs: { chargingProfileByRef: (ref) => myProfiles.get(ref) },
});

await driver.operations16.execute("CP-1", { action: "Reset", type: "Soft" });
```

- `execute()` resolves with the route's answer once the station answered,
  `Rejected` included. What the other answers mean:

  | answer | class |
  |---|---|
  | 202 `COMMAND_QUEUED` (station offline, command queued) | `CsmsNotDispatchedError` |
  | 400 `OCPP_VERSION_MISMATCH` | `UnsupportedOperationError` |
  | other 400, 401, 403, 404, 429 (refused before it was sent) | `CsmsNotDispatchedError` |
  | 502 whose `error` starts `CALLERROR ` or `Invalid CALLRESULT ` (the station answered) | `Error` |
  | any other 502 (the send failed, or its fate is unknown) | `CsmsNotDispatchedError` |
  | 504 whose `error` starts `Timeout waiting for response to ` (sent, unanswered) | `Error` |
  | 504 `No response within 35s`, or `dispatchTimeoutMs` running out | `CsmsNotDispatchedError` |
  | 500 | `Error` |

  Keep `dispatchTimeoutMs` above the server's own 35 s bound, so a timeout
  means the server broke that bound rather than a slow station being cut off.
- A command for an offline station is answered `202` and queued: the driver
  reports it as not dispatched, but EVtivity replays it the next time that
  station connects unless its `ocpp.offlineCommandTtlHours` setting is `0`.
- The login is rate limited and every refused password counts toward the
  account's sign-in backoff. The driver logs in once per process, server,
  account and password, shared by every driver instance with those
  credentials (a driver with another password logs in itself), and replaces
  the one-hour token
  before it expires. A login refused 401 or 403, or answered
  `mustResetPassword`, is remembered for fifteen minutes instead of retried. A
  command answered 401 logs in again and is sent once more, but only once the
  session is a minute old: a 401 the server keeps sending costs at most one
  login a minute.
- Transaction refs are the OCPP `transactionId`. `ReserveNow` without a
  reservation ref gets an id allocated by the driver.

The driver declares no OCPP 2.0.1 surface, no sessions or connectors reader
(inject your own through `sessions` and `connectors`) and no charge-point
administration: a station must be registered, and not blocked, before it
connects. EVtivity also acts once per station on its own, which a reader of a
station's wire log needs to know: after a first `BootNotification` it pushes
`ChangeConfiguration`s (`MeterValueSampleInterval=60` among them), and a
transaction whose token has no driver account is stopped by the CSMS with a
`RemoteStopTransaction` of its own.

## Over HTTP

`@ovarilo/csms-drivers/server` serves a driver over HTTP/JSON for applications
in any language. See [`src/server/README.md`](src/server/README.md).

### Command outcomes

`CsmsDriver.commands` is an optional surface beside `operations16` and
`operations201`, whose `execute` is unchanged. `commands.submit16(cpId, op)` (and `submit201?` for 2.0.1)
resolves to a `CommandOutcome` (`unsupported`, `rejected`, `accepted`,
`confirmed`, `failed`, `unknown`) instead of throwing for a CSMS or station
verdict, and `commands.poll(ref)` re-reads one when
`capabilities.commands.polling`. A timeout after dispatch is `unknown`, never
`failed`. `execute` is unchanged on every driver: it still resolves with a
receipt and throws `UnsupportedOperationError` or `CsmsNotDispatchedError`;
`commands` is additive.

What a `2xx` or a `CALLRESULT` means depends on the driver, and
`capabilities.commands` declares it:

| Driver | `completion` | `polling` | What `submit16` reports |
| --- | --- | --- | --- |
| Codetics ev-server-lite | `confirmed` | yes | The command is followed to the station's answer: `confirmed` with the `CALLRESULT`, `rejected` for `Rejected`/`NotSupported`, `failed` for a `CALLERROR`. `SENT` still unanswered after `dispatchTimeoutMs`, or the server's own `TIMED_OUT` after `SENT`, is `unknown` (`timeout`). `poll(ref)` re-reads it by command id. |
| EVtivity | `confirmed` | no | The route blocks, so the station's answer is the HTTP answer: `confirmed`, `rejected` or `failed` (a `502` `CALLERROR`). A `504`, a `502` `Connection closed`, the driver's own `dispatchTimeoutMs` expiring, or an aborted wait is `unknown`. There is no ref to poll. |
| SteVe | `accepted` | no | A form SteVe accepted is `accepted`, without a ref. The station's answer is never read, so `accepted` is never `confirmed`. |
| CitrineOS | `accepted` | no | A message the API accepted is `accepted`, without a ref (`submit201` too, on `variant: "v2"`; `v1` has no `submit201`). Never `confirmed`. |

For every driver, a request that never became an OCPP CALL, or that the CSMS
cannot express, still throws as `execute` does; and a timeout after dispatch
is `unknown`, never `failed`. When an EVtivity wait is interrupted after the CALL may have left, `execute`
still throws a `CsmsNotDispatchedError` (rely on `instanceof
CsmsNotDispatchedError`; the internal subclass is not exported), which `submit16`
reports as `unknown`.

In a UI, show `accepted` as "sent", never "done", and `unknown` as "no answer
yet", never as an error that implies nothing happened. Never retry on
`unknown` (or a `504`) without evidence that the operation is idempotent or
did not run: poll first where the driver can, otherwise ask the station for
its state. What a UI should show for each state and which operations are safe
to repeat are in [`src/server/README.md`](src/server/README.md#command-outcomes).

## Conformance

`@ovarilo/csms-drivers/conformance` holds the suites this repository holds its
own drivers to, so a third-party driver (or the same driver against a real
CSMS) is held to the same rules. They are plain functions over a
`CsmsDriver`, with no test runner and no dependency; each returns a
`ConformanceReport`:

```ts
import {
  chargePointAdminConformance,
  commandsConformance,
  conformanceHolds,
  operationsConformance,
} from "@ovarilo/csms-drivers/conformance";

const report = await operationsConformance(driver, { cpId: "CP-1" });
if (!conformanceHolds(report)) throw new Error(JSON.stringify(report.failed, null, 2));
console.log(`${report.passed.length} passed, ${report.skipped.length} skipped`);
```

### Reading a report

- `passed`: the rule was asked and the driver met it.
- `failed`: the rule was asked and the driver broke it; `detail` says how.
- `skipped`: the rule depends on something the driver does not declare, or on
  a fixture the caller did not supply; `reason` says which. A skipped rule is
  **not** a passed one: `conformanceHolds` is true when nothing failed, so also
  read `passed` and `skipped` before calling a driver conformant. A driver
  with no `commands` has every `commandsConformance` rule skipped.

Every rule of a suite appears in exactly one list.

### What each suite asks

All three are capability-driven: they read `driver.capabilities` and ask only
what the driver claims, plus whether the claim is true.

- `operationsConformance(driver, { cpId, operations16?, operations201? })`:
  for each OCPP 1.6 and 2.0.1 action, `execute` with a fixture operation. A
  declared action must not throw `UnsupportedOperationError`; an undeclared
  one must throw it, and nothing else (a falsely declared capability, or an
  undeclared one that works, fails). A declared action failing with
  `CsmsNotDispatchedError` or a plain `Error` does not disprove the
  declaration. `SAMPLE_OPERATIONS_16` and `SAMPLE_OPERATION_201` are the
  default fixtures; pass `operations16` to override an action, and leave one
  out to have its rule skipped. Point it at a fake transport: it runs the real
  `execute`.
- `commandsConformance(driver, { cpId, scenarios })`: `commands` exists
  exactly when `capabilities.commands` is declared, and `poll` exactly when
  `polling` is; every verdict is returned as a value in the expected state;
  a timeout is `unknown`, never `failed`; an `accepted`-completion driver never
  reports `confirmed`; `poll` answers a submitted ref and `null` for a
  stranger. The suite cannot make a CSMS refuse or time out: each scenario
  (`accepted`, `confirmed`, `rejected`, `unknown`, `timeout`) is an operation
  and an optional `arrange` step where you steer your fake transport.
  `submit201` follows the same contract and is not asked yet.
- `chargePointAdminConformance(driver)`: the administration contract above.
  It creates stations named `CONFORMANCE-n`; against a live CSMS run
  `clearConformanceStations(driver.chargePoints)` first.
  `chargePointAdminViolations(driver)` is the failed rules only.

### Not applicable yet

Stated here rather than invented as tests:

- **Pagination.** No contract has a paged read, so there is nothing to ask.
  Skipped by design until a paged surface lands (ovarilo/csms-drivers#10).
- **Observations.** Same: no observation surface exists yet.
- **Timestamps.** The only timestamp in the contracts is `CommandOutcome.at`;
  `commandsConformance` checks it is an ISO 8601 instant and nothing about
  its value. Ordering and clock rules wait for the observation surface.

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
