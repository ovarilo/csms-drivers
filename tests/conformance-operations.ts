// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * conformance-operations.ts -- the operations and commands suites of
 * `@ovarilo/csms-drivers/conformance` tell a true capability declaration from
 * a false one, and never count what they did not ask as conforming.
 *
 * PROPERTY, in 5 parts:
 *  1. A CORRECT DRIVER IS GREEN. A driver whose `execute` agrees with its
 *     declaration (declared actions work, the rest throw
 *     `UnsupportedOperationError`) fails nothing, and its declared actions are
 *     `passed`; the real CitrineOS driver (v1 and v2) behind a fake transport
 *     is one.
 *  2. A FALSE DECLARATION IS RED. An action declared but refused as
 *     unsupported, an action undeclared but working, and an undeclared action
 *     refused with the wrong error class each fail the rule of THAT action; a
 *     declared action failing in any other way (not dispatched, a plain
 *     error) does not disprove the declaration. `operations201` present
 *     without a declaration, or declared without being implemented, fails.
 *  3. SKIPPED IS NOT PASSED. An action without a fixture, and every 2.0.1
 *     action of a 1.6-only driver, are skipped with a reason; with no fixture
 *     at all nothing passes. Every rule appears in exactly one list.
 *  4. THE COMMANDS SURFACE. Absent `commands` skips everything. Accepted,
 *     confirmed, rejected and unknown scenarios must reach the expected state
 *     as a value; a timeout is `unknown` with cause `timeout`, and a `failed`
 *     in its place is red; a throwing `submit16` is red (UnsupportedOperationError
 *     included); a `confirmed` from an `accepted`-completion driver is red;
 *     `confirmed` is skipped for it; polling answers a submitted ref and
 *     `null` for a stranger, and is checked only when declared.
 *  5. THE SAMPLES COVER THE VOCABULARY. `SAMPLE_OPERATIONS_16` holds one
 *     operation per 1.6 action, each under its own name.
 */
import {
  CSMS_OPERATION_16_ACTIONS,
  CSMS_OPERATION_201_ACTIONS,
  CsmsNotDispatchedError,
  UnsupportedOperationError,
  createCitrineOsCsmsDriver,
  type CommandOutcome,
  type CsmsCommands,
  type CsmsDriver,
  type CsmsOperation16Action,
  type CsmsOperation201Action,
} from "@ovarilo/csms-drivers";
import {
  SAMPLE_OPERATIONS_16,
  commandsConformance,
  conformanceHolds,
  operationsConformance,
  type CommandsFixtures,
  type ConformanceReport,
} from "@ovarilo/csms-drivers/conformance";

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

const CP = "CP-1";
const R16 = (action: string) => `1.6 ${action}: execute agrees with the declaration`;
const R201 = (action: string) => `2.0.1 ${action}: execute agrees with the declaration`;
const PRESENCE = "operations201 is present exactly when capabilities.operations201 is declared";

const failedRules = (report: ConformanceReport) => report.failed.map((f) => f.rule);
const skippedRules = (report: ConformanceReport) => report.skipped.map((s) => s.rule);
function partitions(report: ConformanceReport, total: number): boolean {
  const all = [...report.passed, ...failedRules(report), ...skippedRules(report)];
  return all.length === total && new Set(all).size === total;
}
const TOTAL = CSMS_OPERATION_16_ACTIONS.length + 1 + CSMS_OPERATION_201_ACTIONS.length;

// ---------------------------------------------------------------------------
// A fake driver whose declaration and behaviour are set apart
// ---------------------------------------------------------------------------

type Behaviour = "works" | "unsupported" | "not-dispatched" | "error";

interface FakeOptions {
  declared16?: readonly CsmsOperation16Action[];
  /** Absent = no 2.0.1 declaration. */
  declared201?: readonly CsmsOperation201Action[];
  /** Per action, what `execute` does; default: works when declared, else unsupported. */
  behave16?: Partial<Record<CsmsOperation16Action, Behaviour>>;
  behave201?: Partial<Record<CsmsOperation201Action, Behaviour>>;
  /** Implements operations201 whatever the declaration says. */
  implement201?: boolean;
}

