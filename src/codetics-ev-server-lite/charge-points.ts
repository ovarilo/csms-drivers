// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * charge-points.ts -- charge-point administration over the ev-server-lite
 * admin REST API (`/api/v1/stations`), behind the CSMS-neutral
 * `CsmsChargePointAdmin` surface.
 *
 * WHAT THE SERVER DOES, AND SO WHAT THE DECLARATION SAYS
 * (codetics-software/ev-server-lite@0a9b1cc5, as juherr/csms-drivers#16 read it):
 *
 *  - `POST /stations` registers a station on profile 1 and GENERATES its
 *    password, answered once as `{id, secret}`; `POST /stations/{id}/secret`
 *    rotates it the same way. A caller can never choose one, so the driver
 *    declares `basicAuthPassword: "generated"` and refuses a supplied one.
 *  - BootNotification is always `Accepted`. The only lever, `enabled: false`,
 *    makes the server answer every call with a SecurityError, which is not
 *    OCPP's `Rejected`; the declaration is `registrations: {Accepted}` and the
 *    driver leaves `enabled` as it found it.
 *  - `name` is required and non-blank: the CSMS-neutral `description`, declared
 *    `"required"`.
 *  - Profiles 0 and 3 depend on the deployment (`OCPP_ALLOW_UNAUTHENTICATED`,
 *    a configured client CA), which `GET /stations/security/capabilities`
 *    reports but which a declaration must state WITHOUT a client, so they come
 *    from the driver's options. Profile 2 is not offered by the server and is
 *    never declared.
 *  - `PUT /stations/{id}` REPLACES the whole record, so `update` reads the
 *    record, changes the member it was asked to change and writes the whole of
 *    it back. That is read-modify-write and not atomic: a change made to the
 *    same station in between is lost.
 *  - `PUT /stations/{id}/security` applies a profile server-side only with
 *    `sendToStation: false` (otherwise the server wants a connected station).
 *    A station is created on profile 1, so a create on profile 0 or 3 is a
 *    create followed by that call. Anything that fails after the POST (that
 *    call, or an answer without a secret) deletes the half-made station again;
 *    if the DELETE fails too, the original error says the station could not be
 *    removed. Moving to profile 1 sets the profile and then rotates the
 *    secret, because the CSMS-neutral contract returns the secret of every
 *    write that sets profile 1; if the rotation fails, the previous profile
 *    is put back (best effort) and the rotation's error is rethrown.
 *  - `DELETE` is a soft delete, answered 404 for a missing station (resolved:
 *    absent afterwards is what was asked) and 409 during an active session,
 *    which is a plain `Error`: the station is there and the CSMS refuses, an
 *    environment condition rather than a capability gap.
 *
 * THE RECORD'S MEMBER NAMES (`name`, `enabled`, `securityProfile`) are this
 * driver's reading of the server; they are used in this file only.
 */
import {
  ChargePointAlreadyExistsError,
  ChargePointNotFoundError,
  suppliedBasicAuthPassword,
  type ChargePointDefinition,
  type ChargePointDetails,
  type ChargePointProvisioned,
  type ChargePointSecurity,
  type ChargePointSecurityProfile,
  type ChargePointUpdate,
  type CsmsChargePointAdmin,
  type CsmsChargePointCapabilities,
} from "../charge-points.ts";
import { UnsupportedOperationError } from "../contracts.ts";
import type { EvslApi } from "./api-client.ts";

/** What the server's deployment offers, which a declaration cannot ask it. */
export interface EvslChargePointOptions {
  /** The server runs with `OCPP_ALLOW_UNAUTHENTICATED`: profile 0 is offered. */
  readonly allowUnauthenticated?: boolean;
  /** The server has a client CA configured: profile 3 is offered. */
  readonly clientCaConfigured?: boolean;
}

/** The charge-point declaration for a deployment; see the header. */
export function evslChargePointCapabilities(
  options: EvslChargePointOptions = {},
): CsmsChargePointCapabilities {
  const profiles = new Set<ChargePointSecurityProfile>([1]);
  if (options.allowUnauthenticated === true) profiles.add(0);
  if (options.clientCaConfigured === true) profiles.add(3);
  return {
    securityProfiles: profiles,
    registrations: new Set(["Accepted"]),
    basicAuthPassword: "generated",
    description: "required",
  };
}

const STATIONS = "/api/v1/stations";

function stationPath(cpId: string, suffix = ""): string {
  return `${STATIONS}/${encodeURIComponent(cpId)}${suffix}`;
}

function refuse(method: string, reason: string): never {
  throw new UnsupportedOperationError(`chargePoints.${method}`, reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProfile(value: unknown): value is ChargePointSecurityProfile {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function requireSecret(body: unknown, what: string): string {
  const secret = isRecord(body) ? body.secret : undefined;
  if (typeof secret !== "string" || secret === "") {
    throw new Error(`codetics-ev-server-lite: ${what} answered without a secret`);
  }
  return secret;
}

export function createEvslChargePoints(
  api: EvslApi,
  options: EvslChargePointOptions = {},
): CsmsChargePointAdmin {
  const profiles = evslChargePointCapabilities(options).securityProfiles;

  /** Throws before anything is sent, so a refused call changes nothing. */
  function checkSecurity(method: string, security: ChargePointSecurity): void {
    if (!profiles.has(security.profile)) {
      refuse(method, `security profile ${security.profile} is not offered by this server`);
    }
    if (suppliedBasicAuthPassword(security) !== undefined) {
      refuse(method, "the server generates the Basic Auth password; none can be supplied");
    }
  }

  function checkName(method: string, name: string | null | undefined): string {
    if (typeof name !== "string" || name.trim() === "") {
      refuse(method, "the server requires a non-blank name, given as the description");
    }
    return name;
  }

  function checkRegistration(method: string, registration: string | undefined): void {
    if (registration !== undefined && registration !== "Accepted") {
      refuse(method, `registration ${registration} is not offered: the server always accepts`);
    }
  }

  async function readRecord(cpId: string): Promise<Record<string, unknown> | null> {
    const { status, body } = await api.call("GET", stationPath(cpId), undefined, [404]);
    if (status === 404) return null;
    if (!isRecord(body)) {
      throw new Error(`codetics-ev-server-lite: GET ${stationPath(cpId)} answered no station`);
    }
    return body;
  }

  async function setProfile(cpId: string, profile: ChargePointSecurityProfile): Promise<void> {
    await api.call("PUT", stationPath(cpId, "/security"), {
      securityProfile: profile,
      sendToStation: false,
    });
  }

  async function rotateSecret(cpId: string): Promise<string> {
    const path = stationPath(cpId, "/secret");
    return requireSecret((await api.call("POST", path)).body, `POST ${path}`);
  }

  return {
    async create(definition: ChargePointDefinition): Promise<ChargePointProvisioned | undefined> {
      checkRegistration("create", definition.registration);
      const security = definition.security ?? { profile: 0 };
      checkSecurity("create", security);
      const name = checkName("create", definition.description);

      const { status, body } = await api.call("POST", STATIONS, { id: definition.id, name }, [409]);
      if (status === 409) throw new ChargePointAlreadyExistsError(definition.id);
      // From here the station exists: any failure deletes it again.
      try {
        // The server starts every station on profile 1 with a secret.
        const secret = requireSecret(body, `POST ${STATIONS}`);
        if (security.profile === 1) return { generatedBasicAuthPassword: secret };
        await setProfile(definition.id, security.profile);
        return undefined;
      } catch (error) {
        try {
          await api.call("DELETE", stationPath(definition.id), undefined, [404]);
        } catch (rollback) {
          // Keep the original error's class; the reason is the DELETE's own
          // message, which carries no secret.
          if (error instanceof Error) {
            const reason = rollback instanceof Error ? rollback.message : String(rollback);
            error.message += ` and station ${definition.id} could not be removed: ${reason}`;
          }
        }
        throw error;
      }
    },

    async get(cpId: string): Promise<ChargePointDetails | null> {
      const record = await readRecord(cpId);
      if (record === null) return null;
      const profile = record.securityProfile;
      if (profile !== 0 && profile !== 1 && profile !== 2 && profile !== 3) {
        throw new Error(
          `codetics-ev-server-lite: station ${cpId} has security profile ${String(profile)}`,
        );
      }
      const name = record.name;
      return {
        id: cpId,
        registration: "Accepted",
        security: { profile },
        ...(typeof name === "string" && name !== "" ? { description: name } : {}),
      };
    },

    async update(
      cpId: string,
      patch: ChargePointUpdate,
    ): Promise<ChargePointProvisioned | undefined> {
      checkRegistration("update", patch.registration);
      if (patch.security !== undefined) checkSecurity("update", patch.security);
      if (patch.description !== undefined) checkName("update", patch.description);

      const record = await readRecord(cpId);
      if (record === null) throw new ChargePointNotFoundError(cpId);
      if (patch.description !== undefined && patch.description !== null) {
        // The server replaces the whole record: write back what was read.
        await api.call("PUT", stationPath(cpId), { ...record, name: patch.description });
      }
      const security = patch.security;
      if (security === undefined) return undefined;
      const previous = record.securityProfile;
      if (previous !== security.profile) await setProfile(cpId, security.profile);
      if (security.profile !== 1) return undefined;
      try {
        return { generatedBasicAuthPassword: await rotateSecret(cpId) };
      } catch (error) {
        // Profile 1 with a secret nobody holds is worse than the old profile.
        if (previous !== security.profile && isProfile(previous)) {
          await setProfile(cpId, previous).catch(() => {});
        }
        throw error;
      }
    },

    async delete(cpId: string): Promise<void> {
      await api.call("DELETE", stationPath(cpId), undefined, [404]);
    },
  };
}
