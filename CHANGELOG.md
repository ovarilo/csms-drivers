# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Charge-point administration for the Codetics ev-server-lite driver (`driver.chargePoints`):
  `create`, `get`, `update` and `delete` over the server's `/api/v1/stations` routes. The server
  generates the Basic Auth password (returned once as `generatedBasicAuthPassword`), requires
  the description, and always accepts a boot, so the driver declares `"generated"`, `"required"`
  and `registrations` of `Accepted` only. Profile 1 is always offered; profiles 0 and 3 come from
  the new driver options `allowUnauthenticated` and `clientCaConfigured`, readable without a
  client through `codeticsEvServerLiteCapabilities(options)`. Profile 2 is not offered. An `update` of the
  description reads the record and writes all of it back, so it is not atomic; `delete` of a station in an active
  session is a plain `Error`.

- `capabilities.chargePoints.basicAuthPassword` (`"supplied"`, the default, or `"generated"`)
  and `capabilities.chargePoints.description` (`"optional"`, the default, or `"required"`):
  what a CSMS imposes on a station's Basic Auth password and description. A CSMS that
  generates the password gets `ChargePointSecurity` without `basicAuthPassword` for profile 1
  or 2, and `create`/`update` return it once as `generatedBasicAuthPassword`
  (`ChargePointProvisioned`); `get` never does. A required description must be given and
  non-blank on `create` and cannot be cleared or blanked on `update`. A request that does not
  match the declaration is refused with `UnsupportedOperationError` and changes nothing. Over
  HTTP the `POST` answer gains `generatedBasicAuthPassword` beside the id, a `PATCH` that
  rotated a password answers `200` with it instead of `204` (both `cache-control: no-store`,
  never logged), a missing or blank required description answers `400 invalid_input`, and
  `GET /v1/driver` reports both declarations. SteVe declares `"supplied"` and `"optional"`.
  `chargePointAdminConformance` gains six rules, each with a flawed copy in the guard.

- Optional command outcomes: `CsmsDriver.commands` (`submit16`, `submit201?` mirroring
  `operations16`/`operations201`, and `poll` when `capabilities.commands.polling`) reports a `CommandOutcome` (`unsupported`, `rejected`,
  `accepted`, `confirmed`, `failed`, `unknown`) as a value: every verdict is returned, and
  `submit16` throws only when none can be given. A timeout after dispatch is
  `unknown`, never `failed`. `execute` is unchanged. Over HTTP, the `202` of an operation gains `outcome` when the driver has `commands`
  (`status: "dispatched"` stays, errors and `504` are unchanged), `GET /v1/commands/{ref}` serves
  polling, and `GET /v1/driver` reports `commands`. See "Command outcomes" in
  `src/server/README.md`.
- `capabilities.chargePoints.registrations`: the registration statuses (`Accepted`, `Pending`,
  `Rejected`) a driver's `create` and `update` accept. Absent means all three, so existing
  drivers are unchanged; present, it is never empty and contains `Accepted`. An undeclared
  status is refused with `UnsupportedOperationError` and changes nothing, `get` never returns
  one, and the HTTP description lists them as `chargePoints.registrations` (an undeclared one on
  `POST`/`PATCH` answers `501 unsupported_capability`). SteVe declares all three.
- `@ovarilo/csms-drivers/conformance`: the conformance suites as a published subpath, with no
  test-runner dependency. `chargePointAdminConformance` (moved from `tests/lib`),
  `operationsConformance` (every declared 1.6 and 2.0.1 action must not be refused as
  unsupported, every undeclared one must be; `SAMPLE_OPERATIONS_16` as default fixtures) and
  `commandsConformance` (the `commands` surface: outcomes as values, a timeout as `unknown`,
  an undeclared 1.6 action answered `unsupported`, an ISO 8601 `at`, polling). Each returns a `ConformanceReport` with `passed`, `failed` and
  `skipped` rules; a rule the driver's declaration makes not applicable is skipped with a reason, never passed.
  Pagination, observations and timestamps are documented as not applicable until their surfaces
  land.
- Drive a Codetics ev-server-lite CSMS with `createCodeticsEvServerLiteCsmsDriver`: every OCPP
  1.6 operation goes through its REST command endpoint, and `execute()` resolves once the
  command was written to the station. Ported from open-ocpp-tck's
  `drivers/codetics-ev-server-lite`, without its TCK fixtures.
- Drive an EVtivity CSMS over OCPP 1.6 with `createEvtivityCsmsDriver`: each operation goes
  through its own synchronous REST command route, and `execute()` resolves with the station's
  answer. The JWT login is shared per process and renewed when it runs out, and a refused login
  is remembered for fifteen minutes. Ported from open-ocpp-tck's `drivers/evtivity`, without its
  TCK fixtures.