async function act(behaviour: Behaviour): Promise<string> {
  if (behaviour === "unsupported") throw new UnsupportedOperationError("op", "not expressible");
  if (behaviour === "not-dispatched") throw new CsmsNotDispatchedError("op", "no connection");
  if (behaviour === "error") throw new Error("the CSMS answered 500");
  return "receipt";
}

function fakeDriver(options: FakeOptions = {}): CsmsDriver {
  const declared16 = new Set(options.declared16 ?? CSMS_OPERATION_16_ACTIONS);
  const declared201 = options.declared201 ? new Set(options.declared201) : undefined;
  const has201 = options.implement201 ?? declared201 !== undefined;
  return {
    capabilities: {
      operations16: declared16,
      ...(declared201 ? { operations201: declared201 } : {}),
    },
    operations16: {
      execute: (_cp, op) =>
        act(options.behave16?.[op.action] ?? (declared16.has(op.action) ? "works" : "unsupported")),
    },
    ...(has201
      ? {
          operations201: {
            execute: (_cp, op) =>
              act(
                options.behave201?.[op.action] ??
                  (declared201?.has(op.action) ? "works" : "unsupported"),
              ),
          },
        }
      : {}),
  };
}

// 1. A correct driver is green ---------------------------------------------

{
  const subset: CsmsOperation16Action[] = ["Reset", "ClearCache", "GetConfiguration"];
  const report = await operationsConformance(fakeDriver({ declared16: subset }), { cpId: CP });
  check(
    conformanceHolds(report),
    `correct 1.6-only driver is green: ${JSON.stringify(report.failed)}`,
  );
  check(
    subset.every((a) => report.passed.includes(R16(a))),
    "declared actions are passed",
  );
  check(
    CSMS_OPERATION_16_ACTIONS.filter((a) => !subset.includes(a)).every((a) =>
      report.passed.includes(R16(a)),
    ),
    "undeclared actions that throw UnsupportedOperationError are passed",
  );
  check(
    CSMS_OPERATION_201_ACTIONS.every((a) => skippedRules(report).includes(R201(a))),
    "a 1.6-only driver skips every 2.0.1 action",
  );
  check(
    report.skipped.every((s) => s.reason.length > 0),
    "every skip carries a reason",
  );
  check(partitions(report, TOTAL), "every rule is in exactly one list");
}

{
  const report = await operationsConformance(
    fakeDriver({ declared201: ["Reset", "GetVariables"] }),
    { cpId: CP },
  );
  check(
    conformanceHolds(report),
    `correct 1.6 + 2.0.1 driver is green: ${JSON.stringify(report.failed)}`,
  );
  check(
    report.passed.includes(R201("Reset")) && report.passed.includes(R201("SetNetworkProfile")),
    "declared and undeclared 2.0.1 actions are passed",
  );
  check(report.passed.includes(PRESENCE), "operations201 presence agrees with the declaration");
  check(report.skipped.length === 0, "nothing is skipped when everything is asked");
}

// The real CitrineOS driver, behind a fake transport.
for (const variant of ["v1", "v2"] as const) {
  const driver = createCitrineOsCsmsDriver({
    config: { variant, apiUrl: "http://citrine/api", tenantId: 7 },
    refs: {
      ocppTransactionId: async () => 1,
      chargingProfileByRef: () => ({
        chargingProfileId: 1,
        stackLevel: 0,
        chargingProfilePurpose: "TxDefaultProfile",
        chargingProfileKind: "Absolute",
        chargingSchedule: {
          chargingRateUnit: "A",
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 16 }],
        },
      }),
    },
    fetch: async () => Response.json([{ success: true, payload: "Accepted" }]),
  });
  const report = await operationsConformance(driver, { cpId: CP });
  check(
    conformanceHolds(report),
    `CitrineOS ${variant} conforms to its declaration: ${JSON.stringify(report.failed)}`,
  );
  check(report.passed.length > 0, `CitrineOS ${variant} passes rules`);
}

// 2. A false declaration is red ---------------------------------------------

