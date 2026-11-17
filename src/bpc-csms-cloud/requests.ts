// Copyright 2026 Sukrit Jaidee
// SPDX-License-Identifier: Apache-2.0
/**
 * requests.ts -- the OCPP 1.6 vocabulary as the bpc-csms-cloud console takes
 * it, and what each of its answers says about the wire. Measured against
 * release 1.15.1, and read off `handle_api_command`, the `cmd_*` methods and
 * the `ops_api_fw_*` routes of `csms_web_ui_flexxfast1.py`.
 *
 * ONE COMMAND ROUTE. `POST /api/command {cp_id, command, params}` names one of
 * the console's own commands (`reset`, `unlock`, `set_profile`...) and BLOCKS
 * while python-ocpp calls the station, 30 s at most. The console builds each
 * CALL from `params` itself and fills in a default for a missing one, so the
 * driver always sends every param it means, and refuses -- as an
 * {@link UnsupportedOperationError}, before sending anything -- what the
 * console cannot put on the wire as asked:
 *
 *   RemoteStartTransaction  without a connectorId (the console then picks a
 *                           connector and names it), or with a charging profile
 *   TriggerMessage          with connectorId 0, which the console drops
 *   SetChargingProfile      any profile but the one the console builds: kind
 *                           Relative, one period starting at 0, no
 *                           transactionId, and the id it gives the purpose
 *                           (ChargePointMaxProfile 1, TxDefaultProfile 10 +
 *                           connector, TxProfile 20 + connector)
 *   GetCompositeSchedule    with a chargingRateUnit
 *   SendLocalList           an entry the console cannot send as asked: it
 *                           sends every entry as an upper-case idTag with
 *                           status Accepted and nothing else, so an entry
 *                           with another status, an expiryDate or a
 *                           parentIdTag, a removal (a Differential entry with
 *                           no status) or an idTag it would rewrite is refused.
 *                           A Full entry with no status goes out Accepted.
 *   ReserveNow              with a parentIdTag, or an expiryDate not in the
 *                           future (it takes a duration, below)
 *   GetDiagnostics          to the console's own upload address
 *                           (`/api/diagnostics/upload`), which it replaces
 *                           with a one-time address of its own
 *   UpdateFirmware          with retries or retryInterval outside 0-20 and
 *                           0-86400 s (it clamps), to anything but an http(s)
 *                           or ftp(s) location, or with a retrieveDate in the
 *                           past (it sends the current time instead)
 *
 * ONE PAIR OF DEFAULTS IS THE CONSOLE'S, NOT REFUSED. An UpdateFirmware
 * without retries or retryInterval goes out with the console's own (its
 * firmware settings, 3 and 120 s unless changed): OCPP leaves both to the
 * station when absent, the console never sends them absent, and refusing would
 * leave UpdateFirmware unusable.
 *
 * TWO DATES ARE THE CONSOLE'S. ReserveNow takes `expiry_seconds` and computes
 * `expiryDate` from its own clock, so the driver sends the whole seconds left
 * until `expiryDate`, rounded up: the date on the wire is never earlier than
 * the one asked, and later by the request's own latency. UpdateFirmware's
 * `retrieve` keeps whole seconds, so `retrieveDate` is rounded up to the next.
 *
 * UPDATE FIRMWARE IS A JOB. `POST /api/ops/fw/update` creates a firmware job
 * and, for a connected station, sends the CALL before it answers. A job still
 * `waiting` -- the station is not connected, or left the CALL unanswered -- is
 * sent again the next time the station connects, so the driver cancels it:
 * one operation is never more than one CALL.
 *
 * WHAT AN ANSWER MEANS:
 *
 *   200 {"success":true,"result":…}   the station answered, Rejected included.
 *                                     A RemoteStartTransaction whose result
 *                                     carries a `reason` was never sent (a
 *                                     booking holds the connector): a
 *                                     non-dispatch
 *   404 Charge Point not found        not connected: a non-dispatch
 *   400 Unknown command: …            UnsupportedOperationError
 *   any other 400, 401, 403, 429      refused before the CALL: a non-dispatch
 *   500 Waited Ns for response on …   python-ocpp's own timeout: the CALL left
 *                                     and was not answered. A plain Error
 *   500 'NoneType' object has no      how 1.15.1 reports a station's
 *       attribute 'status' (or        CALLERROR: python-ocpp returns None for
 *       'list_version')               it, and the console reads a field off
 *                                     it. A plain Error
 *   any other 5xx                     a failure in, or in front of, the
 *                                     console: the CALL left, or may have.
 *                                     A plain Error
 *
 * A firmware job answered 200 is `sent`, or a later firmware status, once the
 * station answered; `waiting` with nothing recorded when the station is not
 * connected (a non-dispatch) and after "no answer from the charger" when it
 * did not answer (a plain Error); `cancelled` when a newer update replaced it
 * before it was sent (a non-dispatch); `refused` when python-ocpp raised (a
 * plain Error).
 *
 * WHAT THE CONSOLE HIDES. It answers a station's CALLERROR to GetConfiguration
 * as an empty configuration, to GetDiagnostics as "No diagnostics available",
 * and to UpdateFirmware as `sent`, so those three resolve. It drops the
 * `unknownKey` of a GetConfiguration answer, and reads a key without a value
 * as "".
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
  type BpcCsmsCloudApi,
  type RawResponse,
} from "./api-client.ts";

/** OCPP 1.6 ChargingProfile, spelled as the wire spells it. */
export interface BpcCsmsCloudChargingProfile {
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
export interface BpcCsmsCloudRefs {
  /** The profile a ref names, or undefined when it names none. Required by
   *  every operation that carries a charging-profile ref. */
  chargingProfileByRef?(ref: ChargingProfileRef): BpcCsmsCloudChargingProfile | undefined;
}

/** One console request: a `/api/command` call, or a firmware job. */
export type BpcCsmsCloudRequest =
  | {
      readonly route: "command";
      readonly command: string;
      readonly params: Record<string, unknown>;
    }
  | { readonly route: "firmware"; readonly body: Record<string, unknown> };

/** Drops the members that are `undefined`: an optional OCPP field left out is
 *  a param left out, which the console sends as absent too -- except the
 *  firmware retries the header names. */
function defined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function command(name: string, params: Record<string, unknown> = {}): BpcCsmsCloudRequest {
  return { route: "command", command: name, params: defined(params) };
}

function profileFor(ref: ChargingProfileRef, refs: BpcCsmsCloudRefs): BpcCsmsCloudChargingProfile {
  const profile = refs.chargingProfileByRef?.(ref);
  if (!profile) {
    // Not UnsupportedOperationError: an unknown ref means the caller's lookup
    // does not know that name, which is an environment fault, and filing it
    // as a capability gap would file it against the CSMS.
    throw new Error(
      `bpc-csms-cloud: no provisioned charging profile for ref ${JSON.stringify(ref)} ` +
        "-- does refs.chargingProfileByRef know it?",
    );
  }
  return profile;
}

/** A ref that must be a non-negative integer id, as that number -- refused
 *  rather than sent as 0 or NaN. */
function integerRef(ref: string, action: string, what: string): number {
  if (!/^\d+$/.test(ref)) {
    throw new Error(`bpc-csms-cloud: ${action} needs ${what}, got ${JSON.stringify(ref)}`);
  }
  return Number(ref);
}

/**
 * Reservation ids this process allocates for a ReserveNow without one: the
 * console would send reservation id 1 for every such request. Seeded from the
 * clock so two processes driving the same station are unlikely to reuse one.
 */
let nextReservationId = Math.floor(Date.now() / 1000) % 1_000_000_000;

function allocateReservationId(): number {
  nextReservationId = (nextReservationId + 1) % 2_000_000_000;
  return nextReservationId;
}

/** The chargingProfileId the console gives a purpose on a connector. */
function consoleProfileId(purpose: string, connectorId: number): number {
  if (purpose === "TxDefaultProfile") return 10 + connectorId;
  if (purpose === "TxProfile") return 20 + connectorId;
  return 1;
}

/** Refuses a profile the console would not send as it is. See the header. */
function expressibleProfile(
  op: Extract<CsmsOperation16, { action: "SetChargingProfile" }>,
  profile: BpcCsmsCloudChargingProfile,
): void {
  const refuse = (why: string): never => {
    throw new UnsupportedOperationError(op.action, `bpc-csms-cloud builds the profile: ${why}`);
  };
  // An empty transaction ref is a lookup that found none: sent unscoped, which
  // is closer to what was asked than not sending it.
  if (
    (op.transaction !== undefined && op.transaction !== "") ||
    profile.transactionId !== undefined
  ) {
    refuse("it sends no transactionId");
  }
  if (profile.chargingProfileKind !== "Relative") {
    refuse(`it always sends kind Relative, not ${profile.chargingProfileKind}`);
  }
  const periods = profile.chargingSchedule.chargingSchedulePeriod;
  if (periods.length !== 1 || periods[0]?.startPeriod !== 0) {
    refuse("it sends exactly one period, starting at 0");
  }
  const id = consoleProfileId(profile.chargingProfilePurpose, op.connectorId);
  if (profile.chargingProfileId !== id) {
    refuse(
      `it numbers a ${profile.chargingProfilePurpose} on connector ${op.connectorId} ` +
        `${id}, not ${profile.chargingProfileId}`,
    );
  }
}

/** The idTags of a SendLocalList, or a refusal for an entry the console would
 *  not send as asked. See the header. */
function localListTags(op: Extract<CsmsOperation16, { action: "SendLocalList" }>): string[] {
  return (op.localAuthorizationList ?? []).map((entry) => {
    const why =
      entry.idTag !== entry.idTag.trim().toUpperCase()
        ? "it trims and upper-cases every idTag"
        : entry.expiryDate !== undefined || entry.parentIdTag !== undefined
          ? "it sends no expiryDate or parentIdTag"
          : entry.status === undefined && op.updateType === "Differential"
            ? "it cannot remove a tag: every entry it sends carries an idTagInfo"
            : entry.status !== undefined && entry.status !== "Accepted"
              ? "it sends every entry with status Accepted"
              : undefined;
    if (why !== undefined) {
      throw new UnsupportedOperationError(
        op.action,
        `bpc-csms-cloud cannot send the entry ${JSON.stringify(entry)}: ${why}`,
      );
    }
    return entry.idTag;
  });
}

/** The console's own upload address, which it swaps for a one-time one. */
const CONSOLE_UPLOAD = /^https?:\/\/[^/]+\/api\/diagnostics\/upload\/?$/;

/** What the firmware route accepts as a location. */
const FIRMWARE_LOCATION = /^(https?|ftps?):\/\/\S+$/i;

/** The console request for one operation, or a refusal for what the console
 *  cannot send as asked (see the header). */
export function toRequest(
  cpId: string,
  op: CsmsOperation16,
  refs: BpcCsmsCloudRefs = {},
): BpcCsmsCloudRequest {
  switch (op.action) {
    case "Reset":
      return command("reset", { type: op.type });

    case "UnlockConnector":
      return command("unlock", { connector_id: op.connectorId });

    case "ClearCache":
      return command("clear_cache");

    case "ChangeAvailability":
      return command("availability", { connector_id: op.connectorId, type: op.type });

    case "GetConfiguration":
      // An absent or empty list is the every-key request: no `key` member.
      return command(
        "get_config",
        op.keys !== undefined && op.keys.length > 0 ? { keys: [...op.keys] } : {},
      );

    case "ChangeConfiguration":
      return command("set_config", { key: op.key, value: op.value });

    case "RemoteStartTransaction":
      if (op.connectorId === undefined || op.connectorId < 1) {
        throw new UnsupportedOperationError(
          op.action,
          "bpc-csms-cloud always names the connector, and picks one itself when none is given",
        );
      }
      if (op.chargingProfile !== undefined) {
        throw new UnsupportedOperationError(
          op.action,
          "bpc-csms-cloud sends no charging profile with a remote start",
        );
      }
      return command("remote_start", { id_tag: op.idTag, connector_id: op.connectorId });

    case "RemoteStopTransaction":
      return command("remote_stop", {
        transaction_id: integerRef(op.transaction, op.action, "an OCPP transaction id"),
      });

    case "TriggerMessage":
      if (op.connectorId === 0) {
        throw new UnsupportedOperationError(op.action, "bpc-csms-cloud drops a connectorId of 0");
      }
      return command("trigger", { message: op.requestedMessage, connector_id: op.connectorId });

    case "SetChargingProfile": {
      const profile = profileFor(op.chargingProfile, refs);
      expressibleProfile(op, profile);
      return command("set_profile", {
        connector_id: op.connectorId,
        limit: profile.chargingSchedule.chargingSchedulePeriod[0]?.limit,
        purpose: profile.chargingProfilePurpose,
        stack_level: profile.stackLevel,
        rate_unit: profile.chargingSchedule.chargingRateUnit,
      });
    }

    case "GetCompositeSchedule":
      if (op.chargingRateUnit !== undefined) {
        throw new UnsupportedOperationError(op.action, "bpc-csms-cloud sends no chargingRateUnit");
      }
      return command("get_composite", { connector_id: op.connectorId, duration: op.duration });

    case "ClearChargingProfile":
      // Every member is optional and an omitted one is a wildcard, so an empty
      // ref must not become an absent id: that would clear everything.
      return command("clear_profile", {
        connector_id: op.connectorId,
        charging_profile_id:
          op.chargingProfile === undefined
            ? undefined
            : profileFor(op.chargingProfile, refs).chargingProfileId,
        charging_profile_purpose: op.purpose,
        stack_level: op.stackLevel,
      });

    case "UpdateFirmware": {
      if (!FIRMWARE_LOCATION.test(op.location)) {
        throw new UnsupportedOperationError(
          op.action,
          "bpc-csms-cloud sends only an http, https, ftp or ftps location",
        );
      }
      if (
        (op.retries !== undefined && (op.retries < 0 || op.retries > 20)) ||
        (op.retryInterval !== undefined && (op.retryInterval < 0 || op.retryInterval > 86_400))
      ) {
        throw new UnsupportedOperationError(
          op.action,
          "bpc-csms-cloud clamps retries to 0-20 and retryInterval to 0-86400 s",
        );
      }
      const retrieveMs = Math.ceil(op.retrieveDate.getTime() / 1000) * 1000;
      if (retrieveMs < Date.now()) {
        throw new UnsupportedOperationError(
          op.action,
          "bpc-csms-cloud sends the current time instead of a retrieveDate in the past",
        );
      }
      return {
        route: "firmware",
        body: defined({
          cps: [cpId],
          url: op.location,
          retrieve: new Date(retrieveMs).toISOString(),
          retries: op.retries,
          interval: op.retryInterval,
        }),
      };
    }

    case "GetDiagnostics":
      if (CONSOLE_UPLOAD.test(op.location)) {
        throw new UnsupportedOperationError(
          op.action,
          "bpc-csms-cloud replaces its own upload address with a one-time one",
        );
      }
      return command("get_diagnostics", {
        location: op.location,
        start_time: op.startTime?.toISOString(),
        stop_time: op.stopTime?.toISOString(),
        retries: op.retries,
        retry_interval: op.retryInterval,
      });

    case "GetLocalListVersion":
      return command("get_local_list");

    case "SendLocalList":
      return command("send_local_list", {
        version: op.listVersion,
        type: op.updateType,
        tags: localListTags(op),
      });

    case "ReserveNow": {
      if (op.parentIdTag !== undefined) {
        throw new UnsupportedOperationError(op.action, "bpc-csms-cloud sends no parentIdTag");
      }
      const seconds = Math.ceil((op.expiryDate.getTime() - Date.now()) / 1000);
      if (seconds < 1) {
        throw new UnsupportedOperationError(
          op.action,
          "bpc-csms-cloud takes a duration, so it cannot send an expiryDate that is not in the future",
        );
      }
      return command("reserve", {
        connector_id: op.connectorId,
        id_tag: op.idTag,
        reservation_id:
          op.reservation === undefined
            ? allocateReservationId()
            : integerRef(op.reservation, op.action, "an integer reservation id"),
        expiry_seconds: seconds,
      });
    }

    case "CancelReservation":
      return command("cancel_reserve", {
        reservation_id: integerRef(op.reservation, op.action, "an integer reservation id"),
      });

    default:
      return assertNever(op, "bpc-csms-cloud.execute");
  }
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** python-ocpp's message when a station leaves a CALL unanswered: it quotes
 *  the CALL frame, so the CALL left. */
const UNANSWERED = /^Waited \d+(?:\.\d+)?s for response on \[2,/;

/** What 1.15.1 answers for a station's CALLERROR: python-ocpp returns None for
 *  it, and the console reads the answer's field off that None. */
const CALLERROR = /^'NoneType' object has no attribute '(?:status|list_version)'$/;

/** The `error` member of a body, when it has one. */
function errorOf(res: RawResponse): unknown {
  return ((parseJsonOrUndefined(res.text) ?? {}) as { error?: unknown }).error;
}

/** Whether a 500 carries `pattern` as its `error`. */
function failedWith(res: RawResponse, pattern: RegExp): boolean {
  const error = errorOf(res);
  return res.status === 500 && typeof error === "string" && pattern.test(error);
}

/** Throws what an answer other than a usable 200 stands for, per the header. */
function refuse(res: RawResponse, op: CsmsOperation16, what: string): never {
  const error = errorOf(res);
  if (res.status === 400 && typeof error === "string" && error.startsWith("Unknown command")) {
    throw new UnsupportedOperationError(op.action, error);
  }
  if (res.status >= 500) {
    throw new Error(`${what} returned ${res.status}: ${preview(res.text)}`);
  }
  if (res.status >= 200 && res.status <= 299) {
    throw new Error(
      `${what} answered ${res.status}, which this driver does not know: ${preview(res.text)}`,
    );
  }
  // Every refusal before the CALL: 400, 401, 403, 404, 429, a redirect.
  throw new CsmsNotDispatchedError(what, `returned ${res.status}: ${preview(res.text)}`);
}

/** The `result` of a 200 from `/api/command`, or a throw for an answer that is
 *  not the station's (see the header). */
function commandResult(
  res: RawResponse,
  op: CsmsOperation16,
  what: string,
): Record<string, unknown> {
  if (res.status !== 200) return refuse(res, op, what);
  const answer = parseJsonOrUndefined(res.text) as { result?: unknown } | undefined;
  if (answer === undefined) {
    throw new Error(`${what} answered 200 with a body that is not JSON: ${preview(res.text)}`);
  }
  if (typeof answer.result !== "object" || answer.result === null) {
    throw new Error(`${what} answered 200 without the station's result: ${preview(res.text)}`);
  }
  const result = answer.result as Record<string, unknown>;
  if (op.action === "RemoteStartTransaction" && typeof result.reason === "string") {
    throw new CsmsNotDispatchedError(what, `the console did not send it: ${result.reason}`);
  }
  return result;
}

/** snake_case keys to camelCase, at every depth. */
function camelCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelCase);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      camelCase(inner),
    ]),
  );
}

