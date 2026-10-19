// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
import { CSMS_OPERATION_16_ACTIONS, CSMS_OPERATION_201_ACTIONS, } from "../contracts.js";
import { CitrineMessageApi } from "./api-client.js";
import { toCitrineRequest, toCitrineRequest201 } from "./requests.js";
import { speaksOcpp201, unroutedActions, unroutedActions201 } from "./variant.js";
export function citrineOsCapabilities(config) {
    const unsupported16 = unroutedActions(config.variant);
    const unsupported201 = unroutedActions201(config.variant);
    return {
        operations16: new Set(CSMS_OPERATION_16_ACTIONS.filter((action) => !unsupported16.has(action))),
        ...(speaksOcpp201(config.variant)
            ? {
                operations201: new Set(CSMS_OPERATION_201_ACTIONS.filter((action) => !unsupported201.has(action))),
            }
            : {}),
    };
}
/** Creates the reusable CitrineOS operation surface without TCK lifecycle hooks. */
export function createCitrineOsCsmsDriver(options) {
    const api = new CitrineMessageApi(options.config, options.fetch);
    return {
        capabilities: citrineOsCapabilities(options.config),
        ...(options.sessions ? { sessions: options.sessions } : {}),
        ...(options.connectors ? { connectors: options.connectors } : {}),
        operations16: {
            async execute(cpId, operation) {
                const request = await toCitrineRequest(operation, options.refs, options.config.variant);
                return api.send(cpId, request);
            },
        },
        ...(speaksOcpp201(options.config.variant)
            ? {
                operations201: {
                    async execute(cpId, operation) {
                        return api.send(cpId, toCitrineRequest201(operation, options.config.variant));
                    },
                },
            }
            : {}),
    };
}
export * from "./api-client.js";
export * from "./config.js";
export * from "./requests.js";
export * from "./variant.js";
