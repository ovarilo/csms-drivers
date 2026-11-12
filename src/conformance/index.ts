// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * `@ovarilo/csms-drivers/conformance` -- capability-driven conformance suites.
 *
 * Pure functions over the core types, no test runner: each asks a `CsmsDriver`
 * a fixed list of rules and returns a {@link ConformanceReport} whose rules are
 * `passed`, `failed`, or `skipped` when the driver's declaration makes them not
 * applicable.
 */
export * from "./report.ts";
export * from "./charge-points.ts";
export * from "./operations.ts";
export * from "./commands.ts";