/**
 * The station's CALLRESULT payload, from the console's `result`: for most
 * actions the result IS that payload (`{status}`), and four are rebuilt from
 * the console's own shape -- GetConfiguration without `unknownKey`, which the
 * console drops (see the header).
 */
function stationPayload(op: CsmsOperation16, result: Record<string, unknown>): unknown {
  switch (op.action) {
    case "GetConfiguration": {
      const entries = Array.isArray(result.configuration) ? result.configuration : [];
      return {
        configurationKey: entries.map((entry: unknown) => {
          const { key, readonly, value } = (entry ?? {}) as Record<string, unknown>;
          return { key, readonly, value };
        }),
      };
    }
    case "GetCompositeSchedule":
      return camelCase(result);
    case "GetLocalListVersion":
      return { listVersion: result.version };
    case "GetDiagnostics":
      return typeof result.fileName === "string" ? { fileName: result.fileName } : {};
    default:
      return result;
  }
}

/** Firmware job states that come once the station answered UpdateFirmware:
 *  `sent`, or a FirmwareStatusNotification that arrived before the answer was
 *  built. */
const FIRMWARE_SENT: readonly string[] = [
  "sent",
  "Downloading",
  "Downloaded",
  "DownloadFailed",
  "Installing",
  "Installed",
  "InstallationFailed",
];

