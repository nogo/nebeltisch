/**
 * Passkey checks, with nothing but `crypto.subtle`.
 *
 * The browser hands over the public key as SubjectPublicKeyInfo through `getPublicKey()`, which
 * `crypto.subtle` imports as it is, so no CBOR or COSE parsing is needed. Attestation — which
 * brand of authenticator made the key — is not asked for and not checked: every passkey is
 * accepted (#54). `@simplewebauthn/server` was rejected for breaking the zero-dependency rule.
 *
 * Every function throws `PasskeyError` on anything it will not accept.
 */

export class PasskeyError extends Error {}

/** COSE algorithm ids this server verifies, in the order it offers them. */
export const ES256 = -7;
export const RS256 = -257;
export const ALGORITHMS = [ES256, RS256];

export interface Expected {
  challenge: string;
  origin: string;
  rpId: string;
}

/** What `navigator.credentials.create()` produced, every buffer as base64url. */
export interface CreationResponse {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  publicKey: string;
  publicKeyAlgorithm: number;
}

/** What `navigator.credentials.get()` produced, every buffer as base64url. */
export interface AssertionResponse {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle: string | null;
}

export interface NewPasskey {
  id: string;
  publicKey: Uint8Array;
  algorithm: number;
  signCount: number;
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_DATA = 0x40;

export async function verifyCreation(response: CreationResponse, expected: Expected): Promise<NewPasskey> {
  checkClientData(response.clientDataJSON, "webauthn.create", expected);
  const authData = decode(response.authenticatorData);
  const { flags, signCount } = await checkAuthenticatorData(authData, expected.rpId);
  if (!(flags & FLAG_ATTESTED_DATA)) throw new PasskeyError("No credential in the response");

  // The id the browser reports has to be the one the authenticator signed into its data.
  // Layout after the 37-byte header: 16 bytes AAGUID, a 2-byte length, the credential id.
  if (authData.length < 55) throw new PasskeyError("Authenticator data is too short");
  const idLength = authData.readUInt16BE(53);
  const credentialId = authData.subarray(55, 55 + idLength);
  if (credentialId.length !== idLength || !credentialId.equals(decode(response.id))) {
    throw new PasskeyError("Credential id does not match");
  }

  if (!ALGORITHMS.includes(response.publicKeyAlgorithm)) throw new PasskeyError("Unsupported algorithm");
  const publicKey = decode(response.publicKey);
  try {
    await importKey(publicKey, response.publicKeyAlgorithm);
  } catch {
    throw new PasskeyError("Unreadable public key");
  }

  return { id: response.id, publicKey: new Uint8Array(publicKey), algorithm: response.publicKeyAlgorithm, signCount };
}

/**
 * Checks a login against the stored passkey and returns the new signature counter.
 *
 * The counter only means something when the authenticator keeps one. Synced passkeys always report
 * 0; a hardware key counts up, and a value that does not grow means the key was copied.
 */
export async function verifyAssertion(
  response: AssertionResponse,
  stored: { publicKey: Uint8Array; algorithm: number; signCount: number },
  expected: Expected
): Promise<number> {
  const clientData = checkClientData(response.clientDataJSON, "webauthn.get", expected);
  const authData = decode(response.authenticatorData);
  const { signCount } = await checkAuthenticatorData(authData, expected.rpId);

  const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientData));
  const signed = new Uint8Array(authData.length + clientDataHash.length);
  signed.set(authData, 0);
  signed.set(clientDataHash, authData.length);

  let signature: Uint8Array<ArrayBuffer> = new Uint8Array(decode(response.signature));
  if (stored.algorithm === ES256) signature = derToRaw(signature);

  const key = await importKey(stored.publicKey, stored.algorithm);
  const params = stored.algorithm === ES256 ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  if (!(await crypto.subtle.verify(params, key, signature, signed))) {
    throw new PasskeyError("Signature does not verify");
  }

  if ((signCount !== 0 || stored.signCount !== 0) && signCount <= stored.signCount) {
    throw new PasskeyError("Signature counter went backwards");
  }
  return signCount;
}

/** Returns the raw client data bytes, for the signature check. */
function checkClientData(encoded: string, type: string, expected: Expected): Uint8Array<ArrayBuffer> {
  const raw = new Uint8Array(decode(encoded));
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    data = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new PasskeyError("Unreadable client data");
  }
  if (data.type !== type) throw new PasskeyError("Wrong ceremony");
  if (data.challenge !== expected.challenge) throw new PasskeyError("Wrong challenge");
  if (data.origin !== expected.origin) throw new PasskeyError("Wrong origin");
  if (data.crossOrigin === true) throw new PasskeyError("Cross-origin ceremony");
  return raw;
}

/**
 * Checks the 37-byte header every response carries: the site it was made for, and that a person
 * was there and verified — a fingerprint, face or PIN. A passkey is the only factor here, so
 * verification is required, not preferred.
 */
async function checkAuthenticatorData(authData: Buffer, rpId: string): Promise<{ flags: number; signCount: number }> {
  if (authData.length < 37) throw new PasskeyError("Authenticator data is too short");
  const rpIdHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)));
  if (!authData.subarray(0, 32).equals(rpIdHash)) throw new PasskeyError("Made for another site");
  const flags = authData[32]!;
  if (!(flags & FLAG_USER_PRESENT)) throw new PasskeyError("Nobody was present");
  if (!(flags & FLAG_USER_VERIFIED)) throw new PasskeyError("The person was not verified");
  return { flags, signCount: authData.readUInt32BE(33) };
}

function importKey(spki: Uint8Array, algorithm: number): Promise<CryptoKey> {
  const params =
    algorithm === ES256
      ? { name: "ECDSA", namedCurve: "P-256" }
      : algorithm === RS256
        ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
        : null;
  if (!params) throw new PasskeyError("Unsupported algorithm");
  return crypto.subtle.importKey("spki", new Uint8Array(spki), params, false, ["verify"]);
}

/**
 * An ECDSA signature as WebAuthn sends it — ASN.1 `SEQUENCE { INTEGER r, INTEGER s }` — turned
 * into the 64 bytes `r ‖ s` that `crypto.subtle` verifies.
 */
export function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> {
  const fail = () => new PasskeyError("Unreadable signature");
  if (der[0] !== 0x30) throw fail();
  let at = 2;
  const out = new Uint8Array(64);
  for (const offset of [0, 32]) {
    if (der[at] !== 0x02) throw fail();
    const length = der[at + 1]!;
    let value = der.subarray(at + 2, at + 2 + length);
    if (value.length !== length) throw fail();
    // DER adds a leading zero to keep a high bit from reading as negative.
    while (value.length > 32 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32) throw fail();
    out.set(value, offset + 32 - value.length);
    at += 2 + length;
  }
  return out;
}

function decode(base64url: unknown): Buffer {
  if (typeof base64url !== "string") throw new PasskeyError("Missing field");
  return Buffer.from(base64url, "base64url");
}
