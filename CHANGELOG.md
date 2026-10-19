# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[unreleased]: https://github.com/ovarilo/csms-drivers/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/ovarilo/csms-drivers/releases/tag/v0.0.1
