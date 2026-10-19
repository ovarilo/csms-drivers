import { InvalidInputError, literals, ObjectReader, present } from "./decode.js";
const REGISTRATIONS = literals({
    Accepted: true,
    Pending: true,
    Rejected: true,
});
const PROFILES = Object.keys({
    0: true,
    1: true,
    2: true,
    3: true,
}).map(Number);
function security(r) {
    const profile = r.oneOf("profile", PROFILES);
    if (profile === 1 || profile === 2) {
        const basicAuthPassword = r.string("basicAuthPassword");
        if (basicAuthPassword === "")
            throw new InvalidInputError("security.basicAuthPassword must not be empty");
        return { profile, basicAuthPassword };
    }
    // Profiles 0 and 3 carry no password; one sent anyway is refused by done().
    return { profile };
}
export function decodeChargePointDefinition(body) {
    const r = new ObjectReader(body, "body");
    const id = r.string("id");
    if (id === "")
        throw new InvalidInputError("body.id must not be empty");
    const definition = present({
        id,
        registration: r.optOneOf("registration", REGISTRATIONS),
        security: r.optObject("security", security),
        description: r.optString("description"),
    });
    r.done();
    return definition;
}
export function decodeChargePointUpdate(body) {
    const r = new ObjectReader(body, "body");
    const description = r.has("description") && r.raw("description") === null ? null : r.optString("description");
    const update = present({
        registration: r.optOneOf("registration", REGISTRATIONS),
        security: r.optObject("security", security),
        description,
    });
    r.done();
    return update;
}
/** The read-back, rebuilt member by member so that nothing a driver adds -- a
 *  password above all -- reaches the client. */
export function encodeChargePointDetails(details) {
    return present({
        id: details.id,
        registration: details.registration,
        security: { profile: details.security.profile },
        description: details.description,
    });
}