interface FirmwareJob {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly history?: unknown;
}

type FirmwareVerdict =
  | { readonly kind: "sent"; readonly job: FirmwareJob }
  | { readonly kind: "unanswered"; readonly job: FirmwareJob }
  | { readonly kind: "not-sent"; readonly job: FirmwareJob; readonly why: string }
  | { readonly kind: "failed"; readonly job: FirmwareJob };

/**
 * What became of the firmware job a 200 answered with. A job still `waiting`
 * is cancelled first, best-effort, so the console does not send it again when
 * the station connects (see the header).
 */
async function firmwareVerdict(
  api: BpcCsmsCloudApi,
  res: RawResponse,
  op: CsmsOperation16,
  what: string,
  timeoutMs: number,
): Promise<FirmwareVerdict> {
  if (res.status !== 200) return refuse(res, op, what);
  const answer = parseJsonOrUndefined(res.text) as { jobs?: unknown } | undefined;
  const job = (Array.isArray(answer?.jobs) ? answer.jobs[0] : undefined) as FirmwareJob | undefined;
  if (job === undefined || typeof job.status !== "string") {
    throw new Error(`${what} answered 200 without a firmware job: ${preview(res.text)}`);
  }
  if (FIRMWARE_SENT.includes(job.status)) return { kind: "sent", job };
  if (job.status === "cancelled") {
    return { kind: "not-sent", job, why: "a newer update replaced it before it was sent" };
  }
  if (job.status !== "waiting") return { kind: "failed", job };
  await api.post("/api/ops/fw/cancel", { id: job.id }, timeoutMs).catch(() => undefined);
  return JSON.stringify(job.history ?? "").includes("no answer")
    ? { kind: "unanswered", job }
    : { kind: "not-sent", job, why: "the station is not connected" };
}

