// `as const satisfies readonly CsmsOperation16Action[]` -- what the first of
// the two lists below used to say -- rejects a name that is NOT an action, and
// accepts one that MISSES an action. That is the same one-directional hole
// tck/standing.ts records above its own list, with the measurement: deleting a
// member type-checked clean. There the fix is to derive the type FROM the
// list, which is not available here, because CsmsOperation16Action is derived
// from the union's arms and the list is the second copy.
//
// And nothing else covers the hole, because everything that could is computed
// FROM the list. A driver declaring it whole -- `new Set(...)` -- claims less
// than it meant to; a driver filtering it loses the same name a second way;
// and check-driver's "not declared" warning is derived from it too. A missing
// name is invisible from every direction at once, including the one direction
// that exists to print it.
//
// Closed in the compiler rather than in a guard, because the compiler already
// decides the other half and a shell guard would be re-deciding from outside
// what tsc knows from inside. Three details, each load-bearing:
//   - CURRIED because TypeScript has no partial type-argument inference.
//     `everyOneOf<U, T>(list)` with `T` defaulted stops inferring and the
//     emitted declaration degrades from the tuple to `readonly U[]`.
//   - `[U] extends [T[number]]` is BRACKETED to stop the naked type parameter
//     distributing.
//   - the false branch is a BARE template literal rather than an array of one,
//     so the whole list mismatches ONCE and the diagnostic names what is
//     missing -- "Argument of type 'string[]' is not assignable to parameter
//     of type '"this list omits GetVariables"'" -- instead of repeating itself
//     per element.
//
// The flattening a reviewer reaches for first is `as const satisfies` plus a
// `type Missing = Exclude<...>` alias. It was tried: tsc reports
// "'Missing' is declared but never used" under this repo's noUnusedLocals, and
// exporting the alias to silence that publishes a `never` into the API that
// can never go red.
function everyOneOf() {
    return (list) => list;
}
/** Every action name, for capability declarations and run reporting. */
export const CSMS_OPERATION_16_ACTIONS = everyOneOf()([
    "Reset",
    "UnlockConnector",
    "ClearCache",
    "ChangeAvailability",
    "GetConfiguration",
    "ChangeConfiguration",
    "RemoteStartTransaction",
    "RemoteStopTransaction",
    "TriggerMessage",
    "SetChargingProfile",
    "GetCompositeSchedule",
    "ClearChargingProfile",
    "UpdateFirmware",
    "GetDiagnostics",
    "GetLocalListVersion",
    "SendLocalList",
    "ReserveNow",
    "CancelReservation",
]);
/** Every 2.0.1 action name. Same job as {@link CSMS_OPERATION_16_ACTIONS},
 *  and a SECOND list rather than an extension of it -- see the note on
 *  {@link CsmsOperation201}'s `Reset` arm for why the two must not merge. */
export const CSMS_OPERATION_201_ACTIONS = everyOneOf()([
    "Reset",
    "GetVariables",
    "SetVariables",
    "TriggerMessage",
    "ChangeAvailability",
    "SetChargingProfile",
    "GetCompositeSchedule",
    "GetChargingProfiles",
    "ClearChargingProfile",
    "GetInstalledCertificateIds",
    "InstallCertificate",
    "SetNetworkProfile",
]);
/**
 * One well-formed operation per action, and its job is to make the union above
 * expensive to grow in exactly one place.
 *
 * {@link CSMS_OPERATION_201_ACTIONS} is already bidirectional -- `everyOneOf`
 * makes the list and the union agree about NAMES. Agreeing about names says
 * nothing about whether anything can build one, and a name is all a driver
 * needs to declare an operation it cannot express. This is the other half: the
 * annotation is a mapped type over the action union whose value for each
 * action is THAT action's arm, so an arm added to {@link CsmsOperation201} is
 * a type error here until somebody writes a request of its shape. A compiler
 * check rather than a guard, for the reason the note above `everyOneOf` gives
 * -- the compiler already decides the other half, and a shell guard would be
 * re-deciding from outside what tsc knows from inside.
 *
 * `Extract` rather than a plain `Record<CsmsOperation201Action,
 * CsmsOperation201>`, which is the shape a reader reaches for first: that one
 * types every value as the WHOLE union, so `Reset: { action: "TriggerMessage",
 * … }` satisfies it. A table whose key and value may disagree is a table that
 * eventually does.
 *
 * WHAT IT IS FOR, and it is not scenario data. Every value is the cheapest
 * thing its arm admits, and the optional members are omitted rather than
 * filled: the consumer is a driver's mapper, which
 * `tests/capability-parity.ts` pushes each one through to ask whether the
 * driver that DECLARED an action can actually express it. A scenario
 * asserting on one of these would be asserting on a placeholder anyone is free
 * to change. The device-model address is a real 2.0.1 one so that a mapper
 * which looks a variable up does not fail for a reason this table invented.
 *
 * Exported because a third-party driver owes the same parity check, and a
 * second table written over there is a second table free to disagree with this
 * one.
 */
