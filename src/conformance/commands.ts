// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * commands.ts -- does `driver.commands` mean what `capabilities.commands`
 * says, and does every verdict arrive as a value?
 *
 * PROPERTY:
 *  - `commands` is implemented exactly when `capabilities.commands` is
 *    declared, and `poll` exactly when `polling` is;
 *  - `submit16` answers a fixture scenario with the state the caller expects
 *    (accepted, confirmed, rejected, unknown, or an `unknown` whose cause is a
 *    timeout, never `failed`), as a well-formed {@link CommandOutcome};
 *  - `submit16` never throws for a verdict, `UnsupportedOperationError`
 *    included;
 *  - `submit16` of a 1.6 action missing from `capabilities.operations16`
 *    answers `unsupported` as a value (skipped when every action is declared);
 *  - a driver declaring `completion: "accepted"` never reports `confirmed`;
 *  - with `polling`, `poll(ref)` of a submitted ref answers an outcome and
 *    `poll` of a ref nobody issued answers `null`.
 *
 * The suite cannot make a CSMS reject or time out by itself: each scenario is
 * an operation plus an optional `arrange` step, which is where the caller
 * steers its fake transport. A scenario that is not supplied is skipped with a
 * reason, as is `confirmed` for a driver that only declares `accepted`; a
 * skipped rule is never a passed one. Only `submit16` is asked; `submit201`
 * follows the same contract and is not exercised yet.
 */
import {
  CSMS_OPERATION_16_ACTIONS,
  UnsupportedOperationError,
  type CommandOutcome,
  type CommandOutcomeState,
  type CsmsOperation16,
} from "../contracts.ts";
import type { CsmsDriver } from "../models.ts";
import { SAMPLE_OPERATIONS_16 } from "./operations.ts";
import { createRecorder, type ConformanceReport } from "./report.ts";

/** One command to submit, and the setup that makes the CSMS answer as wanted. */
export interface CommandScenario {
  readonly op: CsmsOperation16;
  /** Runs before `submit16`: steer the fake transport to the wanted answer. */
  readonly arrange?: () => void | Promise<void>;
}

/** What {@link commandsConformance} submits. */
export interface CommandsFixtures {
  readonly cpId: string;
  /** A 1.6 operation the driver does not declare; default: the sample of the
   *  first undeclared action. */
  readonly undeclared?: CsmsOperation16;
  readonly scenarios: {
    /** The CSMS dispatched or queued it; the station's answer is not known. */
    readonly accepted?: CommandScenario;
    /** The station's CALLRESULT is observed. */
    readonly confirmed?: CommandScenario;
    /** The CSMS or the station refuses it. */
    readonly rejected?: CommandScenario;
    /** No evidence either way; any cause. */
    readonly unknown?: CommandScenario;
    /** The deadline passes after dispatch: `unknown` with cause `timeout`. */
    readonly timeout?: CommandScenario;
  };
}

type ScenarioName = keyof CommandsFixtures["scenarios"];

const RULE = {
  declaredWhenImplemented: "commands is implemented exactly when capabilities.commands is declared",
  pollWhenPolling: "poll is implemented exactly when capabilities.commands.polling is declared",
  accepted: "submit16 reports an accepted command as accepted",
  confirmed: "submit16 reports a confirmed command as confirmed",
  rejected: "submit16 reports a refused command as rejected",
  unknown: "submit16 reports an unanswered command as unknown",
  timeout: "submit16 reports a timeout as unknown with cause timeout, never failed",
  neverThrows: "submit16 returns a verdict instead of throwing",
  wellFormed: "every outcome is one of the six documented states with its required fields",
  undeclared: "submit16 of an undeclared 1.6 action answers unsupported",
  completionHolds: "a driver declaring completion accepted never reports confirmed",
  pollSubmitted: "poll of a submitted ref answers an outcome",
  pollUnknown: "poll of a ref nobody issued answers null",
} as const;

type RuleName = (typeof RULE)[keyof typeof RULE];

const EXPECTED: Record<ScenarioName, { rule: RuleName; state: CommandOutcomeState }> = {
  accepted: { rule: RULE.accepted, state: "accepted" },
  confirmed: { rule: RULE.confirmed, state: "confirmed" },
  rejected: { rule: RULE.rejected, state: "rejected" },
  unknown: { rule: RULE.unknown, state: "unknown" },
  timeout: { rule: RULE.timeout, state: "unknown" },
};

const STATES: readonly string[] = [
  "unsupported",
  "rejected",
  "accepted",
  "confirmed",
  "failed",
  "unknown",
];
const CAUSES: readonly string[] = ["timeout", "connection-lost", "no-evidence"];

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Why `value` is not a well-formed outcome, or `undefined` when it is. */
function malformed(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const outcome = value as Record<string, unknown>;
  const state = outcome["state"];
  if (typeof state !== "string" || !STATES.includes(state)) {
    return `state ${JSON.stringify(state)} is not one of the six documented states`;
  }
  if (state === "unsupported") {
    return typeof outcome["reason"] === "string" ? undefined : "unsupported lacks a reason";
  }
  const at = outcome["at"];
  if (typeof at !== "string" || !ISO_INSTANT.test(at) || Number.isNaN(Date.parse(at))) {
    return `${state} lacks an ISO 8601 \`at\``;
  }
  if (state === "unknown" && !CAUSES.includes(String(outcome["cause"]))) {
    return `unknown has the cause ${JSON.stringify(outcome["cause"])}`;
  }
  return undefined;
}

