# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@ovarilo/csms-drivers`: a Bun/TypeScript library, with no runtime dependency, that drives a CSMS (SteVe, CitrineOS) through typed OCPP 1.6 and 2.0.1 operation contracts, plus an HTTP/JSON handler over any driver. It was extracted from `juherr/open-ocpp-tck` (`packages/csms-driver`). Comments that cite `tck/…`, `drivers/…` or `juherr/open-ocpp-tck#N` point at that upstream repository.

Consumers install it as a pinned git dependency (`bun add github:ovarilo/csms-drivers#<ref>`), and `package.json#exports` points `default` at the raw `src/*.ts`. Nothing is compiled except the declarations.

## Commands

```sh
bun install
bunx vp config --no-agent # once: installs the pre-commit (vp staged) and commit-msg (commitlint) hooks
bun run check            # vp check (Oxfmt + Oxlint) + typecheck + test + package content: what CI runs
bun run format           # Oxfmt rewrite
bun run typecheck        # tsc --noEmit over src/, tests/, examples/, scripts/
bun run test             # boundary guard, committed-types check, every test, the example
bun run build:types      # regenerate types/ — required after any public API change
bun tests/csms-server.ts # a single test: each test file is a standalone script
bun scripts/release.ts prepare X.Y.Z # release PR: dates CHANGELOG, bumps package.json
```

Commits follow Conventional Commits (commitlint in the hook and in CI, PR title included). `CHANGELOG.md` follows Keep a Changelog 1.1.0, not Common Changelog: add an entry under `## [Unreleased]` with each notable change. A release is the `Release` workflow dispatched on `main` (see README "Releasing"): it publishes to GitHub Packages, then tags `vX.Y.Z`.

Tests are plain Bun scripts, not a test runner. Each one collects failures through `check(...)`, prints them all at the end and exits 1 if there are any. The file header states the PROPERTY it guards, in numbered parts. Add a row to the matching file rather than creating a framework.

## Invariants enforced by scripts

- **`types/` is generated but committed** (a git dependency does not run `prepare` under Bun). `scripts/types-current.sh` rebuilds into a temporary directory and diffs, so any change to an exported signature needs `bun run build:types` and a commit of `types/`.
- **Vite+ never touches `types/`**: `vite.config.ts` excludes it from Oxfmt and Oxlint, since `types-current.sh` diffs it byte for byte. tsc 5.9 is the only type-check (`typeAware` lint rules, no `typeCheck`). No `prepare` script: git-dependency consumers would run it without Vite+.
- **`scripts/check-package.ts`**: the `npm pack` listing carries every exports target and no development file.
- **`scripts/boundary.sh`**:
  - every import under `src/` is relative or `node:*`, never a package;
  - `src/server/` may import only its siblings and `../contracts`, `../models`, `../charge-points`, never a concrete driver.
- Consumers need `moduleResolution: bundler`; `@ovarilo/csms-drivers/tsconfig` exports `tsconfig.base.json` for them. That base file holds compilerOptions only: an `include` there would resolve inside `node_modules`.

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
- **Drivers** are factories (`createSteveCsmsDriver`, `createCitrineOsCsmsDriver`). They take config, an injectable `fetch: FetchLike` transport (how every test fakes the CSMS), and the lookups needed to translate opaque handles (CitrineOS `refs`).
  - **SteVe** (`src/steve/`) drives the manager UI like a browser: login, CSRF token, form POST, through one shared and locked session (`ui-client.ts`). Charge-point administration also goes through the UI, because SteVe has no REST endpoint for it. CSMS form fields stay in `forms.ts`.
  - **CitrineOS** (`src/citrineos/`) uses the message API. `variant` (`v1`/`v2`) decides what is routable (`variant.ts`); only `v2` exposes `operations201`. It does not implement `chargePoints` yet.
- **HTTP adapter** (`src/server/`): `createCsmsHttpHandler(driver, options)` is a stateless `(Request) => Promise<Response>`, documented in `src/server/README.md`.
  - Each request makes at most one driver call.
  - Errors use a deterministic `{"error":{"code","message"}}` envelope.
  - `secrets` are redacted from responses and logs.
  - Requests with an `Origin` header or a non-JSON body are refused, as browser/CSRF protection.
  - The decoders in `decode.ts` are hand-written. `tests/csms-server.ts` holds every action arm to an exact round-trip, so a new 1.6 action needs a row there and a path in `OPERATION_16_PATHS`.
- The charge-point administration contract (create/get/update/delete edge cases, security profiles 0–3) is specified in `README.md` and checked by the reusable conformance suite in `tests/lib/charge-point-conformance.ts`. Each of its rules has a flawed driver copy that must be refused.
