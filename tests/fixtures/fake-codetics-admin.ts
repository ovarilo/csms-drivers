// Copyright 2026 Julien Herr
// SPDX-License-Identifier: Apache-2.0
/**
 * A fake Codetics ev-server-lite admin API, enough for the station
 * administration the driver does: signin, then create, read, replace, change
 * security, rotate the secret and delete a station.
 *
 * The routes and their rules are the ones the driver's header lists
 * (api-client.ts, charge-points.ts): creation answers `{id, secret}` and always
 * starts on profile 1, the secret is never read back, `PUT /stations/{id}`
 * replaces the whole record, `PUT .../security` is applied server-side only
 * with `sendToStation: false`, and `DELETE` answers 409 while a session is
 * active. The record's member names are the driver's assumption about the
 * server, kept here in one place.
 */
import type { FetchLike } from "../../src/contracts.ts";

export interface FakeStation {
  id: string;
  name: string;
  enabled: boolean;
  securityProfile: number;
  /** Never part of a read. */
  secret: string;
}

export interface FakeCodeticsAdminSent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export interface FakeCodeticsAdmin {
  readonly fetch: FetchLike;
  readonly stations: Map<string, FakeStation>;
  /** Ids a DELETE refuses with 409, as an active session would. */
  readonly active: Set<string>;
  /** Every admin request, signin and csrf excluded. */
  readonly sent: FakeCodeticsAdminSent[];
  /** Every request, signin and csrf included, never reset by the fake. */
  readonly all: FakeCodeticsAdminSent[];
  /** Faults to inject; each is off until a test turns it on. */
  readonly faults: {
    /** `PUT .../security` answers 500 without changing the profile. */
    security: boolean;
    /** `POST .../secret` answers 500 without rotating. */
    secret: boolean;
    /** `POST /stations` answers 201 with the station made but no secret. */
    omitSecret: boolean;
    /** `DELETE` answers 500 and removes nothing. */
    delete: boolean;
  };
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers });
}

export function fakeCodeticsAdmin(): FakeCodeticsAdmin {
  const stations = new Map<string, FakeStation>();
  const active = new Set<string>();
  const sent: FakeCodeticsAdminSent[] = [];
  const all: FakeCodeticsAdminSent[] = [];
  const faults = { security: false, secret: false, omitSecret: false, delete: false };
  let secrets = 0;
  const newSecret = (): string => `generated-secret-${++secrets}`;
  const read = (s: FakeStation): Record<string, unknown> => ({
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    securityProfile: s.securityProfile,
  });

  const fetchImpl: FetchLike = async (input, init) => {
    const method = init?.method ?? "GET";
    const path = new URL(input).pathname;
    const raw: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    all.push({ method, path, body: raw });
    if (method === "GET" && path === "/api/v1/auth/csrf") {
      return json({ token: "csrf-1", headerName: "X-XSRF-TOKEN" }, 200, {
        "set-cookie": "XSRF-TOKEN=csrf-1; Path=/",
      });
    }
    if (method === "POST" && path === "/api/v1/auth/app/signin") return json({ token: "bearer-1" });

    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    sent.push({ method, path, body });
    const fields = (body ?? {}) as Record<string, unknown>;

    if (method === "POST" && path === "/api/v1/stations") {
      const id = fields.id;
      if (typeof id !== "string" || id === "") return json({ error: "id required" }, 400);
      if (typeof fields.name !== "string" || fields.name.trim() === "") {
        return json({ error: "name required" }, 400);
      }
      if (stations.has(id)) return json({ error: "exists" }, 409);
      const secret = newSecret();
      stations.set(id, { id, name: fields.name, enabled: true, securityProfile: 1, secret });
      return json(faults.omitSecret ? { id } : { id, secret }, 201);
    }

    const match = /^\/api\/v1\/stations\/([^/]+)(\/security|\/secret)?$/.exec(path);
    if (match === null) return json({ error: `unexpected ${method} ${path}` }, 404);
    const id = decodeURIComponent(match[1]!);
    const station = stations.get(id);
    if (station === undefined) return json({ error: "not found" }, 404);

    if (match[2] === undefined && method === "GET") return json(read(station));
    if (match[2] === undefined && method === "PUT") {
      if (typeof fields.name !== "string" || fields.name.trim() === "") {
        return json({ error: "name required" }, 400);
      }
      // The whole record is replaced: a member the body omits is lost.
      station.name = fields.name;
      station.enabled = typeof fields.enabled === "boolean" ? fields.enabled : false;
      return json(read(station));
    }
    if (match[2] === undefined && method === "DELETE") {
      if (faults.delete) return json({ error: "boom" }, 500);
      if (active.has(id)) return json({ error: "active session" }, 409);
      stations.delete(id);
      return new Response(null, { status: 204 });
    }
    if (match[2] === "/security" && method === "PUT") {
      if (faults.security) return json({ error: "boom" }, 500);
      if (fields.sendToStation !== false) return json({ error: "station not connected" }, 409);
      if (typeof fields.securityProfile !== "number") return json({ error: "profile" }, 400);
      station.securityProfile = fields.securityProfile;
      return new Response(null, { status: 204 });
    }
    if (match[2] === "/secret" && method === "POST") {
      if (faults.secret) return json({ error: "boom" }, 500);
      station.secret = newSecret();
      return json({ id, secret: station.secret });
    }
    return json({ error: `unexpected ${method} ${path}` }, 404);
  };
  return { fetch: fetchImpl, stations, active, sent, all, faults };
}
