// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * requests.ts -- the OCPP 1.6 vocabulary as EVtivity's command routes take it,
 * and what each answer of those routes says about the wire.
 *
 * ONE ROUTE PER ACTION. `POST /v1/ocpp/commands/v16/{Action}` takes
 * `{stationId, ...payload}`, where `payload` IS the OCPP 1.6 request body: the
 * route strips `stationId`, validates the rest against the action's 1.6 schema
 * and publishes it to the OCPP process, which sends it verbatim as the CALL's
 * payload (packages/api/src/routes/ocpp-commands.ts, `commandRoute` and
 * `dispatchCommandRaw`). So each arm below builds the 1.6 payload itself, with
 * members spelled as the specification spells them.
 *
 * CHARGING PROFILES ARE THE CALLER'S. The route forwards `csChargingProfiles`
 * as the CALL's payload and records no description to look a profile up by, so
 * the profile a ref names comes from `refs.chargingProfileByRef`.
 *
 * THE ROUTE BLOCKS UNTIL THE STATION ANSWERS (35 s at most), so its status
 * carries the dispatch question and the station's answer at once. Measured at
 * v0.1.51 and read off the route's source:
 *
 *   200 accepted + response  the station answered; Rejected is an answer too
 *   202 COMMAND_QUEUED        the station is offline; the command sits in the
 *                             offline queue, and is not on the wire
 *   400 OCPP_VERSION_MISMATCH refused for the station's protocol: a capability
 *                             gap, UnsupportedOperationError
 *   400, 401, 403, 404, 429   refused before the publish (schema, auth,
 *                             permissions, unknown station, rate limit)
 *   502 COMMAND_ERROR         the OCPP process's send failed; its `error`
 *                             says how (below)
 *   504 COMMAND_TIMEOUT       no answer in time; its `error` says whose
 *   500 INTERNAL_ERROR        thrown around the wait for the station
 *
 * The first-and-refused rows are {@link CsmsNotDispatchedError}: nothing shows
 * the request became an OCPP CALL. The 500 is a plain `Error`: the CALL left,
 * or may have.
 *
 * A 502 IS SPLIT ON ITS `error`, which is the OCPP process's own message,
 * forwarded verbatim (packages/ocpp/src/server/command-listener.ts publishes
 * it, ocpp-commands.ts answers it). Two prefixes are only ever written once the
 * station answered (message-correlator.ts): `CALLERROR <code>: …`, its
 * CALLERROR, and `Invalid CALLRESULT for …`, a CALLRESULT that failed the
 * response schema. Those are plain `Error`s -- the station was asked, and
 * answered. Every other 502 is a send that failed: `Timeout waiting to send …`
 * (CommandQueueTimeoutError, the CALL waited behind an unanswered one and was
 * dropped), `Connection closed` (a queued CALL dropped, or a sent one whose
 * socket closed -- nobody can tell which), `Station offline, command not
 * queued`, a payload the 1.6 translation refused. None of them shows the
 * station was asked, so each is a {@link CsmsNotDispatchedError}, which per
 * the contract claims exactly that and no more.
 *
 * A 504 IS SPLIT THE SAME WAY. `Timeout waiting for response to <Action>
 * (<uniqueId>)` is CommandTimeoutError: the CALL left with that id and the
 * station did not answer it -- a plain `Error`, the CSMS did its part. `No
 * response within 35s` is the route's own fallback when the OCPP process
 * published no result at all (ocpp-commands.ts), which says nothing about
 * whether a CALL left: the contract files a timeout of that kind under
 * {@link CsmsNotDispatchedError}, and so does api-client.ts for a request our
 * own timeout aborted.
 *
 * THE OFFLINE QUEUE. A 202's command is replayed the next time that cp id
 * connects, unless the server's `ocpp.offlineCommandTtlHours` setting is 0.
 */
import {
  assertNever,
  CsmsNotDispatchedError,
  UnsupportedOperationError,
  type ChargingProfileRef,
  type CommandOutcome,
  type CsmsOperation16,
} from "../contracts.ts";
import { preview } from "../shared/http.ts";
import {
  CommandWaitInterruptedError,
  parseJsonOrUndefined,
  type EvtivityApi,
  type RawResponse,
} from "./api-client.ts";

