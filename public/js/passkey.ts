import type { AssertionResponse, CreationResponse } from '../../src/auth/webauthn';

/**
 * The browser half of a passkey ceremony: server options in, a JSON-safe response out.
 *
 * Every buffer crosses the wire as base64url. The public key goes as SubjectPublicKeyInfo from
 * `getPublicKey()`, which is what lets the server verify it with `crypto.subtle` alone (#54).
 */

/** False on a browser without passkeys, and on any page not served over HTTPS or from localhost. */
export function passkeysAvailable(): boolean {
  return window.isSecureContext && typeof window.PublicKeyCredential === 'function';
}

const toBytes = (b64url: string): Uint8Array<ArrayBuffer> => {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

const toB64url = (buffer: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface CreationOptionsJSON {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  authenticatorSelection: AuthenticatorSelectionCriteria;
  attestation: AttestationConveyancePreference;
  excludeCredentials: { type: 'public-key'; id: string }[];
  timeout: number;
}

export async function createPasskey(options: CreationOptionsJSON): Promise<CreationResponse> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: toBytes(options.challenge),
      user: { ...options.user, id: toBytes(options.user.id) },
      excludeCredentials: options.excludeCredentials.map((c) => ({ ...c, id: toBytes(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was created');
  const response = credential.response as AuthenticatorAttestationResponse;
  const publicKey = response.getPublicKey();
  if (!publicKey) throw new Error('This passkey uses a kind of key Nebeltisch cannot check');
  return {
    id: toB64url(credential.rawId),
    clientDataJSON: toB64url(response.clientDataJSON),
    authenticatorData: toB64url(response.getAuthenticatorData()),
    publicKey: toB64url(publicKey),
    publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
  };
}

export async function usePasskey(options: {
  challenge: string;
  rpId: string;
  userVerification: UserVerificationRequirement;
  timeout: number;
}): Promise<AssertionResponse> {
  const credential = (await navigator.credentials.get({
    publicKey: { ...options, challenge: toBytes(options.challenge) },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was chosen');
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: toB64url(credential.rawId),
    clientDataJSON: toB64url(response.clientDataJSON),
    authenticatorData: toB64url(response.authenticatorData),
    signature: toB64url(response.signature),
    userHandle: response.userHandle ? toB64url(response.userHandle) : null,
  };
}
