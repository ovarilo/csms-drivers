// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * The wire form of a {@link CommandOutcome}. A WHITELIST: only the documented
 * fields of the outcome's state are copied, so a property a driver adds (a
 * receipt, a raw CSMS body) cannot leave through the adapter, and a value that
 * is not one of the six states is the daemon's fault, not an outcome.
 */
import type { CommandOutcome } from "../contracts.ts";
import { redact, redactDeep } from "./errors.ts";

/** Throws a plain `Error` (so the adapter answers 500 `internal`) for a value
 *  that is not a command outcome. Strings and keys carry the redaction. */
export function encodeCommandOutcome(outcome: unknown, secrets: readonly string[]): unknown {
  if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) {
    throw new Error("the driver returned a command outcome that is not an object");
  }
  const o = outcome as Record<string, unknown>;
  const text = (key: string): [string, unknown][] =>
    typeof o[key] === "string" ? [[key, redact(o[key] as string, secrets)]] : [];
  const fields = (...parts: [string, unknown][][]): Record<string, unknown> =>
    Object.fromEntries(parts.flat());
  const state = o.state as CommandOutcome["state"];
  switch (state) {
    case "unsupported":
      return fields([["state", state]], text("reason"));
    case "rejected":
      return fields([["state", state]], text("at"), text("detail"));
    case "accepted":
      return fields([["state", state]], text("at"), text("ref"));
    case "confirmed":
      return fields(
        [["state", state]],
        text("at"),
        text("ref"),
        o.response === undefined ? [] : [["response", redactDeep(o.response, secrets)]],
      );
    case "failed":
      return fields([["state", state]], text("at"), text("ref"), text("detail"));
    case "unknown":
      return fields([["state", state]], text("at"), text("ref"), text("cause"), text("detail"));
    default:
      throw new Error(
        `the driver returned a command outcome in an unknown state: ${String(state)}`,
      );
  }
}
