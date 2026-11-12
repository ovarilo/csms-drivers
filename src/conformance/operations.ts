// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * operations.ts -- does `execute` agree with what the driver declares?
 *
 * PROPERTY: for every OCPP 1.6 and 2.0.1 action, the driver's behaviour matches
 * `capabilities`:
 *  - a DECLARED action is never refused with {@link UnsupportedOperationError}
 *    when a caller-supplied fixture operation is executed. Any other outcome
 *    (a receipt, a {@link CsmsNotDispatchedError}, a plain `Error` from a CSMS
 *    that answered no) shows the driver tried to express it, which is all the
 *    declaration claims;
 *  - an action NOT declared throws {@link UnsupportedOperationError}, and
 *    nothing else: resolving means a working but undeclared operation (the
 *    declaration under-claims), a `CsmsNotDispatchedError` or plain `Error`
 *    means the driver tried and failed (the declaration is hiding it, or the
 *    gap is reported with the wrong class);
 *  - `operations201` is present exactly when `capabilities.operations201` is.
 *
 * A rule whose action has no fixture is skipped with a reason, never passed:
 * not asking is not conforming. The suite calls `execute` on the real driver,
 * so the caller points it at a fake transport (or a disposable CSMS).
 */
import {
  CSMS_OPERATION_16_ACTIONS,
  CSMS_OPERATION_201_ACTIONS,
  CsmsNotDispatchedError,
  UnsupportedOperationError,
  SAMPLE_OPERATION_201,
  type CsmsOperation16,
  type CsmsOperation16Action,
  type CsmsOperation201,
  type CsmsOperation201Action,
} from "../contracts.ts";
import type { CsmsDriver } from "../models.ts";
import { createRecorder, type ConformanceReport } from "./report.ts";

/**
 * One well-formed OCPP 1.6 operation per action, the cheapest each arm admits.
 * Placeholders for a conformance run, not scenario data: a caller whose CSMS
 * needs a real value (an id tag it knows, a transaction) overrides the action
 * in {@link OperationsFixtures}.
 */
export const SAMPLE_OPERATIONS_16: {
  readonly [A in CsmsOperation16Action]: Extract<CsmsOperation16, { action: A }>;
} = {
  Reset: { action: "Reset", type: "Soft" },
  UnlockConnector: { action: "UnlockConnector", connectorId: 1 },
  ClearCache: { action: "ClearCache" },
  ChangeAvailability: { action: "ChangeAvailability", connectorId: 1, type: "Operative" },
  GetConfiguration: { action: "GetConfiguration" },
  ChangeConfiguration: { action: "ChangeConfiguration", key: "HeartbeatInterval", value: "60" },
  RemoteStartTransaction: { action: "RemoteStartTransaction", idTag: "CONFORMANCE" },
  RemoteStopTransaction: { action: "RemoteStopTransaction", transaction: "1" },
  TriggerMessage: { action: "TriggerMessage", requestedMessage: "Heartbeat" },
  SetChargingProfile: { action: "SetChargingProfile", connectorId: 1, chargingProfile: "1" },
  GetCompositeSchedule: { action: "GetCompositeSchedule", connectorId: 1, duration: 3600 },
  ClearChargingProfile: { action: "ClearChargingProfile" },
  UpdateFirmware: {
    action: "UpdateFirmware",
    location: "http://firmware.test/firmware.bin",
    retrieveDate: new Date("2030-01-01T00:00:00.000Z"),
  },
  GetDiagnostics: { action: "GetDiagnostics", location: "ftp://diagnostics.test/upload" },
  GetLocalListVersion: { action: "GetLocalListVersion" },
  SendLocalList: { action: "SendLocalList", listVersion: 1, updateType: "Full" },
  ReserveNow: {
    action: "ReserveNow",
    connectorId: 1,
    idTag: "CONFORMANCE",
    expiryDate: new Date("2030-01-01T00:00:00.000Z"),
  },
  CancelReservation: { action: "CancelReservation", reservation: "1" },
};

/** What {@link operationsConformance} executes. */
export interface OperationsFixtures {
  /** The charge point the operations are addressed to. */
  readonly cpId: string;
  /** Per-action 1.6 operations, merged over {@link SAMPLE_OPERATIONS_16}: an
   *  action left out keeps its default; one mapped to `undefined` has no
   *  fixture and its rule is skipped. */
  readonly operations16?: {
    readonly [A in CsmsOperation16Action]?: Extract<CsmsOperation16, { action: A }>;
  };
  /** Per-action 2.0.1 operations, merged over `SAMPLE_OPERATION_201` like
   *  `operations16`. */
  readonly operations201?: {
    readonly [A in CsmsOperation201Action]?: Extract<CsmsOperation201, { action: A }>;
  };
}

