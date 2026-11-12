// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * The EVtivity driver: an independent TypeScript CSMS (Fastify, PostgreSQL,
 * Redis), driven here over OCPP 1.6J. Every operation goes through its REST
 * API -- one synchronous route per 1.6 action, which answers with the
 * station's response -- so the driver needs nothing but that API.
 *
 * Creating the driver does no I/O. The first call that needs the server logs
 * in, once per process, server and account -- see api-client.ts.
 */

import {
  CSMS_OPERATION_16_ACTIONS,
  type CsmsCapabilities,
  type CsmsOperation16,
  type FetchLike,
} from "../contracts.ts";
import type { CsmsConnectorApi, CsmsDriver, CsmsSessionApi } from "../models.ts";
import { EvtivityApi } from "./api-client.ts";
import { DEFAULT_EVTIVITY_DISPATCH_TIMEOUT_MS, type EvtivityConfig } from "./config.ts";
import { dispatch, type EvtivityRefs } from "./requests.ts";

export interface EvtivityCsmsDriverOptions {
  readonly config: EvtivityConfig;
  readonly refs?: EvtivityRefs;
  readonly fetch?: FetchLike;
  readonly sessions?: CsmsSessionApi;
  readonly connectors?: CsmsConnectorApi;
}

/** Every OCPP 1.6 action has its own route, and requests.ts builds each
 *  payload. */
export const EVTIVITY_CAPABILITIES: CsmsCapabilities = {
  operations16: new Set(CSMS_OPERATION_16_ACTIONS),
};

/** Creates the reusable EVtivity operation surface, without TCK lifecycle
 *  hooks. */
export function createEvtivityCsmsDriver(options: EvtivityCsmsDriverOptions): CsmsDriver {
  const api = new EvtivityApi(options.config, options.fetch);
  const refs = options.refs ?? {};
  const timeoutMs = options.config.dispatchTimeoutMs ?? DEFAULT_EVTIVITY_DISPATCH_TIMEOUT_MS;
  return {
    capabilities: EVTIVITY_CAPABILITIES,
    ...(options.sessions ? { sessions: options.sessions } : {}),
    ...(options.connectors ? { connectors: options.connectors } : {}),
    operations16: {
      async execute(cpId: string, operation: CsmsOperation16): Promise<string> {
        return dispatch(api, cpId, operation, refs, timeoutMs);
      },
    },
  };
}

export * from "./api-client.ts";
export * from "./config.ts";
export * from "./requests.ts";