function jobName(job: FirmwareJob): string {
  return `firmware job ${String(job.id)}`;
}

/** What a firmware job the station did not answer stands for, thrown. */
function firmwareFailure(verdict: Exclude<FirmwareVerdict, { kind: "sent" }>, what: string): never {
  switch (verdict.kind) {
    case "not-sent":
      throw new CsmsNotDispatchedError(
        what,
        `${verdict.why}; ${jobName(verdict.job)} was cancelled`,
      );
    case "unanswered":
      throw new Error(
        `${what}: the station left UpdateFirmware unanswered; ${jobName(verdict.job)} was ` +
          "cancelled so it is not sent again",
      );
    case "failed":
      throw new Error(
        `${what}: ${jobName(verdict.job)} ended ${String(verdict.job.status)}: ` +
          preview(JSON.stringify(verdict.job)),
      );
    default:
      return assertNever(verdict, "bpc-csms-cloud.firmwareFailure");
  }
}

function describe(request: BpcCsmsCloudRequest, op: CsmsOperation16, cpId: string): string {
  return request.route === "command"
    ? `bpc-csms-cloud: ${op.action} for ${cpId} (POST /api/command ${request.command})`
    : `bpc-csms-cloud: ${op.action} for ${cpId} (POST /api/ops/fw/update)`;
}

