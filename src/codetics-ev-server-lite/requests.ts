// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * requests.ts -- the OCPP 1.6 vocabulary as this CSMS's generic command
 * endpoint takes it, and the wait that turns "queued" into "dispatched".
 *
 * ONE ROUTE FOR EVERY OPERATION. `POST /api/v1/stations/{id}/commands`
 * accepts `{action, payload}` where `payload` IS the OCPP request body: the
 * server validates it (ocpp/OcppValidation.kt, `serverInitiated = true`),
 * stores it, and its dispatcher sends it verbatim as the CALL's payload. So
 * each arm below builds the OCPP 1.6 payload itself, with members spelled as
 * the specification spells them.
 *
 * WHAT THE VALIDATOR REFUSES THAT OCPP ALLOWS:
 *
 *  - GetConfiguration with a key list. Its `textLimits` table checks a member
 *    called `key` on EVERY action as a string of 1 to 50 characters, and in
 *    GetConfiguration.req `key` is an array -- so any key list is answered 400
 *    and never queued. Only "every key" (an empty payload) is expressible.
 *  - ReserveNow without a reservation id. `reservationId` is required, and the
 *    server has no reservation entity to allocate one from, so this driver
 *    allocates it.
 *
 * CHARGING PROFILES ARE THE CALLER'S. The server's smart-charging model has no
 * description or name to look a profile up by, and OCPP 1.6
 * SetChargingProfile carries the whole profile inline, so the profile a ref
 * names comes from `refs.chargingProfileByRef`.
 *
 * DISPATCH, NOT COMPLETION. `execute()` resolves once the command has left
 * `QUEUED`: the dispatcher runs every second and moves at most ten queued
 * commands per connected station to `SENT` as it writes the CALL. A station's
 * Rejected is a normal return. What the states mean, from
 * ocpp/OcppCommandQueue.kt:
 *
 *   SENT, SUCCEEDED      the CALL was written to the station's socket
 *   FAILED with a result the station answered with a CALLERROR -- dispatched
 *   FAILED, no result    the socket write itself threw -- never dispatched
 *   TIMED_OUT            the server's 60 s deadline passed while the command
 *                        was QUEUED or SENT. The wait returns at SENT, so a
 *                        TIMED_OUT it sees is one whose SENT it never
 *                        observed: no evidence of a CALL
 *   CANCELLED            withdrawn while QUEUED -- never sent
 *   QUEUED past our wait the station is not connected
 *
 * Those last four are {@link CsmsNotDispatchedError}: nothing shows the request
 * became an OCPP CALL, which is that class's claim exactly. So is a refusal of
 * the POST itself, since nothing was queued.
 *
 * WHAT IS NOT A NON-DISPATCH: anything that goes wrong AFTER the POST was
 * accepted, other than the states above. The command is queued server-side by
 * then, and a poll that cannot read it -- a refused read, a body that is not a
 * list, a command that never shows in the list -- knows nothing about whether
 * the dispatcher took it. The wait retries such a read until its deadline and
 * then throws a plain `Error`; claiming a non-dispatch there would file a
 * failure of our read as a fact about the CSMS's wire.
 */
import {
  assertNever,
  CsmsNotDispatchedError,
  UnsupportedOperationError,
  type ChargingProfileRef,
  type CommandOutcome,
  type CsmsOperation16,
} from "../contracts.ts";
import { preview, reason } from "../shared/http.ts";
import type { EvslApi } from "./api-client.ts";