/** Asks the `commands` surface of `driver`; see the file header. */
export async function commandsConformance(
  driver: CsmsDriver,
  fixtures: CommandsFixtures,
): Promise<ConformanceReport> {
  const recorder = createRecorder(Object.values(RULE));
  const declared = driver.capabilities.commands;
  const commands = driver.commands;

  if (declared === undefined && commands === undefined) {
    recorder.skip(Object.values(RULE), "the driver declares no commands");
    return recorder.report("the suite did not ask this rule");
  }
  recorder.expect(
    declared !== undefined && commands !== undefined,
    RULE.declaredWhenImplemented,
    declared === undefined
      ? "commands is implemented but capabilities.commands is not declared"
      : "capabilities.commands is declared but commands is not implemented",
  );
  if (declared === undefined || commands === undefined) {
    recorder.skip(Object.values(RULE), "the commands surface is not coherently declared");
    return recorder.report("the suite did not ask this rule");
  }
  recorder.expect(
    declared.polling === (commands.poll !== undefined),
    RULE.pollWhenPolling,
    declared.polling
      ? "polling is declared but poll is not implemented"
      : "poll is implemented but polling is not declared",
  );

  const undeclaredAction = CSMS_OPERATION_16_ACTIONS.find(
    (a) => !driver.capabilities.operations16.has(a),
  );
  const undeclaredOp: CsmsOperation16 | undefined =
    fixtures.undeclared ??
    (undeclaredAction === undefined ? undefined : SAMPLE_OPERATIONS_16[undeclaredAction]);
  if (undeclaredOp === undefined) {
    recorder.skip(RULE.undeclared, "the driver declares every 1.6 action");
  } else {
    let problem: string | undefined;
    try {
      const outcome = await commands.submit16(fixtures.cpId, undeclaredOp);
      const state = (outcome as { state?: unknown } | null)?.state;
      if (state !== "unsupported") problem = `answered ${JSON.stringify(state)}`;
    } catch (error) {
      problem = `threw ${error instanceof Error ? error.name : String(error)}`;
    }
    recorder.expect(
      problem === undefined,
      RULE.undeclared,
      `${undeclaredOp.action} is not declared in capabilities.operations16 and submit16 ${problem} instead of answering unsupported`,
    );
  }

  const refs: string[] = [];
  let submitted = 0;
  for (const name of Object.keys(EXPECTED) as ScenarioName[]) {
    const { rule, state } = EXPECTED[name];
    const scenario = fixtures.scenarios[name];
    if (scenario === undefined) {
      recorder.skip(rule, `no ${name} scenario supplied`);
      continue;
    }
    // An accepted-completion driver is still asked the confirmed scenario: it
    // must not answer confirmed. The rule that it does is what is skipped.
    const mustConfirm = !(name === "confirmed" && declared.completion === "accepted");
    if (!mustConfirm) recorder.skip(rule, "the driver declares completion accepted");
    let outcome: CommandOutcome;
    try {
      await scenario.arrange?.();
      outcome = await commands.submit16(fixtures.cpId, scenario.op);
    } catch (error) {
      const what =
        error instanceof UnsupportedOperationError
          ? "UnsupportedOperationError, which is an execute semantic"
          : error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
      recorder.expect(false, RULE.neverThrows, `the ${name} scenario threw ${what}`);
      if (mustConfirm) {
        recorder.expect(false, rule, `the ${name} scenario threw instead of returning an outcome`);
      }
      continue;
    }
    submitted++;
    recorder.expect(true, RULE.neverThrows);
    const problem = malformed(outcome);
    recorder.expect(
      problem === undefined,
      RULE.wellFormed,
      `the ${name} scenario answered a malformed outcome: ${problem}`,
    );
    if (problem !== undefined) {
      if (mustConfirm) {
        recorder.expect(false, rule, `the ${name} scenario answered a malformed outcome`);
      }
      continue;
    }
    const cause = outcome.state === "unknown" ? outcome.cause : undefined;
    if (mustConfirm) {
      recorder.expect(
        outcome.state === state && (name !== "timeout" || cause === "timeout"),
        rule,
        `the ${name} scenario answered ${outcome.state}${cause ? ` (cause ${cause})` : ""}, expected ${state}${name === "timeout" ? " with cause timeout" : ""}`,
      );
    }
    if (declared.completion === "accepted") {
      recorder.expect(
        outcome.state !== "confirmed",
        RULE.completionHolds,
        `the ${name} scenario answered confirmed although completion is declared accepted`,
      );
    } else {
      recorder.skip(RULE.completionHolds, "the driver declares completion confirmed");
    }
    if ("ref" in outcome && outcome.ref !== undefined) refs.push(outcome.ref);
  }
  if (submitted === 0) {
    recorder.skip(
      [RULE.neverThrows, RULE.wellFormed, RULE.completionHolds],
      "no scenario was submitted",
    );
  }

  const poll = (ref: string) => commands.poll?.(ref) ?? Promise.resolve(undefined);
  if (!declared.polling || commands.poll === undefined) {
    recorder.skip([RULE.pollSubmitted, RULE.pollUnknown], "the driver declares no polling");
  } else {
    const ref = refs[0];
    if (ref === undefined) {
      recorder.skip(RULE.pollSubmitted, "no submitted scenario answered a ref");
    } else {
      const polled = await poll(ref).catch((error: unknown) => error);
      const problem =
        polled === null
          ? "poll answered null for a ref the driver issued"
          : polled instanceof Error
            ? `poll threw ${polled.name}: ${polled.message}`
            : malformed(polled);
      recorder.expect(problem === undefined, RULE.pollSubmitted, problem);
    }
    const nobody = await poll(`conformance-unissued-${Date.now()}`).catch(
      (error: unknown) => error,
    );
    recorder.expect(
      nobody === null,
      RULE.pollUnknown,
      nobody instanceof Error
        ? `poll threw ${nobody.name}: ${nobody.message}`
        : "poll did not answer null",
    );
  }

  return recorder.report("the suite did not ask this rule");
}