/** OCPP 1.6 ChargingProfile, spelled as the wire spells it. */
export interface EvtivityChargingProfile {
  chargingProfileId: number;
  /** Only meaningful for a TxProfile, and absent otherwise. */
  transactionId?: number;
  stackLevel: number;
  chargingProfilePurpose: "ChargePointMaxProfile" | "TxDefaultProfile" | "TxProfile";
  chargingProfileKind: "Absolute" | "Recurring" | "Relative";
  chargingSchedule: {
    chargingRateUnit: "A" | "W";
    chargingSchedulePeriod: { startPeriod: number; limit: number }[];
  };
}

/** Lookups that translate the opaque handles of {@link CsmsOperation16}. */
export interface EvtivityRefs {
  /** The profile a ref names, or undefined when it names none. Required by
   *  every operation that carries a charging-profile ref. */
  chargingProfileByRef?(ref: ChargingProfileRef): EvtivityChargingProfile | undefined;
}

/** Drops the members that are `undefined`, so an absent optional field is
 *  omitted on the wire rather than sent as null. Insertion order is kept. */
function body(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function profileFor(ref: ChargingProfileRef, refs: EvtivityRefs): EvtivityChargingProfile {
  const profile = refs.chargingProfileByRef?.(ref);
  if (!profile) {
    // Not UnsupportedOperationError: the CSMS can express this. An unknown
    // ref means the caller's lookup does not know that name, which is an
    // environment fault, and filing it as a capability gap would file it
    // against the CSMS.
    throw new Error(
      `evtivity: no provisioned charging profile for ref ${JSON.stringify(ref)} ` +
        "-- does refs.chargingProfileByRef know it?",
    );
  }
  return profile;
}

/** A ref that must be a non-negative integer id, as that number -- refused
 *  rather than sent as 0 or NaN. */
function integerRef(ref: string, action: string, what: string, hint = ""): number {
  if (!/^\d+$/.test(ref)) {
    throw new Error(`evtivity: ${action} needs ${what}, got ${JSON.stringify(ref)}${hint}`);
  }
  return Number(ref);
}

/** The OCPP transactionId behind a ref: the ref is the OCPP id itself, so
 *  there is nothing to resolve -- only a ref that is not one to refuse. */
function transactionId(ref: string, action: string): number {
  return integerRef(
    ref,
    action,
    "an OCPP transaction id",
    " -- the caller's transaction lookup came back empty",
  );
}

/**
 * Reservation ids this process allocates for a ReserveNow without one: the
 * raw route requires `reservationId` and allocates none. Seeded from the clock
 * so two processes driving the same station are unlikely to reuse one.
 */
let nextReservationId = Math.floor(Date.now() / 1000) % 1_000_000_000;

function allocateReservationId(): number {
  nextReservationId = (nextReservationId + 1) % 2_000_000_000;
  return nextReservationId;
}

/** The OCPP 1.6 request body for one operation. The route names the action,
 *  so no arm spells it a second time. */
export function toPayload(op: CsmsOperation16, refs: EvtivityRefs = {}): Record<string, unknown> {
  switch (op.action) {
    case "Reset":
      return { type: op.type };

    case "UnlockConnector":
      return { connectorId: op.connectorId };

    case "ClearCache":
      return {};

    case "ChangeAvailability":
      return { connectorId: op.connectorId, type: op.type };

    case "GetConfiguration":
      // An absent or empty list is the every-key request, sent as `{}`.
      return op.keys !== undefined && op.keys.length > 0 ? { key: [...op.keys] } : {};

    case "ChangeConfiguration":
      return { key: op.key, value: op.value };

    case "RemoteStartTransaction":
      // `undefined` starts without a profile; `""` is a lookup that found none,
      // which profileFor() refuses rather than quietly sending no profile.
      return body({
        connectorId: op.connectorId,
        idTag: op.idTag,
        chargingProfile:
          op.chargingProfile === undefined ? undefined : profileFor(op.chargingProfile, refs),
      });

    case "RemoteStopTransaction":
      return { transactionId: transactionId(op.transaction, op.action) };

    case "TriggerMessage":
      return body({ requestedMessage: op.requestedMessage, connectorId: op.connectorId });

    case "SetChargingProfile": {
      const profile = profileFor(op.chargingProfile, refs);
      // A TxProfile is scoped by carrying the transactionId INSIDE the
      // profile. An empty ref sends it unscoped, which is closer to what was
      // asked than not sending it.
      const scoped =
        op.transaction === undefined || op.transaction === ""
          ? profile
          : { ...profile, transactionId: transactionId(op.transaction, op.action) };
      return { connectorId: op.connectorId, csChargingProfiles: scoped };
    }

    case "GetCompositeSchedule":
      return body({
        connectorId: op.connectorId,
        duration: op.duration,
        chargingRateUnit: op.chargingRateUnit,
      });

    case "ClearChargingProfile":
      // Every member is optional and an omitted one is a wildcard, so an empty
      // ref must not become an absent id: that would clear everything.
      return body({
        id:
          op.chargingProfile === undefined
            ? undefined
            : profileFor(op.chargingProfile, refs).chargingProfileId,
        connectorId: op.connectorId,
        chargingProfilePurpose: op.purpose,
        stackLevel: op.stackLevel,
      });

    case "UpdateFirmware":
      return body({
        location: op.location,
        retrieveDate: op.retrieveDate.toISOString(),
        retries: op.retries,
        retryInterval: op.retryInterval,
      });

    case "GetDiagnostics":
      return body({
        location: op.location,
        retries: op.retries,
        retryInterval: op.retryInterval,
        startTime: op.startTime?.toISOString(),
        stopTime: op.stopTime?.toISOString(),
      });

    case "GetLocalListVersion":
      return {};

    case "SendLocalList":
      // KEY ORDER IS DELIBERATE: open-ocpp-tck's TC_043.5 asserts
      // /"listVersion":2,"localAuthorizationList":\[\{"idTag":"CERT-TAG-2"/ on
      // the station's raw received line. An entry with no status carries no
      // idTagInfo at all, which in a Differential update means "remove this
      // tag".
      return body({
        listVersion: op.listVersion,
        localAuthorizationList: (op.localAuthorizationList ?? []).map((entry) =>
          body({
            idTag: entry.idTag,
            idTagInfo:
              entry.status === undefined
                ? undefined
                : body({
                    status: entry.status,
                    expiryDate: entry.expiryDate?.toISOString(),
                    parentIdTag: entry.parentIdTag,
                  }),
          }),
        ),
        updateType: op.updateType,
      });

    case "ReserveNow":
      return body({
        connectorId: op.connectorId,
        expiryDate: op.expiryDate.toISOString(),
        idTag: op.idTag,
        parentIdTag: op.parentIdTag,
        reservationId:
          op.reservation === undefined
            ? allocateReservationId()
            : integerRef(op.reservation, op.action, "an integer reservation id"),
      });

    case "CancelReservation":
      return { reservationId: integerRef(op.reservation, op.action, "an integer reservation id") };

    default:
      return assertNever(op, "evtivity.execute");
  }
}

/** The members of an error body this driver quotes. */
interface ErrorBody {
  code?: unknown;
  error?: unknown;
}

/** The statuses the dispatch path itself answers with once it has published
 *  the command, or may have, and whose body says nothing more. See the
 *  header. */
const SENT_STATUSES: readonly number[] = [500];

/**
 * Per status, the prefixes of `error` that the OCPP process only writes once
 * the CALL was on the wire and the station answered it
 * (packages/ocpp/src/server/message-correlator.ts). Every other `error` of that
 * status is a failure to send, or one nobody can place either side of the
 * wire. See the header.
 */
const WIRE_EVIDENCE: Readonly<Record<number, readonly string[]>> = {
  502: ["CALLERROR ", "Invalid CALLRESULT "],
  504: ["Timeout waiting for response to "],
};

/** Whether a failed command's `error` shows the CALL reached the station. */
function reachedStation(status: number, error: unknown): boolean {
  const prefixes = WIRE_EVIDENCE[status] ?? [];
  return typeof error === "string" && prefixes.some((p) => error.startsWith(p));
}

/** The station's `response` object of a 200, or a plain `Error` when the
 *  route answered 200 without one. */
function stationResponse(res: RawResponse, what: string): Record<string, unknown> {
  const answer = parseJsonOrUndefined(res.text) as { response?: unknown } | undefined;
  if (answer === undefined) {
    throw new Error(`${what} answered 200 with a body that is not JSON: ${preview(res.text)}`);
  }
  if (typeof answer.response !== "object" || answer.response === null) {
    throw new Error(`${what} answered 200 without the station's response: ${preview(res.text)}`);
  }
  return answer.response as Record<string, unknown>;
}

/** Throws what an answer other than a 200 stands for, per the header. */
function refuse(res: RawResponse, op: CsmsOperation16, what: string): never {
  const parsed = parseJsonOrUndefined(res.text);
  const err = (parsed ?? {}) as ErrorBody;
  if (res.status === 400 && err.code === "OCPP_VERSION_MISMATCH") {
    throw new UnsupportedOperationError(
      op.action,
      typeof err.error === "string" ? err.error : preview(res.text),
    );
  }
  if (res.status in WIRE_EVIDENCE) {
    if (reachedStation(res.status, err.error)) {
      throw new Error(`${what} returned ${res.status}: ${preview(res.text)}`);
    }
    throw new CsmsNotDispatchedError(what, `returned ${res.status}: ${preview(res.text)}`);
  }
  if (SENT_STATUSES.includes(res.status)) {
    throw new Error(`${what} returned ${res.status}: ${preview(res.text)}`);
  }
  if (res.status >= 200 && res.status <= 299 && res.status !== 202) {
    throw new Error(
      `${what} answered ${res.status}, which this driver does not know: ${preview(res.text)}`,
    );
  }
  // 202 and every refusal before the publish.
  throw new CsmsNotDispatchedError(what, `returned ${res.status}: ${preview(res.text)}`);
}

/**
 * Sends one operation and returns the route's answer, serialised, as the
 * receipt. Throws per the table in the header.
 */
export async function dispatch(
  api: EvtivityApi,
  cpId: string,
  op: CsmsOperation16,
  refs: EvtivityRefs,
  timeoutMs: number,
): Promise<string> {
  const path = `/v1/ocpp/commands/v16/${op.action}`;
  const what = `evtivity: ${op.action} for ${cpId} (POST ${path})`;
  const res = await api.post(path, { stationId: cpId, ...toPayload(op, refs) }, timeoutMs);
  if (res.status === 200) {
    stationResponse(res, what);
    return res.text.slice(0, 500);
  }
  return refuse(res, op, what);
}

/** CALLRESULT statuses that are the station refusing the command. */
const REFUSING_STATUSES: readonly string[] = ["Rejected", "NotSupported"];

/**
 * Sends one operation and reports the station's answer as a value. The route
 * blocks, so there is no ref and nothing to poll.
 *
 *   200, status Rejected/NotSupported  rejected
 *   200, any other answer              confirmed, `response` the station's payload
 *   502 CALLERROR / Invalid CALLRESULT failed: the station answered with an error
 *   504 Timeout waiting for response   unknown (timeout): the CALL left, no answer
 *   our own deadline or a caller abort unknown: the request may have left, so
 *                                      never `failed`; a caller abort is
 *                                      `no-evidence`
 *
 * Everything that is not evidence about the wire after the CALL keeps its
 * `execute` verdict and is thrown: a refusal before the publish, a failed
 * send, a version mismatch, a 500, a 200 that cannot be read.
 */
export async function submitOperation(
  api: EvtivityApi,
  cpId: string,
  op: CsmsOperation16,
  refs: EvtivityRefs,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandOutcome> {
  signal?.throwIfAborted();
  const path = `/v1/ocpp/commands/v16/${op.action}`;
  const what = `evtivity: ${op.action} for ${cpId} (POST ${path})`;
  const payload = { stationId: cpId, ...toPayload(op, refs) };
  let res: RawResponse;
  try {
    res = await api.post(path, payload, timeoutMs, signal);
  } catch (err) {
    if (err instanceof CommandWaitInterruptedError) {
      return {
        state: "unknown",
        at: new Date().toISOString(),
        cause: err.timedOut ? "timeout" : "no-evidence",
        detail: preview(err.reason),
      };
    }
    throw err;
  }
  const at = new Date().toISOString();
  if (res.status === 200) {
    const response = stationResponse(res, what);
    if (typeof response.status === "string" && REFUSING_STATUSES.includes(response.status)) {
      return { state: "rejected", at, detail: `the station answered ${response.status}` };
    }
    return { state: "confirmed", at, response };
  }
  const err = (parseJsonOrUndefined(res.text) ?? {}) as ErrorBody;
  if (res.status in WIRE_EVIDENCE && reachedStation(res.status, err.error)) {
    const detail = typeof err.error === "string" ? preview(err.error) : preview(res.text);
    return res.status === 504
      ? { state: "unknown", at, cause: "timeout", detail }
      : { state: "failed", at, detail };
  }
  return refuse(res, op, what);
}
