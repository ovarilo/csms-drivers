// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * Charge-point administration: registering a station with a CSMS before it
 * connects, and maintaining that registration.
 *
 * Administrative provisioning, not OCPP -- nothing here becomes a CALL, which
 * is why it is a surface of its own rather than an arm of the operation
 * vocabularies. The model is CSMS-neutral: it names what OCPP and its security
 * profiles define, and leaves every CSMS's own form fields to its driver.
 */
/** `create` was asked for an id the CSMS already has. Nothing was changed. */
export class ChargePointAlreadyExistsError extends Error {
    cpId;
    constructor(cpId) {
        super(`charge point ${cpId} already exists`);
        this.cpId = cpId;
        this.name = "ChargePointAlreadyExistsError";
    }
}
/** `update` was asked for an id the CSMS does not have. Nothing was created. */
export class ChargePointNotFoundError extends Error {
    cpId;
    constructor(cpId) {
        super(`charge point ${cpId} does not exist`);
        this.cpId = cpId;
        this.name = "ChargePointNotFoundError";
    }
}