- Command outcomes for the four bundled drivers (`driver.commands`, see above). Codetics
  ev-server-lite and EVtivity read the station's answer (`completion: "confirmed"`); Codetics
  also polls by command id, EVtivity has no `poll`. SteVe and CitrineOS are accepted-only
  (`completion: "accepted"`, no `poll`): a dispatched command is `accepted`, never `confirmed`,
  and CitrineOS `v1` has no `submit201`. A timeout is `unknown`; what `execute` throws is still
  thrown. The README tabulates what a `2xx` or `CALLRESULT` means per driver, with retry guidance.
- An EVtivity command wait interrupted after the CALL may have left is still a
  `CsmsNotDispatchedError` for `execute` (an internal subclass, not exported), and
  `commands.submit16` reports it as `unknown`.
- Subpath exports for the drivers' building blocks, for adapters that compose their own driver:
  `@ovarilo/csms-drivers/steve/{api-client,ui-client,forms,charge-points}` and
  `@ovarilo/csms-drivers/citrineos/{api-client,config,http,requests,variant}`.
- `STEVE_CAPABILITIES` is exported from the package root, beside `createSteveCsmsDriver`, as
  `citrineOsCapabilities` already was.

### Changed

- Breaking for code that implements `CsmsChargePointAdmin`: `create` and `update` now return
  `Promise<void | ChargePointProvisioned>` (still assignable from `Promise<void>`, but a caller
  that treated the result as `void` must now read it) and `ChargePointSecurity` gains a profile
  1 or 2 arm without `basicAuthPassword`. External drivers, such as ones written against the
  previous types, fail to type-check where they read `security.basicAuthPassword` as a
  `string` or narrow the union; use `suppliedBasicAuthPassword(security)` and refuse the
  passwordless arm with `UnsupportedOperationError` (or declare `"generated"`). Over HTTP, a
  profile 1 or 2 without a password is no longer `400 invalid_input`: it is
  `501 unsupported_capability` on a driver that declares `"supplied"`.
- The charge-point conformance suite reports through a `ConformanceReport`.
  `updateAppliesRegistration` and `updateAppliesSecurity` are now `skipped` when the declaration
  leaves no status or profile to move to, where the first used to pass vacuously and the second
  went unreported.
  `chargePointAdminViolations` returns the failed rules only: a skipped rule is not a violation,
  and a lifecycle that threw is one violation naming the error.
- `tests/lib/charge-point-conformance.ts` is removed; import from
  `@ovarilo/csms-drivers/conformance`.

### Fixed

- The charge-point conformance suite no longer fails a CSMS that has no `Pending` or `Rejected`
  registration: it asks for the statuses the driver declares, skips the moves that need a
  status it lacks, and checks that an undeclared one is refused.

- SteVe 3.15.0: charge-point administration finds a station whose id looks like markup
  (`CP&01`, a quote) on the escaped list 3.15.0 renders, and no longer takes another station
  for it on the raw list of 3.14.x (`X&amp;amp;` listed for `X&amp;`).
- SteVe: a ReserveNow carrying a `parentIdTag` throws `UnsupportedOperationError` unless it is
  the reserved tag's stored parent, which the new `ocppTagParent` option of
  `createSteveCsmsDriver` looks up. SteVe has no field for another parent and sends the stored
  one, so the requested parent used to be dropped silently.
- SteVe WebAPI (`steve/api-client`): a refused request whose error body cannot be read keeps
  its method, path and status in the error, with `<unreadable body>` in place of the body,
  instead of failing with the stream's own error.

## [0.0.2] - 2026-10-19

### Added

- Run on Node 26: the package ships ESM JavaScript in `dist/`, beside its declarations, and
  Node loads it through the `default` export condition. Bun keeps loading `src/` through the
  `bun` condition.
- TypeScript consumers can resolve the package with `"moduleResolution": "nodenext"` as well
  as `"bundler"`.

### Removed

- **Breaking:** installing from the git repository (`github:ovarilo/csms-drivers#<ref>`) is no
  longer supported. `dist/` is built at release time and not committed, so a checkout lacks what
  Node and TypeScript load. Install the versions published to GitHub Packages instead.

## [0.0.1] - 2026-10-19

### Added

- Typed OCPP 1.6 and 2.0.1 operation contracts (`CsmsDriver`, `CsmsOperation16`,
  `CsmsOperation201`), capabilities and the error classes that carry their semantics,
  extracted from `juherr/open-ocpp-tck` (`packages/csms-driver`).
- SteVe driver (`createSteveCsmsDriver`), driving the manager UI, with charge-point
  administration.
- CitrineOS driver (`createCitrineOsCsmsDriver`) for the `v1` and `v2` message APIs.
- HTTP/JSON handler over any driver (`@ovarilo/csms-drivers/server`).
- Charge-point administration conformance suite (`tests/lib/charge-point-conformance.ts`).
- Shared TypeScript base config for consumers (`@ovarilo/csms-drivers/tsconfig`).
- Publication to GitHub Packages, next to the pinned git dependency.

[unreleased]: https://github.com/ovarilo/csms-drivers/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/ovarilo/csms-drivers/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/ovarilo/csms-drivers/releases/tag/v0.0.1
