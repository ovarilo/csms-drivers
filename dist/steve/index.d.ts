import { type CsmsCapabilities } from "../contracts.ts";
import type { FetchLike } from "../contracts.ts";
import type { CsmsDriver } from "../models.ts";
import type { CsmsConnectorApi, CsmsSessionApi } from "../models.ts";
import { type SteveUiConfig } from "./ui-client.ts";
export interface SteveCsmsDriverOptions {
    readonly config: SteveUiConfig;
    readonly fetch?: FetchLike;
    readonly sessions?: CsmsSessionApi;
    readonly connectors?: CsmsConnectorApi;
}
export declare const STEVE_CAPABILITIES: CsmsCapabilities;
/**
 * Creates the reusable SteVe operation and charge-point administration
 * surfaces, without TCK lifecycle hooks. Both share one manager-UI session.
 */
export declare function createSteveCsmsDriver(options: SteveCsmsDriverOptions): CsmsDriver;
export * from "./api-client.ts";
export * from "./forms.ts";
export * from "./ui-client.ts";
