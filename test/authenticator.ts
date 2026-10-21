/**
 * A passkey authenticator in software, for tests: it builds the same bytes a phone or a security
 * key hands the browser, signed with a real P-256 key, so the server's checks run against the real
 * format rather than a mock of it.
 *
 * `flags` and `counter` are open so a test can build what a broken or cloned authenticator would.
 */
import type { AssertionResponse, CreationResponse } from "../src/auth/webauthn";

const b64 = (bytes: Uint8Array | ArrayBuffer) => Buffer.from(new Uint8Array(bytes)).toString("base64url");

export const UP = 0x01;
export const UV = 0x04;
const AT = 0x40;

export interface FakeAuthenticator {
  id: string;
  /** What `navigator.credentials.create()` would return for these server options. */
  create(options: { challenge: string; rp: { id: string } }, origin: string, tweak?: Tweak): Promise<CreationResponse>;
  /** What `navigator.credentials.get()` would return. */
  get(options: { challenge: string; rpId: string }, origin: string, tweak?: Tweak): Promise<AssertionResponse>;
  userHandle: string | null;
  counter: number;
}

interface Tweak {
  flags?: number;
  rpId?: string;
  type?: string;
}

export async function createAuthenticator(): Promise<FakeAuthenticator> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));

  async function header(rpId: string, flags: number, counter: number): Promise<Uint8Array> {
    const out = new Uint8Array(37);
    out.set(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId))), 0);
    out[32] = flags;
    new DataView(out.buffer).setUint32(33, counter);
    return out;
  }

  function clientData(type: string, challenge: string, origin: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  const authenticator: FakeAuthenticator = {
    id: b64(credentialId),
    userHandle: null,
    counter: 0,

    async create(options, origin, tweak = {}) {
      const head = await header(tweak.rpId ?? options.rp.id, tweak.flags ?? UP | UV | AT, authenticator.counter);
      // Attested credential data: AAGUID (zeros, "none"), id length, id, then a COSE key the
      // server does not read — it takes the SPKI form instead.
      const attested = new Uint8Array(18 + credentialId.length + 4);
      new DataView(attested.buffer).setUint16(16, credentialId.length);
      attested.set(credentialId, 18);
      const authData = new Uint8Array([...head, ...attested]);
      return {
        id: authenticator.id,
        clientDataJSON: b64(clientData(tweak.type ?? "webauthn.create", options.challenge, origin)),
        authenticatorData: b64(authData),
        publicKey: b64(spki),
        publicKeyAlgorithm: -7,
      };
    },

    async get(options, origin, tweak = {}) {
      const authData = await header(tweak.rpId ?? options.rpId, tweak.flags ?? UP | UV, authenticator.counter);
      const data = clientData(tweak.type ?? "webauthn.get", options.challenge, origin);
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new Uint8Array([...authData, ...hash]))
      );
      return {
        id: authenticator.id,
        clientDataJSON: b64(data),
        authenticatorData: b64(authData),
        signature: b64(rawToDer(raw)),
        userHandle: authenticator.userHandle,
      };
    },
  };
  return authenticator;
}

/** `r ‖ s` into the DER form authenticators send, leading zero and all. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    let value = bytes.subarray(start);
    if (value[0]! & 0x80) value = new Uint8Array([0, ...value]);
    return [0x02, value.length, ...value];
  };
  const body = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}