export const SAMPLE_OPERATION_201 = {
    Reset: { action: "Reset", type: "Immediate" },
    GetVariables: {
        action: "GetVariables",
        variables: [
            {
                component: { name: "OCPPCommCtrlr" },
                variable: { name: "HeartbeatInterval" },
            },
        ],
    },
    SetVariables: {
        action: "SetVariables",
        variables: [
            {
                component: { name: "OCPPCommCtrlr" },
                variable: { name: "HeartbeatInterval" },
                attributeValue: "60",
            },
        ],
    },
    TriggerMessage: { action: "TriggerMessage", requestedMessage: "Heartbeat" },
    // `evse` OMITTED, by the rule stated above: every value here is the cheapest
    // thing its arm admits, and `operationalStatus` is this request's only
    // required member. The omission also happens to be the sample a mapper is
    // most likely to get wrong -- a driver that sends `evse: {}` or `evse: null`
    // for an absent one has changed what the request means -- but that is not
    // what this table measures, and a scenario is where it is measured.
    ChangeAvailability: {
        action: "ChangeAvailability",
        operationalStatus: "Inoperative",
    },
    // THE CHEAPEST PROFILE THE SCHEMA ADMITS, by this table's rule: one
    // schedule, one period, every optional member omitted. `evseId: 0` is the
    // station itself, which is the only scope a profile carrying no
    // `transactionId` is unconditionally allowed at. A mapper that reshapes the
    // nested schedule -- the thing this sample exists to push through -- fails
    // here before a container starts.
    SetChargingProfile: {
        action: "SetChargingProfile",
        evseId: 0,
        chargingProfile: {
            id: 1,
            stackLevel: 0,
            chargingProfilePurpose: "TxDefaultProfile",
            chargingProfileKind: "Absolute",
            chargingSchedule: [
                {
                    id: 1,
                    chargingRateUnit: "W",
                    chargingSchedulePeriod: [{ startPeriod: 0, limit: 0 }],
                },
            ],
        },
    },
    GetCompositeSchedule: {
        action: "GetCompositeSchedule",
        evseId: 0,
        duration: 1,
    },
    // `evseId` OMITTED and the criterion EMPTY, by this table's rule: the
    // cheapest thing the arm admits. The empty object is not a shortcut for an
    // absent one -- the schema requires the member and requires nothing inside it
    // -- so this is also the sample that pushes a mapper's one plausible mistake
    // through, dropping a criterion because it has no members to send.
    GetChargingProfiles: {
        action: "GetChargingProfiles",
        requestId: 1,
        chargingProfile: {},
    },
    // BY IDENTIFIER AND NOTHING ELSE, which is the cheapest thing the arm admits
    // and also the only one of its three spellings that the pinned CSMS accepts
    // unconditionally. A sample carrying both members would be refused before
    // dispatch by the deployment this table's per-action half runs a mapper for,
    // and a sample carrying neither would be refused too -- so the rule "the
    // cheapest value the arm admits" and "a value that could actually be sent"
    // agree here, which they are not obliged to.
    ClearChargingProfile: {
        action: "ClearChargingProfile",
        chargingProfileId: 1,
    },
    // NO MEMBERS AT ALL, which is both the cheapest thing this arm admits and a
    // real request: an omitted `certificateType` asks about every installed
    // certificate. It is also the sample that pushes this arm's one plausible
    // mapper mistake through -- sending `certificateType: []` for an absent one,
    // which the schema refuses.
    GetInstalledCertificateIds: { action: "GetInstalledCertificateIds" },
    // A PEM-SHAPED PLACEHOLDER AND NOT THE SUITE'S CERTIFICATE, which is this
    // table's rule read the way its header states it: every value here is the
    // cheapest thing its arm admits, and the consumer is a driver's MAPPER rather
    // than a CSMS. `tests/capability-parity.ts` pushes this through
    // `toCitrineRequest201` and never sends it, so what it has to be is a string
    // -- and importing `tck/specs/`'s material into the contract would point the
    // driver contract at the scenarios, which is the wrong direction and the one
    // `tests/generic-core.ts` exists to keep straight. The real certificate is
    // what the scenarios send, and its own guard is what holds it well formed.
    InstallCertificate: {
        action: "InstallCertificate",
        certificateType: "CSMSRootCertificate",
        certificate: "-----BEGIN CERTIFICATE-----\nsample\n-----END CERTIFICATE-----\n",
    },
    // EVERY REQUIRED MEMBER AND NEITHER OPTIONAL ONE. Unlike most values here the
    // "cheapest" one is not small: the schema requires six members of the nested
    // profile, so a mapper that reshaped it -- the thing this sample exists to
    // push through -- fails here before a container starts. `ocppVersion` is
    // `OCPP20` because that is the only value 2.0.1's own enumeration has for
    // itself; there is no `OCPP201`.
    SetNetworkProfile: {
        action: "SetNetworkProfile",
        configurationSlot: 1,
        connectionData: {
            ocppVersion: "OCPP20",
            ocppTransport: "JSON",
            ocppCsmsUrl: "ws://localhost:8080/ocpp",
            messageTimeout: 30,
            securityProfile: 1,
            ocppInterface: "Wired0",
        },
    },
};
// ---------------------------------------------------------------------------
// Escapes
// ---------------------------------------------------------------------------
/**
 * "This CSMS's API cannot express this operation or observation AT ALL."
 *
 * Not a transport failure, not a rejection, not a timeout: a permanent
 * statement about an API surface. The runner catches it around `drive()` and
 * records NOT APPLICABLE, printing a warning that the scope table is out of
 * date -- because a driver forced to throw this at runtime is telling you its
 * own scope table missed a scenario, and the scope table is what keeps a
 * campaign from starting containers it cannot use.
 *
 * Lives in the core, not in a driver: it is part of the contract, and the
 * runner plus every driver need the SAME class -- the runner recognises it
 * with `instanceof`, so a second copy would silently degrade NOT APPLICABLE
 * into ERROR.
 */
