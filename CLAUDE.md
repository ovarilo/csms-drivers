# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@ovarilo/csms-drivers`: a Bun/TypeScript library, with no runtime dependency, that drives a CSMS (SteVe, CitrineOS) through typed OCPP 1.6 and 2.0.1 operation contracts, plus an HTTP/JSON handler over any driver. It was extracted from `juherr/open-ocpp-tck` (`packages/csms-driver`). Comments that cite `tck/…`, `drivers/…` or `juherr/open-ocpp-tck#N` point at that upstream repository.

Consumers install published versions from GitHub Packages; a git dependency is not a supported distribution (it carries no `dist/`). `package.json#exports` resolves `bun` to the raw `src/*.ts`, and `types` and `default` to the generated `dist/` (ESM JavaScript and declarations), so the package runs on Node 26 as well.

## Commands

```sh
bun install
bunx vp config --no-agent # once: installs the pre-commit (vp staged) and commit-msg (commitlint) hooks
bun run check            # vp check (Oxfmt + Oxlint) + typecheck + test + package content: what CI runs
bun run format           # Oxfmt rewrite
bun run typecheck        # tsc --noEmit over src/, tests/, examples/, scripts/
bun run test             # build, boundary guard, every test, the example, the npm/Node 26/Bun package smoke
bun run build            # regenerate dist/ (cleaned first); `bun run test` runs it, run it yourself before a lone smoke
bun tests/csms-server.ts # a single test: each test file is a standalone script
bun scripts/release.ts prepare X.Y.Z # release PR: dates CHANGELOG, bumps package.json
```

Commits follow Conventional Commits (commitlint in the hook and in CI, PR title included). `CHANGELOG.md` follows Keep a Changelog 1.1.0, not Common Changelog: add an entry under `## [Unreleased]` with each notable change. A release is the `Release` workflow dispatched on `main` (see README "Releasing"): it publishes to GitHub Packages, then tags `vX.Y.Z`.

Tests are plain Bun scripts, not a test runner. Each one collects failures through `check(...)`, prints them all at the end and exits 1 if there are any. The file header states the PROPERTY it guards, in numbered parts. Add a row to the matching file rather than creating a framework.

## Invariants enforced by scripts

- **`dist/` is generated and ignored by git** (Node refuses to strip types under `node_modules`, so Node consumers need the JavaScript). `bun run test` builds it first, so `bun run check` works on a fresh checkout. Never commit it. The Release workflow publishes the `dist/` its gate validated, checked by pack integrity (see the `release.yml` header).
- **`tsconfig.json` sets `customConditions: ["bun"]`**: tests and examples import the package by name, and type-check against `src/` as Bun runs them, not against a `dist/` that may be missing.
- **`scripts/package-smoke.sh`**: packs, installs with npm under Node 26 without devDependencies, runs a driver and the server from Node and Bun, and type-checks a `nodenext` consumer.
- **Vite+ never touches `dist/`**: `vite.config.ts` excludes it from Oxfmt and Oxlint, since it ships as tsc emits it. tsc 5.9 is the only type-check (`typeAware` lint rules, no `typeCheck`). No `prepare`/`prepack` script: the build is an explicit step of `test` and of the release.
- **`scripts/check-package.ts`**: the `npm pack` listing carries every exports target and no development file, and every conditional export names one module three ways (`bun` `./src/<m>.ts`, `types` `./dist/<m>.d.ts`, `default` `./dist/<m>.js`). Subpaths are listed explicitly, never as a `*` pattern; `scripts/package-smoke.sh` imports each one from the installed package.
- **`scripts/boundary.sh`**:
  - every import under `src/` is relative or `node:*`, never a package;
  - every relative specifier names a `.ts` file, which the build rewrites to `.js`: an extensionless or directory specifier does not resolve on Node;
  - `src/server/` may import only its siblings and `../contracts`, `../models`, `../charge-points`, never a concrete driver; `src/shared/` follows the same allowlist.
- Consumers resolve the package with `moduleResolution: bundler` or `nodenext`; `@ovarilo/csms-drivers/tsconfig` exports `tsconfig.base.json` (`bundler`) for them. That base file holds compilerOptions only: an `include` there would resolve inside `node_modules`.

## Architecture

- **Contract core** (`src/contracts.ts`, `src/models.ts`, `src/charge-points.ts`):
  - `CsmsDriver` = `operations16` (required), `operations201?`, `sessions?`, `connectors?`, `chargePoints?`, and `capabilities`.
  - Operations are discriminated unions keyed by `action` (`CsmsOperation16`, `CsmsOperation201`). OCPP 1.6 and 2.0.1 stay separate contracts.
  - `capabilities` declares only what the driver can actually dispatch. Consumers decide from capabilities alone, never from knowing which CSMS is behind the driver.