function post(
  api: BpcCsmsCloudApi,
  cpId: string,
  request: BpcCsmsCloudRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RawResponse> {
  return request.route === "command"
    ? api.post(
        "/api/command",
        { cp_id: cpId, command: request.command, params: request.params },
        timeoutMs,
        signal,
      )
    : api.post("/api/ops/fw/update", request.body, timeoutMs, signal);
}

/**
 * Sends one operation and returns the console's answer, serialised, as the
 * receipt: the `/api/command` body, or the firmware job. Throws per the table
 * in the header.
 */
export async function dispatch(
  api: BpcCsmsCloudApi,
  cpId: string,
  op: CsmsOperation16,
  refs: BpcCsmsCloudRefs,
  timeoutMs: number,
): Promise<string> {
  const request = toRequest(cpId, op, refs);
  const what = describe(request, op, cpId);
  const res = await post(api, cpId, request, timeoutMs);
  if (request.route === "firmware") {
    const verdict = await firmwareVerdict(api, res, op, what, timeoutMs);
    if (verdict.kind === "sent") return JSON.stringify(verdict.job).slice(0, 500);
    return firmwareFailure(verdict, what);
  }
  commandResult(res, op, what);
  return res.text.slice(0, 500);
}

/** CALLRESULT statuses that are the station refusing the command. */
const REFUSING_STATUSES: readonly string[] = ["Rejected", "NotSupported"];

/**
 * Sends one operation and reports the station's answer as a value. The route
 * blocks, so there is no ref and nothing to poll.
 *
 *   200, status Rejected/NotSupported  rejected
 *   200, any other answer              confirmed, `response` the station's
 *                                      payload (see stationPayload)
 *   500 'NoneType' object has no …     failed: the station's CALLERROR
 *   500 Waited Ns for response on …    unknown (timeout): the CALL left, no answer
 *   a firmware job left unanswered     unknown (timeout)
 *   our own deadline or a caller abort unknown: the request may have left, so
 *                                      never `failed`; a caller abort is
 *                                      `no-evidence`
 *
 * Everything that is not evidence about the wire after the CALL keeps its
 * `execute` verdict and is thrown: a refusal before the CALL, a remote start
 * the console did not send, an operation it cannot express, any other 5xx, a
 * 200 that cannot be read.
 */
export async function submitOperation(
  api: BpcCsmsCloudApi,
  cpId: string,
  op: CsmsOperation16,
  refs: BpcCsmsCloudRefs,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandOutcome> {
  signal?.throwIfAborted();
  const request = toRequest(cpId, op, refs);
  const what = describe(request, op, cpId);
  let res: RawResponse;
  try {
    res = await post(api, cpId, request, timeoutMs, signal);
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
  if (failedWith(res, UNANSWERED)) {
    return { state: "unknown", at, cause: "timeout", detail: preview(String(errorOf(res))) };
  }
  if (failedWith(res, CALLERROR)) {
    return {
      state: "failed",
      at,
      detail: `the station answered a CALLERROR (${preview(String(errorOf(res)))})`,
    };
  }
  if (request.route === "firmware") {
    const verdict = await firmwareVerdict(api, res, op, what, timeoutMs);
    // UpdateFirmware.conf has no members.
    if (verdict.kind === "sent") return { state: "confirmed", at, response: {} };
    if (verdict.kind === "unanswered") {
      return {
        state: "unknown",
        at,
        cause: "timeout",
        detail: `the station left UpdateFirmware unanswered; ${jobName(verdict.job)} was cancelled`,
      };
    }
    return firmwareFailure(verdict, what);
  }
  const result = commandResult(res, op, what);
  if (typeof result.status === "string" && REFUSING_STATUSES.includes(result.status)) {
    return { state: "rejected", at, detail: `the station answered ${result.status}` };
  }
  return { state: "confirmed", at, response: stationPayload(op, result) };
}