{
  const falselyDeclared = await operationsConformance(
    fakeDriver({ behave16: { Reset: "unsupported" } }),
    { cpId: CP },
  );
  check(
    failedRules(falselyDeclared).join("|") === R16("Reset"),
    `a declared action refused as unsupported fails its own rule only: ${failedRules(falselyDeclared).join(",")}`,
  );
  check(
    falselyDeclared.failed[0]?.detail.includes("UnsupportedOperationError") === true,
    "the detail names the refusal",
  );

  const underClaimed = await operationsConformance(
    fakeDriver({ declared16: ["Reset"], behave16: { ClearCache: "works" } }),
    { cpId: CP },
  );
  check(
    failedRules(underClaimed).join("|") === R16("ClearCache"),
    `an undeclared but working action fails: ${failedRules(underClaimed).join(",")}`,
  );

  for (const wrong of ["not-dispatched", "error"] as const) {
    const report = await operationsConformance(
      fakeDriver({ declared16: ["Reset"], behave16: { ClearCache: wrong } }),
      { cpId: CP },
    );
    check(
      failedRules(report).join("|") === R16("ClearCache"),
      `an undeclared action throwing ${wrong} fails (wrong class): ${failedRules(report).join(",")}`,
    );
  }

  for (const other of ["not-dispatched", "error"] as const) {
    const report = await operationsConformance(fakeDriver({ behave16: { Reset: other } }), {
      cpId: CP,
    });
    check(
      conformanceHolds(report) && report.passed.includes(R16("Reset")),
      `a declared action failing with ${other} does not disprove the declaration`,
    );
  }

  const false201 = await operationsConformance(
    fakeDriver({
      declared201: ["Reset"],
      behave201: { Reset: "unsupported", GetVariables: "works" },
    }),
    { cpId: CP },
  );
  check(
    failedRules(false201).sort().join("|") ===
      [R201("GetVariables"), R201("Reset")].sort().join("|"),
    `false 2.0.1 declarations fail: ${failedRules(false201).join(",")}`,
  );

  const stray = await operationsConformance(fakeDriver({ implement201: true }), { cpId: CP });
  check(
    failedRules(stray).join("|") === PRESENCE,
    `operations201 without a declaration fails the presence rule only: ${failedRules(stray).join(",")}`,
  );
  const hollow = await operationsConformance(
    fakeDriver({ declared201: ["Reset"], implement201: false }),
    { cpId: CP },
  );
  check(
    failedRules(hollow).includes(PRESENCE) && failedRules(hollow).includes(R201("Reset")),
    `declared 2.0.1 without an implementation fails: ${failedRules(hollow).join(",")}`,
  );
  check(!hollow.passed.includes(R201("Reset")), "a missing implementation never passes its action");
}

// 3. Skipped is not passed ------------------------------------------------------

{
  const report = await operationsConformance(fakeDriver(), {
    cpId: CP,
    operations16: { Reset: SAMPLE_OPERATIONS_16.Reset },
  });
  check(
    report.passed.filter((r) => r.startsWith("1.6 ")).join("|") === R16("Reset"),
    "only the action with a fixture is passed",
  );
  check(
    skippedRules(report).includes(R16("ClearCache")) &&
      report.skipped.find((s) => s.rule === R16("ClearCache"))?.reason.includes("fixture") === true,
    "an action without a fixture is skipped, with the reason",
  );
  check(partitions(report, TOTAL), "partial fixtures still partition the rules");

  const empty = await operationsConformance(fakeDriver(), { cpId: CP, operations16: {} });
  check(!empty.passed.some((r) => r.startsWith("1.6 ")), "without any fixture no 1.6 rule passes");
  check(conformanceHolds(empty), "skipping does not fail a run (and does not pass it either)");

  const noFixtureFalse = await operationsConformance(
    fakeDriver({ behave16: { Reset: "unsupported" } }),
    {
      cpId: CP,
      operations16: {},
    },
  );
  check(
    !failedRules(noFixtureFalse).includes(R16("Reset")),
    "a false declaration is not reported on an action nobody asked",
  );
}

// 4. The commands surface -----------------------------------------------------

const AT = "2026-11-12T10:00:00.000Z";
const SCENARIO = { op: SAMPLE_OPERATIONS_16.Reset };

interface FakeCommands {
  declared?: { completion: "accepted" | "confirmed"; polling: boolean } | null;
  implemented?: boolean;
  /** The outcome per mode the scenario's `arrange` sets. */
  outcomes?: Partial<Record<string, CommandOutcome | "throw-unsupported" | "throw-error">>;
  poll?: (ref: string) => Promise<CommandOutcome | null>;
  implementPoll?: boolean;
}

