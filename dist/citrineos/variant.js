// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
import { CSMS_OPERATION_201_ACTIONS, } from "../contracts.js";
export const DEFAULT_VARIANT = "v2";
export function resolveVariant(env) {
    const raw = env.CITRINE_VARIANT;
    if (raw === undefined || raw === "")
        return DEFAULT_VARIANT;
    if (raw === "v2")
        return DEFAULT_VARIANT;
    if (raw === "v1")
        return "v1";
    throw new Error(`citrineos: CITRINE_VARIANT must be "v1" or "v2", got ${JSON.stringify(raw)}`);
}
/** Shared reason for the reservation routes absent from both supported lines. */
export const NO_RESERVATIONS = "CitrineOS routes no OCPP 1.6 endpoint for ReserveNow or CancelReservation: " +
    "the 1.6 schemas and the Reservations table exist, but no @AsMessageEndpoint " +
    "binds either action to OCPPVersion.OCPP1_6 and no 1.6 response handler " +
    "exists (verified at v1.9.1, v2.0.0-beta1 and v2.0.0), so the path answers 404.";
export const NO_LOCAL_LIST = "CitrineOS v1.9.1 routes no OCPP 1.6 endpoint for SendLocalList or " +
    "GetLocalListVersion. Its message API registers 16 OCPP 1.6 routes; the v2 " +
    "line registers 18, with this pair accounting for the difference.";
export const NO_OCPP_201_ON_V1 = "CitrineOS v1.9.1 has no measured OCPP 2.0.1 routes; this driver exposes " +
    "that protocol on the v2 line only.";
const UNROUTED_16 = {
    v2: new Map([
        ["ReserveNow", NO_RESERVATIONS],
        ["CancelReservation", NO_RESERVATIONS],
    ]),
    v1: new Map([
        ["ReserveNow", NO_RESERVATIONS],
        ["CancelReservation", NO_RESERVATIONS],
        ["SendLocalList", NO_LOCAL_LIST],
        ["GetLocalListVersion", NO_LOCAL_LIST],
    ]),
};
const UNROUTED_201 = {
    v2: new Map(),
    v1: new Map(CSMS_OPERATION_201_ACTIONS.map((action) => [action, NO_OCPP_201_ON_V1])),
};
export function unroutedActions(variant) {
    return UNROUTED_16[variant];
}
export function unroutedActions201(variant) {
    return UNROUTED_201[variant];
}
export function speaksOcpp201(variant) {
    return variant === "v2";
}
