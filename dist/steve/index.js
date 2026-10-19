// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
import { CSMS_OPERATION_16_ACTIONS, } from "../contracts.js";
import { STEVE_CHARGE_POINT_PROFILES, steveChargePoints } from "./charge-points.js";
import { cpSelect, toSteveForm } from "./forms.js";
import { SteveUiOps } from "./ui-client.js";
export const STEVE_CAPABILITIES = {
    operations16: new Set(CSMS_OPERATION_16_ACTIONS),
    chargePoints: { securityProfiles: STEVE_CHARGE_POINT_PROFILES },
};
/**
 * Creates the reusable SteVe operation and charge-point administration
 * surfaces, without TCK lifecycle hooks. Both share one manager-UI session.
 */
export function createSteveCsmsDriver(options) {
    const ui = new SteveUiOps(options.config, options.fetch);
    return {
        capabilities: STEVE_CAPABILITIES,
        ...(options.sessions ? { sessions: options.sessions } : {}),
        ...(options.connectors ? { connectors: options.connectors } : {}),
        chargePoints: steveChargePoints(ui),
        operations16: {
            async execute(cpId, operation) {
                const { opPath, fields } = toSteveForm(operation);
                return ui.op(opPath, { chargePointSelectList: cpSelect(cpId), ...fields });
            },
        },
    };
}
export * from "./api-client.js";
export * from "./forms.js";
export * from "./ui-client.js";