- **Error semantics are part of the contract**:
  - `UnsupportedOperationError` is a capability gap of the CSMS.
  - `CsmsNotDispatchedError` means the request never became an OCPP CALL.
  - A plain `Error` is an environment or CSMS fault.
  - `ChargePointAlreadyExistsError` and `ChargePointNotFoundError` cover administration.
  - Don't swap one class for another casually: the HTTP status mapping and upstream verdicts depend on them.
- **Drivers** are factories (`createSteveCsmsDriver`, `createCitrineOsCsmsDriver`, `createCodeticsEvServerLiteCsmsDriver`, `createEvtivityCsmsDriver`). They take config, an injectable `fetch: FetchLike` transport (how every test fakes the CSMS), and the lookups needed to translate opaque handles (CitrineOS `refs`).
  - **SteVe** (`src/steve/`) drives the manager UI like a browser: login, CSRF token, form POST, through one shared and locked session (`ui-client.ts`). Charge-point administration also goes through the UI, because SteVe has no REST endpoint for it. CSMS form fields stay in `forms.ts`. `commands`: accepted-only, no `poll`.
  - **CitrineOS** (`src/citrineos/`) uses the message API. `variant` (`v1`/`v2`) decides what is routable (`variant.ts`); only `v2` exposes `operations201`. It does not implement `chargePoints` yet. `commands`: accepted-only, no `poll`, `submit201` only on `v2`.
  - **Codetics ev-server-lite** (`src/codetics-ev-server-lite/`) queues every 1.6 operation through the REST command endpoint and polls the command state (`requests.ts` has the state table). Its login is cached per process, server, account and password digest (SHA-256, never the raw password), because the server rate-limits signins (`api-client.ts`). Charging profiles come from `refs.chargingProfileByRef`. No `operations201`, no `chargePoints`. `commands`: confirmed, with `poll`.
  - **EVtivity** (`src/evtivity/`) posts each 1.6 operation to its own synchronous REST route, which blocks until the station answers; `requests.ts` has the status/`error`-prefix table that splits a non-dispatch from a station's answer. Its JWT login is cached per process, server, account and password digest (SHA-256, never the raw password), renewed before `exp` or on a 401 once the session is a minute old, and a refused login is kept for fifteen minutes (`api-client.ts`), because refused passwords feed the account's sign-in backoff. Charging profiles come from `refs.chargingProfileByRef`. No `operations201`, no `chargePoints`. `commands`: confirmed, no `poll`.
- **Shared helpers** (`src/shared/`, internal, not exported): `http.ts` holds what every REST-speaking driver does with an answered response (bounded body preview, best-effort error body, answered-body read/parse as plain `Error`s, `Set-Cookie` split). Reuse it rather than copying a helper into a driver. `src/citrineos/http.ts` only re-exports part of it, because `./citrineos/http` is a public subpath.
- **HTTP adapter** (`src/server/`): `createCsmsHttpHandler(driver, options)` is a stateless `(Request) => Promise<Response>`, documented in `src/server/README.md`.
  - Each request makes at most one driver call.
  - Errors use a deterministic `{"error":{"code","message"}}` envelope.
  - `secrets` are redacted from responses and logs.
  - Requests with an `Origin` header or a non-JSON body are refused, as browser/CSRF protection.
  - The decoders in `decode.ts` are hand-written. `tests/csms-server.ts` holds every action arm to an exact round-trip, so a new 1.6 action needs a row there and a path in `OPERATION_16_PATHS`.
- The charge-point administration contract (create/get/update/delete edge cases, security profiles 0–3) is specified in `README.md` and checked by the reusable conformance suite in `src/conformance/charge-points.ts`. Each of its rules has a flawed driver copy that must be refused (`tests/csms-driver-charge-points.ts`).
- **Conformance suites** (`src/conformance/`, published as `@ovarilo/csms-drivers/conformance`): charge-point administration, `operationsConformance` and `commandsConformance`. Pure functions over the core types, no runner; each returns a `ConformanceReport` (`passed`, `failed`, `skipped` with a reason). A rule that depends on something the driver does not declare is skipped, never passed. `tests/conformance-operations.ts` holds the operations and commands suites to a false declaration. Imports stay within `../contracts`, `../models`, `../charge-points` (`scripts/boundary.sh`).
