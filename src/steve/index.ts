// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0

import {
  CSMS_OPERATION_16_ACTIONS,
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
}

export const STEVE_CAPABILITIES: CsmsCapabilities = {
  operations16: new Set(CSMS_OPERATION_16_ACTIONS),
  chargePoints: { securityProfiles: STEVE_CHARGE_POINT_PROFILES },
};

/**
 * Creates the reusable SteVe operation and charge-point administration
 * surfaces, without TCK lifecycle hooks. Both share one manager-UI session.
 */
export function createSteveCsmsDriver(options: SteveCsmsDriverOptions): CsmsDriver {
  const ui = new SteveUiOps(options.config, options.fetch);
  return {
    capabilities: STEVE_CAPABILITIES,
    ...(options.sessions ? { sessions: options.sessions } : {}),
    ...(options.connectors ? { connectors: options.connectors } : {}),
    chargePoints: steveChargePoints(ui),
    operations16: {
      async execute(cpId: string, operation: CsmsOperation16): Promise<string> {
        const { opPath, fields } = toSteveForm(operation);
        return ui.op(opPath, { chargePointSelectList: cpSelect(cpId), ...fields });
      },
    },
  };
}

export * from "./api-client.ts";
export * from "./forms.ts";
export * from "./ui-client.ts";
