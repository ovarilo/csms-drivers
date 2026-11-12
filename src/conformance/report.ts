// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * report.ts -- what a conformance suite hands back.
 *
 * A suite asks a driver a fixed list of rules. Each rule ends in exactly one of
 * three states, and the report keeps them apart:
 *
 *  - `passed`: the rule was asked and the driver met it every time;
 *  - `failed`: the rule was asked and the driver broke it, or the suite could
 *    not finish asking;
 *  - `skipped`: the rule depends on something the driver does not declare (a
 *    capability, a registration status, a security profile), so it was not
 *    asked. A skipped rule is never counted as passed: "not applicable" and
 *    "conforms" are different answers.
 *
 * No test runner is involved: a caller reads the report and decides.
 */

/** One rule the driver broke, and why. */
export interface ConformanceFailure<R extends string = string> {
  readonly rule: R;
  readonly detail: string;
}

/** One rule that was not asked, and why not. */
export interface ConformanceSkip<R extends string = string> {
  readonly rule: R;
  readonly reason: string;
}

/** The outcome of one suite run; every rule of the suite appears exactly once. */
export interface ConformanceReport<R extends string = string> {
  readonly passed: readonly R[];
  readonly failed: readonly ConformanceFailure<R>[];
  readonly skipped: readonly ConformanceSkip<R>[];
}

/** True when nothing failed. Skipped rules do not make a run fail, and do not make it pass. */
export function conformanceHolds(report: ConformanceReport): boolean {
  return report.failed.length === 0;
}

/** Collects the answers of a suite run and turns them into a {@link ConformanceReport}. */
export interface ConformanceRecorder<R extends string> {
  /** Asks a rule: records it as met or broken. `detail` explains a break. */
  expect(condition: boolean, rule: R, detail?: string): void;
  /** Marks rules as not applicable, unless they end up asked after all. */
  skip(rules: R | readonly R[], reason: string): void;
  /** Records a break that belongs to no declared rule (the suite could not finish). */
  abort(rule: string, detail: string): void;
  /** The report: every rule of `rules` once, in order; an unasked, unexplained one is skipped. */
  report(unreached: string): ConformanceReport<R | string>;
}

/** A recorder over `rules`, which fixes the order of the report. */
export function createRecorder<R extends string>(rules: readonly R[]): ConformanceRecorder<R> {
  const met = new Set<R>();
  const broken = new Map<R, string>();
  const skipReasons = new Map<R, string>();
  const aborted: ConformanceFailure[] = [];
  return {
    expect(condition, rule, detail = "the driver does not satisfy this rule") {
      if (condition) met.add(rule);
      else if (!broken.has(rule)) broken.set(rule, detail);
    },
    skip(skipped, reason) {
      for (const rule of typeof skipped === "string" ? [skipped] : skipped) {
        if (!skipReasons.has(rule)) skipReasons.set(rule, reason);
      }
    },
    abort(rule, detail) {
      aborted.push({ rule, detail });
    },
    report(unreached) {
      const passed: (R | string)[] = [];
      const failed: ConformanceFailure[] = [];
      const skipped: ConformanceSkip[] = [];
      for (const rule of rules) {
        const detail = broken.get(rule);
        if (detail !== undefined) failed.push({ rule, detail });
        else if (met.has(rule)) passed.push(rule);
        else skipped.push({ rule, reason: skipReasons.get(rule) ?? unreached });
      }
      return { passed, failed: [...failed, ...aborted], skipped };
    },
  };
}