function commandsDriver(options: FakeCommands = {}): {
  driver: CsmsDriver;
  fixtures: CommandsFixtures;
} {
  const declared =
    options.declared === null
      ? undefined
      : (options.declared ?? { completion: "confirmed" as const, polling: true });
  let mode = "";
  const outcomes: Record<string, CommandOutcome | "throw-unsupported" | "throw-error"> = {
    accepted: { state: "accepted", at: AT, ref: "ref-1" },
    confirmed: { state: "confirmed", at: AT, ref: "ref-1" },
    rejected: { state: "rejected", at: AT },
    unknown: { state: "unknown", at: AT, cause: "no-evidence" },
    timeout: { state: "unknown", at: AT, cause: "timeout" },
    ...options.outcomes,
  };
  const commands: CsmsCommands = {
    async submit16() {
      const outcome = outcomes[mode]!;
      if (outcome === "throw-unsupported") throw new UnsupportedOperationError("op", "legacy");
      if (outcome === "throw-error") throw new Error("boom");
      return outcome;
    },
    ...((options.implementPoll ?? declared?.polling)
      ? {
          poll:
            options.poll ??
            (async (ref) => (ref === "ref-1" ? { state: "accepted", at: AT, ref } : null)),
        }
      : {}),
  };
  const scenario = (name: string) => ({ ...SCENARIO, arrange: () => void (mode = name) });
  return {
    driver: {
      capabilities: {
        operations16: new Set(CSMS_OPERATION_16_ACTIONS),
        ...(declared ? { commands: declared } : {}),
      },
      operations16: { execute: async () => "receipt" },
      ...((options.implemented ?? declared !== undefined) ? { commands } : {}),
    },
    fixtures: {
      cpId: CP,
      scenarios: {
        accepted: scenario("accepted"),
        confirmed: scenario("confirmed"),
        rejected: scenario("rejected"),
        unknown: scenario("unknown"),
        timeout: scenario("timeout"),
      },
    },
  };
}

{
  const { driver, fixtures } = commandsDriver();
  const report = await commandsConformance(driver, fixtures);
  check(
    conformanceHolds(report) && report.skipped.length === 0 && report.passed.length > 8,
    `a correct commands driver is green and fully asked: ${JSON.stringify(report)}`,
  );
}

{
  const { driver, fixtures } = commandsDriver({ declared: null });
  const report = await commandsConformance(driver, fixtures);
  check(
    report.passed.length === 0 && report.failed.length === 0 && report.skipped.length > 0,
    "a driver without commands has everything skipped, nothing passed",
  );
  check(
    report.skipped.every((s) => s.reason.includes("no commands")),
    "the skip reason says the driver declares no commands",
  );
}

{
  const stray = commandsDriver({ declared: null, implemented: true });
  const strayReport = await commandsConformance(stray.driver, stray.fixtures);
  check(
    failedRules(strayReport).some((r) => r.includes("exactly when capabilities.commands")),
    "commands implemented without a declaration fails",
  );
  const hollow = commandsDriver({ implemented: false });
  const hollowReport = await commandsConformance(hollow.driver, hollow.fixtures);
  check(
    failedRules(hollowReport).some((r) => r.includes("exactly when capabilities.commands")),
    "commands declared without an implementation fails",
  );
}

