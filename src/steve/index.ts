// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0

import {
  CSMS_OPERATION_16_ACTIONS,
  type CommandOutcome,
  type CsmsCapabilities,
  type CsmsOperation16,
} from "../contracts.ts";
import type { FetchLike } from "../contracts.ts";
import type { CsmsDriver } from "../models.ts";
import type { CsmsConnectorApi, CsmsSessionApi } from "../models.ts";
import { STEVE_CHARGE_POINT_PROFILES, steveChargePoints } from "./charge-points.ts";
import { cpSelect, toSteveForm } from "./forms.ts";
import { SteveUiOps, type SteveUiConfig } from "./ui-client.ts";

export interface SteveCsmsDriverOptions {
  readonly config: SteveUiConfig;
  readonly fetch?: FetchLike;
  readonly sessions?: CsmsSessionApi;
  readonly connectors?: CsmsConnectorApi;
  /**
   * The parent SteVe stores for an OCPP tag, null for none. Only a ReserveNow
   * carrying a `parentIdTag` asks it: SteVe sends the reserved tag's stored
   * parent and has no field for another one, so without this lookup such a
   * request is refused as unsupported rather than posted with its parent
   * dropped. The manager UI cannot answer it; SteVe's WebAPI can
   * (`GET /ocppTags` reports `parentIdTag`).
   */
  readonly ocppTagParent?: (idTag: string) => Promise<string | null>;
}

export const STEVE_CAPABILITIES: CsmsCapabilities = {
  operations16: new Set(CSMS_OPERATION_16_ACTIONS),
  chargePoints: {
    securityProfiles: STEVE_CHARGE_POINT_PROFILES,
    // SteVe's form offers all three; declared rather than left to the default.
    registrations: new Set(["Accepted", "Pending", "Rejected"]),
    // Explicit rather than left to the defaults: the caller picks the Basic
    // Auth password, and a station may have no description.
    basicAuthPassword: "supplied",
    description: "optional",
  },
  // SteVe's task page is not read back: a posted form is dispatched, and the
  // station's answer is never observed.
  commands: { completion: "accepted", polling: false },
};

/**
 * Creates the reusable SteVe operation and charge-point administration
 * surfaces, without TCK lifecycle hooks. Both share one manager-UI session.
 */
export function createSteveCsmsDriver(options: SteveCsmsDriverOptions): CsmsDriver {
  const ui = new SteveUiOps(options.config, options.fetch);
  async function execute(cpId: string, operation: CsmsOperation16): Promise<string> {
    const reservedTagParent =
      operation.action === "ReserveNow" &&
      operation.parentIdTag !== undefined &&
      options.ocppTagParent
        ? await options.ocppTagParent(operation.idTag)
        : undefined;
    const { opPath, fields } = toSteveForm(operation, { reservedTagParent });
    return ui.op(opPath, { chargePointSelectList: cpSelect(cpId), ...fields });
  }
  return {
    capabilities: STEVE_CAPABILITIES,
    ...(options.sessions ? { sessions: options.sessions } : {}),
    ...(options.connectors ? { connectors: options.connectors } : {}),
    chargePoints: steveChargePoints(ui),
    operations16: { execute },
    commands: {
      // The task SteVe opens is not a handle anything can follow, so there is
      // no ref. Whatever `execute` throws is thrown here too.
      async submit16(cpId, operation, opts): Promise<CommandOutcome> {
        opts?.signal?.throwIfAborted();
        await execute(cpId, operation);
        return { state: "accepted", at: new Date().toISOString() };
      },
    },
  };
}

export * from "./api-client.ts";
export * from "./forms.ts";
export * from "./ui-client.ts";