export class UnsupportedOperationError extends Error {
    operation;
    reason;
    constructor(operation, reason) {
        super(`${operation} is not supported by this CSMS: ${reason}`);
        this.operation = operation;
        this.reason = reason;
        this.name = "UnsupportedOperationError";
    }
}
/**
 * "The request never reached the CSMS."
 *
 * The transport refused it -- a rejected form post, an unauthenticated
 * request, a connection that never opened -- so the CSMS was never asked and
 * nothing went on the wire. Distinct from every other failure a driver can
 * report, and the distinction is the point: a CSMS answering wrongly is a
 * finding about the CSMS, while an operation that was never dispatched is a
 * finding about the client, and any assertion downstream of it is measuring
 * the wrong thing.
 *
 * AN OBSERVATION COUNTS TOO. `warnOpFailed` guards two records waits alongside
 * the operations, and a read whose transport refused it leaves the scenario
 * asserting on a record nobody could look up: the same wrong measurement,
 * reached from the other side.
 *
 * WHAT IT IS NOT is a request the CSMS answered and refused. A driver that
 * cannot tell the two apart must throw a plain `Error` -- claiming a
 * non-dispatch it did not observe converts an honest finding about the CSMS
 * into a false one about the client, which is this class's own failure mode
 * run backwards.
 *
 * WHAT IT CLAIMS, EXACTLY: the driver has no evidence the request became an
 * OCPP CALL. That is weaker than "nothing was sent", and deliberately so,
 * because a TIMEOUT belongs here and is not literally a connection that never
 * opened -- bytes went out and no answer came back, so whether the charge
 * point was asked is precisely what nobody knows. Reporting that as an
 * ordinary failure would warn and carry on into assertions about a station
 * that may never have been asked, which is juherr/open-ocpp-tck#77 again; reporting it here
 * gets the verdict the uncertainty deserves. What a driver may NOT do is come
 * here from an answer it received and understood.
 *
 * A scenario that swallows this and carries on reports a handful of confident
 * FAILs about a charge point that was never asked to do anything -- which is
 * exactly what juherr/open-ocpp-tck#77 cost to diagnose, and why `warnOpFailed` in
 * `tck/op-warn.ts` lets this one class through instead of warning and
 * continuing.
 *
 * Lives in the core for the same reason {@link UnsupportedOperationError}
 * does: the recogniser and the thrower sit on opposite sides of the driver
 * boundary and must share one class, or `instanceof` quietly stops matching.
 */
export class CsmsNotDispatchedError extends Error {
    operation;
    reason;
    constructor(operation, reason) {
        super(`${operation} never reached the CSMS: ${reason}`);
        this.operation = operation;
        this.reason = reason;
        this.name = "CsmsNotDispatchedError";
    }
}
/**
 * Compile-time exhaustiveness guard for a driver's `switch (op.action)`.
 *
 * Adding an operation to {@link CsmsOperation16} becomes a type error in every
 * driver that has not handled it -- which is the entire reason the vocabulary
 * is a discriminated union rather than a string map.
 */
export function assertNever(value, context) {
    throw new UnsupportedOperationError(context, `unhandled operation ${JSON.stringify(value)} -- this driver has not been ` +
        "updated for an operation the core now defines");
}
