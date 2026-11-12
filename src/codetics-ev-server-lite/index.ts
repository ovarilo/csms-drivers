// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * The Codetics ev-server-lite driver: an OCPP 1.6J-only CSMS with a REST admin
 * API. Every operation goes through one generic command endpoint, so the
 * driver needs nothing but that API.
 *
 * Creating the driver does no I/O. The first call that needs the server logs
 * in, once per process and account -- see api-client.ts for why that is a
 * limit rather than a nicety.
 */

import {
  CSMS_OPERATION_16_ACTIONS,
  type CsmsCapabilities,
  type CsmsOperation16,
  type FetchLike,
} from "../contracts.ts";
import type { CsmsConnectorApi, CsmsDriver, CsmsSessionApi } from "../models.ts";
import { EvslApi } from "./api-client.ts";
import { DEFAULT_EVSL_DISPATCH_TIMEOUT_MS, type EvslConfig } from "./config.ts";
import { dispatch, toCommand, type EvslRefs } from "./requests.ts";

export interface CodeticsEvServerLiteCsmsDriverOptions {
  readonly config: EvslConfig;
  readonly refs?: EvslRefs;
  readonly fetch?: FetchLike;
  readonly sessions?: CsmsSessionApi;
  readonly connectors?: CsmsConnectorApi;
}

/**
 * Every OCPP 1.6 action is routed: the command endpoint takes them all, and the
 * one shape it refuses -- a GetConfiguration key list -- is a refusal of one
 * operation's argument, thrown as UnsupportedOperationError by requests.ts.
 */
export const CODETICS_EV_SERVER_LITE_CAPABILITIES: CsmsCapabilities = {
  operations16: new Set(CSMS_OPERATION_16_ACTIONS),
};

/** Creates the reusable Codetics ev-server-lite operation surface, without TCK
 *  lifecycle hooks. */
export function createCodeticsEvServerLiteCsmsDriver(
  options: CodeticsEvServerLiteCsmsDriverOptions,
): CsmsDriver {
  const api = new EvslApi(options.config, options.fetch);
  const refs = options.refs ?? {};
  const timeoutMs = options.config.dispatchTimeoutMs ?? DEFAULT_EVSL_DISPATCH_TIMEOUT_MS;
  return {
    capabilities: CODETICS_EV_SERVER_LITE_CAPABILITIES,
    ...(options.sessions ? { sessions: options.sessions } : {}),
    ...(options.connectors ? { connectors: options.connectors } : {}),
    operations16: {
      async execute(cpId: string, operation: CsmsOperation16): Promise<string> {
        return dispatch(api, cpId, toCommand(operation, refs), timeoutMs);
      },
    },
  };
}

export * from "./api-client.ts";
export * from "./config.ts";
export * from "./requests.ts";