{
  const failedOnTimeout = commandsDriver({
    outcomes: { timeout: { state: "failed", at: AT } },
  });
  const report = await commandsConformance(failedOnTimeout.driver, failedOnTimeout.fixtures);
  check(
    failedRules(report).join("|") ===
      "submit16 reports a timeout as unknown with cause timeout, never failed",
    `a timeout reported as failed is red, alone: ${failedRules(report).join(",")}`,
  );

  const wrongCause = commandsDriver({
    outcomes: { timeout: { state: "unknown", at: AT, cause: "no-evidence" } },
  });
  const wrongCauseReport = await commandsConformance(wrongCause.driver, wrongCause.fixtures);
  check(failedRules(wrongCauseReport).length === 1, "a timeout with another cause is red");

  const rejectedAsAccepted = commandsDriver({
    outcomes: { rejected: { state: "accepted", at: AT, ref: "ref-1" } },
  });
  const rejectedReport = await commandsConformance(
    rejectedAsAccepted.driver,
    rejectedAsAccepted.fixtures,
  );
  check(
    failedRules(rejectedReport).join("|") === "submit16 reports a refused command as rejected",
    "a rejection reported as accepted is red",
  );

  for (const thrown of ["throw-unsupported", "throw-error"] as const) {
    const throwing = commandsDriver({ outcomes: { rejected: thrown } });
    const throwReport = await commandsConformance(throwing.driver, throwing.fixtures);
    check(
      failedRules(throwReport).includes("submit16 returns a verdict instead of throwing"),
      `submit16 throwing (${thrown}) is red`,
    );
  }

  const malformed = commandsDriver({
    outcomes: { accepted: { state: "accepted" } as unknown as CommandOutcome },
  });
  const malformedReport = await commandsConformance(malformed.driver, malformed.fixtures);
  check(
    failedRules(malformedReport).some((r) => r.includes("six documented states")),
    "an outcome without `at` is red",
  );
}

{
  const acceptedOnly = commandsDriver({ declared: { completion: "accepted", polling: false } });
  const report = await commandsConformance(acceptedOnly.driver, acceptedOnly.fixtures);
  check(
    failedRules(report).some((r) => r.includes("completion accepted")),
    "confirmed from an accepted-completion driver is red",
  );

  const honest = commandsDriver({
    declared: { completion: "accepted", polling: false },
    outcomes: { confirmed: { state: "accepted", at: AT } },
  });
  const honestReport = await commandsConformance(honest.driver, honest.fixtures);
  check(
    conformanceHolds(honestReport) &&
      skippedRules(honestReport).includes("submit16 reports a confirmed command as confirmed") &&
      !honestReport.passed.includes("submit16 reports a confirmed command as confirmed"),
    "confirmed is skipped, not passed, for an accepted-completion driver",
  );
  check(
    skippedRules(honestReport).includes("poll of a submitted ref answers an outcome"),
    "polling rules are skipped when polling is not declared",
  );
}

{
  const missing = commandsDriver();
  const report = await commandsConformance(missing.driver, { cpId: CP, scenarios: {} });
  check(
    report.passed.every((r) => !r.startsWith("submit16 reports")) &&
      skippedRules(report).includes("submit16 reports a refused command as rejected"),
    "scenarios without a fixture are skipped, never passed",
  );
  check(
    !report.passed.includes("submit16 returns a verdict instead of throwing"),
    "nothing submitted, nothing proven about throwing",
  );
}

{
  const nullPoll = commandsDriver({ poll: async () => null });
  const nullReport = await commandsConformance(nullPoll.driver, nullPoll.fixtures);
  check(
    failedRules(nullReport).join("|") === "poll of a submitted ref answers an outcome",
    `poll answering null for a submitted ref is red: ${failedRules(nullReport).join(",")}`,
  );
  const answersStrangers = commandsDriver({
    poll: async () => ({ state: "accepted", at: AT, ref: "ref-1" }),
  });
  const strangerReport = await commandsConformance(
    answersStrangers.driver,
    answersStrangers.fixtures,
  );
  check(
    failedRules(strangerReport).join("|") === "poll of a ref nobody issued answers null",
    "poll answering a stranger ref is red",
  );
  const undeclaredPoll = commandsDriver({
    declared: { completion: "confirmed", polling: false },
    implementPoll: true,
  });
  const undeclaredReport = await commandsConformance(
    undeclaredPoll.driver,
    undeclaredPoll.fixtures,
  );
  check(
    failedRules(undeclaredReport).some((r) => r.includes("poll is implemented exactly when")),
    "poll implemented without declared polling is red",
  );
}

// 5. The samples cover the vocabulary -----------------------------------------

check(
  CSMS_OPERATION_16_ACTIONS.every((a) => SAMPLE_OPERATIONS_16[a]?.action === a),
  "SAMPLE_OPERATIONS_16 holds one operation per 1.6 action under its own name",
);

if (failures.length > 0) {
  console.error(failures.map((f) => `FAIL: ${f}`).join("\n"));
  process.exit(1);
}
console.log("conformance operations and commands suites hold.");
