const HTTP_TIMEOUT_MS = 15_000;
export function defaultApiConfig(cfg, env = process.env) {
    return {
        baseUrl: env.STEVE_API_URL ?? cfg.baseUrl.replace(/\/manager\/?$/, "/api/v1"),
        username: env.STEVE_API_USER ?? cfg.username,
        password: env.STEVE_API_PASS ?? "ocpp-tck",
    };
}
export class SteveWebApi {
    cfg;
    /** Encoded once. Rebuilding it per request would put a base64 of the
     *  credentials inside the one-second poll loop in records.ts. */
    authorization;
    constructor(cfg) {
        this.cfg = cfg;
        this.authorization = `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`;
    }
    /** GET, decoded. The shape is the caller's to declare: this module knows the
     *  transport, `records.ts` and `provision.ts` know the payloads. */
    async getJson(path, params = []) {
        const res = await this.request("GET", path, { params, allowed: [200] });
        return (await res.json());
    }
    /**
     * A write. `allowed` defaults to the pair SteVe actually answers with -- 200
     * from a controller returning a value, 204 from a `void` one -- and 201
     * because POST /ocppTags may answer either.
     *
     * The failure description is derived from the request rather than passed in,
     * which is the point of having this at all: three call sites used to spell
     * out "DELETE /ocppTags/${pk}" beside the very call that said it, and a
     * hand-written label is one refactor away from describing a different route.
     */
    async send(method, path, opts = {}) {
        return this.request(method, path, {
            allowed: opts.allowed ?? [200, 201, 204],
            init: {
                method,
                ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
            },
        });
    }
    /** Whether the WebAPI answers with the configured credentials. A probe, so a
     *  rejection is an answer ("no") rather than a failure. */
    async reachable() {
        try {
            return (await this.raw("/ocppTags", {})).status === 200;
        }
        catch {
            return false;
        }
    }
    /**
     * One request, checked. The single place that decides what an unacceptable
     * status looks like, so the body-truncation and the message shape cannot
     * drift per call site.
     */
    async request(method, path, opts) {
        const res = await this.raw(path, opts.init ?? {}, opts.params);
        if (opts.allowed.includes(res.status))
            return res;
        const what = `${method} ${path}`;
        throw new Error(res.status === 401 || res.status === 403
            ? `steve api: ${what} returned ${res.status}. WebAPI access is off until ` +
                `web_user.api_password is set before using the WebAPI.`
            : `steve api: ${what} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    async raw(path, init, params = []) {
        const query = new URLSearchParams(params).toString();
        return fetch(`${this.cfg.baseUrl}${path}${query ? `?${query}` : ""}`, {
            ...init,
            headers: {
                authorization: this.authorization,
                "content-type": "application/json",
            },
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
    }
}