const PRESENCE_RULE =
  "operations201 is present exactly when capabilities.operations201 is declared";
const rule16 = (action: string): string => `1.6 ${action}: execute agrees with the declaration`;
const rule201 = (action: string): string => `2.0.1 ${action}: execute agrees with the declaration`;

/** What `execute` did, with the error classes told apart. */
type Attempt =
  | { readonly kind: "resolved" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "not-dispatched"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

async function attempt(run: () => Promise<unknown>): Promise<Attempt> {
  try {
    await run();
    return { kind: "resolved" };
  } catch (error) {
    if (error instanceof UnsupportedOperationError) return { kind: "unsupported" };
    const message = error instanceof Error ? error.message : String(error);
    return error instanceof CsmsNotDispatchedError
      ? { kind: "not-dispatched", message }
      : { kind: "error", message };
  }
}

/** The verdict of one action: `undefined` when it agrees, else why not. */
function disagreement(declared: boolean, result: Attempt): string | undefined {
  if (declared) {
    return result.kind === "unsupported"
      ? "declared in capabilities, but execute throws UnsupportedOperationError"
      : undefined;
  }
  switch (result.kind) {
    case "unsupported":
      return undefined;
    case "resolved":
      return "not declared in capabilities, but execute works";
    case "not-dispatched":
      return `not declared in capabilities, and execute throws CsmsNotDispatchedError (${result.message}) instead of UnsupportedOperationError`;
    case "error":
      return `not declared in capabilities, and execute throws a plain Error (${result.message}) instead of UnsupportedOperationError`;
  }
}

/** Asks every 1.6 and 2.0.1 action of `driver.execute`; see the file header. */
export async function operationsConformance(
  driver: CsmsDriver,
  fixtures: OperationsFixtures,
): Promise<ConformanceReport> {
  const rules = [
    ...CSMS_OPERATION_16_ACTIONS.map(rule16),
    PRESENCE_RULE,
    ...CSMS_OPERATION_201_ACTIONS.map(rule201),
  ];
  const recorder = createRecorder(rules);
  const { cpId } = fixtures;

  const samples16: Partial<Record<CsmsOperation16Action, CsmsOperation16>> = {
    ...SAMPLE_OPERATIONS_16,
    ...fixtures.operations16,
  };
  for (const action of CSMS_OPERATION_16_ACTIONS) {
    const op = samples16[action];
    if (op === undefined) {
      recorder.skip(rule16(action), "no fixture operation for this action");
      continue;
    }
    const declared = driver.capabilities.operations16.has(action);
    const problem = disagreement(
      declared,
      await attempt(() => driver.operations16.execute(cpId, op)),
    );
    recorder.expect(problem === undefined, rule16(action), problem);
  }

  const declared201 = driver.capabilities.operations201;
  recorder.expect(
    (declared201 !== undefined) === (driver.operations201 !== undefined),
    PRESENCE_RULE,
    declared201 === undefined
      ? "operations201 is implemented but capabilities.operations201 is not declared"
      : "capabilities.operations201 is declared but operations201 is not implemented",
  );

  const samples201: Partial<Record<CsmsOperation201Action, CsmsOperation201>> = {
    ...SAMPLE_OPERATION_201,
    ...fixtures.operations201,
  };
  const operations201 = driver.operations201;
  if (operations201 === undefined && declared201 === undefined) {
    recorder.skip(CSMS_OPERATION_201_ACTIONS.map(rule201), "the driver does not speak OCPP 2.0.1");
  } else {
    for (const action of CSMS_OPERATION_201_ACTIONS) {
      const op = samples201[action];
      if (op === undefined) {
        recorder.skip(rule201(action), "no fixture operation for this action");
        continue;
      }
      const declared = declared201?.has(action) ?? false;
      if (operations201 === undefined) {
        // Nothing to execute: a declared action is a violation, an undeclared
        // one was never asked, so it is skipped, not passed.
        if (declared) {
          recorder.expect(
            false,
            rule201(action),
            "declared in capabilities, but the driver implements no operations201",
          );
        } else {
          recorder.skip(rule201(action), "the driver implements no operations201");
        }
        continue;
      }
      const problem = disagreement(declared, await attempt(() => operations201.execute(cpId, op)));
      recorder.expect(problem === undefined, rule201(action), problem);
    }
  }

  return recorder.report("the suite did not ask this rule");
}
