# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[unreleased]: https://github.com/ovarilo/csms-drivers/commits/main