/** OCPP 1.6 ChargingProfile, spelled as the wire spells it. */
export interface EvslChargingProfile {
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
export interface EvslRefs {
  /** The profile a ref names, or undefined when it names none. Required by
   *  every operation that carries a charging-profile ref. */
  chargingProfileByRef?(ref: ChargingProfileRef): EvslChargingProfile | undefined;
}

export interface Command {
  action: string;
  payload: Record<string, unknown>;
}

/** A row of `GET /api/v1/commands` (CommandResponse, snake_case). */
export interface CommandRow {
  id: string;
  station_id: string;
  action: string;
  state: string;
  result: unknown;
}

const POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The command row a dispatched command resolves with, as its receipt. Longer
 *  than an error's body preview on purpose: it is the whole receipt. */
function receiptOf(row: CommandRow): string {
  return JSON.stringify(row).slice(0, 500);
}

/** Drops the members that are `undefined`, so an absent optional field is
 *  omitted on the wire rather than sent as null. Insertion order is kept. */
function body(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function profileFor(ref: ChargingProfileRef, refs: EvslRefs): EvslChargingProfile {
  const profile = refs.chargingProfileByRef?.(ref);
  if (!profile) {
    // Not UnsupportedOperationError: the CSMS can express this. An unknown
    // ref means the caller's lookup does not know that name, which is an
    // environment fault, and filing it as a capability gap would file it
    // against the CSMS.
    throw new Error(
      `codetics-ev-server-lite: no provisioned charging profile for ref ${JSON.stringify(ref)} ` +
        "-- does refs.chargingProfileByRef know it?",
    );
  }
  return profile;
}

/** A ref that must be a non-negative integer id, as that number -- refused
 *  rather than sent as 0 or NaN. `what` names the id, `hint` follows the
 *  refused ref in the message. */
function integerRef(ref: string, action: string, what: string, hint = ""): number {
  if (!/^\d+$/.test(ref)) {
    throw new Error(
      `codetics-ev-server-lite: ${action} needs ${what}, got ${JSON.stringify(ref)}${hint}`,
    );
  }
  return Number(ref);
}

/** The OCPP transactionId behind a ref. The server's transaction `id` IS the
 *  OCPP transactionId it handed the station, so there is nothing to resolve --
 *  only a ref that is not one to refuse. */
function transactionId(ref: string, action: string): number {
  return integerRef(
    ref,
    action,
    "an OCPP transaction id",
    " -- the caller's transaction lookup came back empty",
  );
}

/**
 * Reservation ids this process allocates. Seeded from the clock so two
 * processes driving the same station are unlikely to reuse one, and kept under
 * 2^31 because the validator requires a non-negative int.
 */
let nextReservationId = Math.floor(Date.now() / 1000) % 1_000_000_000;

function allocateReservationId(): number {
  nextReservationId = (nextReservationId + 1) % 2_000_000_000;
  return nextReservationId;
}

/** The `{action, payload}` the command endpoint takes for one operation. */
export function toCommand(op: CsmsOperation16, refs: EvslRefs = {}): Command {
  return { action: op.action, payload: toPayload(op, refs) };
}

/** The OCPP 1.6 request body for one operation. The command's action is the
 *  operation's own, so no arm spells it a second time. */
function toPayload(op: CsmsOperation16, refs: EvslRefs): Record<string, unknown> {
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
      if (op.keys !== undefined && op.keys.length > 0) {
        throw new UnsupportedOperationError("GetConfiguration", GET_CONFIGURATION_KEYS_UNSUPPORTED);
      }
      return {};

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
      // the station's raw received line, and the server keeps the order it was
      // given. An entry with no status carries no idTagInfo at all, which in a
      // Differential update means "remove this tag".
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
      return assertNever(op, "codetics-ev-server-lite.execute");
  }
}

/** Why a GetConfiguration key list cannot be queued. */
export const GET_CONFIGURATION_KEYS_UNSUPPORTED =
  "POST /api/v1/stations/{id}/commands validates every payload's `key` member " +
  "as a string of 1-50 characters (OcppValidation.textLimits), and " +
  "GetConfiguration.req's `key` is an array, so a key list is refused with 400 " +
  "and never queued; only the every-key request is expressible";

/** POSTs one command and returns its id. A refusal of the POST throws as
 *  {@link EvslApi.request} does; an answer without an id is a plain `Error`. */
async function queue(api: EvslApi, cpId: string, command: Command): Promise<string> {
  const path = `/api/v1/stations/${encodeURIComponent(cpId)}/commands`;
  const receipt = (await api.request("POST", path, command)) as { id?: unknown } | null;
  if (typeof receipt?.id !== "string") {
    throw new Error(
      `codetics-ev-server-lite: POST ${path} answered without a command id: ${JSON.stringify(receipt)}`,
    );
  }
  return receipt.id;
}

/** One read of the command list: the row of `id`, or why none could be read.
 *  The tenant's last 100 commands, newest first: a command queued a moment ago
 *  is near the top, and one that scrolled out is reported as unseen. */
async function readRow(
  api: EvslApi,
  id: string,
): Promise<{ row?: CommandRow; readFailure?: string }> {
  try {
    const rows = await api.request("GET", "/api/v1/commands");
    if (Array.isArray(rows)) {
      const row = (rows as (CommandRow | null)[]).find((r) => r?.id === id) ?? undefined;
      return row ? { row } : {};
    }
    return {
      readFailure: `GET /api/v1/commands answered something that is not a list: ${JSON.stringify(rows).slice(0, 200)}`,
    };
  } catch (err) {
    return { readFailure: reason(err) };
  }
}

/**
 * Queues one command and waits for the dispatcher to take it. Returns the
 * command row, serialised, as the receipt.
 */
export async function dispatch(
  api: EvslApi,
  cpId: string,
  command: Command,
  timeoutMs: number,
): Promise<string> {
  const id = await queue(api, cpId, command);
  const what = `codetics-ev-server-lite: ${command.action} for ${cpId} (command ${id})`;

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // A read that fails is retried until the deadline: see the header for why
    // it is never a non-dispatch.
    const { row, readFailure } = await readRow(api, id);
    if (row) {
      switch (row.state) {
        case "SENT":
        case "SUCCEEDED":
          return receiptOf(row);
        case "FAILED":
          if (row.result !== null && row.result !== undefined) return receiptOf(row);
          throw new CsmsNotDispatchedError(
            what,
            "FAILED with no result: the server could not write the CALL to the station's socket",
          );
        case "TIMED_OUT":
          throw new CsmsNotDispatchedError(
            what,
            "TIMED_OUT with no SENT observed: nothing shows the CALL was written",
          );
        case "CANCELLED":
          throw new CsmsNotDispatchedError(what, "CANCELLED while still QUEUED");
        case "QUEUED":
          break;
        default:
          throw new Error(`${what}: unknown command state ${JSON.stringify(row.state)}`);
      }
    }
    if (Date.now() >= deadline) {
      // Giving up does not withdraw the command: the server has no way to
      // cancel one (CommandController exposes GET only), so a command
      // abandoned QUEUED stays queued until the server's own 60 s deadline
      // and may still reach the station during a later call on this cpId.
      const abandoned =
        "; it may still be queued server-side, cannot be cancelled, and may " +
        "still reach the station during a later call on this cpId";
      if (readFailure !== undefined) {
        throw new Error(
          `${what}: accepted, but its state could not be read for ${timeoutMs} ms` +
            ` -- last read: ${readFailure}${abandoned}`,
        );
      }
      if (!row) {
        throw new Error(
          `${what}: accepted, but not among the last 100 commands after ${timeoutMs} ms` +
            abandoned,
        );
      }
      throw new CsmsNotDispatchedError(
        what,
        `still QUEUED after ${timeoutMs} ms -- is the station connected?${abandoned}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Command outcomes
// ---------------------------------------------------------------------------

/** CALLRESULT statuses that are the station refusing the command. */
const REFUSING_STATUSES: readonly string[] = ["Rejected", "NotSupported"];

function now(): string {
  return new Date().toISOString();
}

/**
 * The outcome one command row stands for -- the state table of the header, as
 * values. `ref` is the command id.
 *
 *   QUEUED, SENT        accepted: queued or written, the answer is not known
 *   SUCCEEDED           confirmed, or rejected when the station's CALLRESULT
 *                       status is Rejected/NotSupported
 *   FAILED + result     failed: the station answered a CALLERROR
 *   FAILED, no result   failed: the socket write threw, nothing was sent
 *   TIMED_OUT           unknown (timeout): the server's deadline passed, and
 *                       the station may still have acted
 *   CANCELLED           rejected: withdrawn while QUEUED, never sent
 *   anything else       unknown (no-evidence)
 */
export function outcomeOfRow(row: CommandRow): CommandOutcome {
  const at = now();
  const ref = row.id;
  switch (row.state) {
    case "QUEUED":
    case "SENT":
      return { state: "accepted", at, ref };
    case "SUCCEEDED": {
      const status = (row.result as { status?: unknown } | null | undefined)?.status;
      if (typeof status === "string" && REFUSING_STATUSES.includes(status)) {
        return { state: "rejected", at, detail: `the station answered ${status}` };
      }
      return { state: "confirmed", at, ref, response: row.result ?? undefined };
    }
    case "FAILED":
      return {
        state: "failed",
        at,
        ref,
        detail:
          row.result === null || row.result === undefined
            ? "the server could not write the CALL to the station's socket"
            : preview(JSON.stringify(row.result)),
      };
    case "TIMED_OUT":
      return {
        state: "unknown",
        at,
        ref,
        cause: "timeout",
        detail: "the server's deadline passed with no answer from the station",
      };
    case "CANCELLED":
      return { state: "rejected", at, detail: "withdrawn while still QUEUED" };
    default:
      return {
        state: "unknown",
        at,
        ref,
        cause: "no-evidence",
        detail: `unknown command state ${JSON.stringify(row.state)}`,
      };
  }
}

/** The current outcome of an earlier command, `null` when the list does not
 *  show it. A read that fails is a plain `Error`: no verdict can be given. */
export async function pollCommand(api: EvslApi, ref: string): Promise<CommandOutcome | null> {
  const { row, readFailure } = await readRow(api, ref);
  if (readFailure !== undefined) {
    throw new Error(`codetics-ev-server-lite: command ${ref} could not be read: ${readFailure}`);
  }
  return row ? outcomeOfRow(row) : null;
}

/**
 * Queues one command and follows it until the station answers, the wait ends
 * or `signal` aborts, reporting the state reached as a value.
 *
 * What was never sent still throws as {@link dispatch} does, because nothing
 * happened that an outcome could describe: a refused POST, FAILED with no
 * result, CANCELLED, or TIMED_OUT with no SENT observed. What happens after the
 * CALL left is never thrown and a timeout is never `failed`: SENT at the
 * deadline is `unknown` (`timeout`). A command still QUEUED at the deadline is
 * `accepted`, since it stays queued server-side and `ref` lets a caller poll
 * it. A state that cannot be read is `unknown` (`no-evidence`), also with `ref`.
 */
export async function submitCommand(
  api: EvslApi,
  cpId: string,
  command: Command,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandOutcome> {
  signal?.throwIfAborted();
  const id = await queue(api, cpId, command);
  const what = `codetics-ev-server-lite: ${command.action} for ${cpId} (command ${id})`;
  const deadline = Date.now() + timeoutMs;
  let sawSent = false;
  let last: CommandRow | undefined;
  let readFailure: string | undefined;
  for (;;) {
    const read = await readRow(api, id);
    readFailure = read.readFailure;
    const row = read.row;
    if (row) {
      last = row;
      if (row.state === "SENT") sawSent = true;
      switch (row.state) {
        case "SUCCEEDED":
        case "FAILED":
        case "TIMED_OUT":
        case "CANCELLED":
          if (row.state === "FAILED" && (row.result === null || row.result === undefined)) {
            throw new CsmsNotDispatchedError(
              what,
              "FAILED with no result: the server could not write the CALL to the station's socket",
            );
          }
          if (row.state === "CANCELLED") {
            throw new CsmsNotDispatchedError(what, "CANCELLED while still QUEUED");
          }
          if (row.state === "TIMED_OUT" && !sawSent) {
            throw new CsmsNotDispatchedError(
              what,
              "TIMED_OUT with no SENT observed: nothing shows the CALL was written",
            );
          }
          return outcomeOfRow(row);
        case "QUEUED":
        case "SENT":
          break;
        default:
          return outcomeOfRow(row);
      }
    }
    if (signal?.aborted) {
      return {
        state: "unknown",
        at: now(),
        ref: id,
        cause: "no-evidence",
        detail: "the wait was aborted after the command was queued",
      };
    }
    if (Date.now() >= deadline) {
      if (last === undefined || readFailure !== undefined) {
        return {
          state: "unknown",
          at: now(),
          ref: id,
          cause: "no-evidence",
          detail:
            readFailure === undefined
              ? "accepted, but not among the last 100 commands"
              : `accepted, but its state could not be read: ${preview(readFailure)}`,
        };
      }
      if (last.state === "SENT") {
        return {
          state: "unknown",
          at: now(),
          ref: id,
          cause: "timeout",
          detail: `the station did not answer within ${timeoutMs} ms`,
        };
      }
      return outcomeOfRow(last);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
