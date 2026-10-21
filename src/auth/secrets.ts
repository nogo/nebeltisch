/**
 * The secrets an account holds, and how they are checked. Only hashes are ever stored.
 *
 * `Bun.password` is argon2id with Bun's defaults — `m=65536,t=2,p=1`, about 90 ms per hash,
 * above the OWASP minimum. The parameters live in the stored string, so raising them later does
 * not break an old hash.
 */

export const PASSWORD_MIN = 8;
/** An upper bound so a megabyte of "password" cannot pin the CPU in argon2. */
export const PASSWORD_MAX = 128;
export const NAME_MAX = 40;

export function hashSecret(secret: string): Promise<string> {
  return Bun.password.hash(secret);
}

let dummyHash: Promise<string> | null = null;

/**
 * True only when `hash` exists and `secret` matches it.
 *
 * A missing hash — no such user, or a passkey-only account — still runs a full verify against a
 * throwaway hash, so a wrong name takes as long as a wrong password and the timing does not say
 * which names exist.
 */
export async function verifySecret(secret: string, hash: string | null | undefined): Promise<boolean> {
  dummyHash ??= Bun.password.hash("no account has this secret");
  const matches = await Bun.password.verify(secret, hash ?? (await dummyHash));
  return matches && !!hash;
}

/** Null when acceptable, otherwise what to tell the person. No composition rules, only length. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) {
    return `A password needs at least ${PASSWORD_MIN} characters`;
  }
  if (password.length > PASSWORD_MAX) return `A password can have at most ${PASSWORD_MAX} characters`;
  return null;
}

/** The trimmed name, or null when it cannot be one. */
export function cleanName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > NAME_MAX) return null;
  // Control characters would make two names look alike on screen.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

// ---- Recovery phrase ----

/** Crockford's base32: no I, L, O or U, so nothing on paper reads as something else. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PHRASE_LENGTH = 24;

/**
 * A new recovery phrase: 120 random bits as six groups of four, like `K7QF-M2XA-…`.
 *
 * Shown once and stored as a hash. Guessing it is out of reach even with the database in hand.
 */
export function newRecoveryPhrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array((PHRASE_LENGTH * 5) / 8));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join("-");
}

/**
 * The phrase as it is hashed: upper case, no dashes or spaces, and the letters people write by
 * mistake read the way Crockford decodes them. Null when it cannot be a phrase at all.
 */
export function normalizePhrase(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (cleaned.length !== PHRASE_LENGTH) return null;
  for (const ch of cleaned) if (!CROCKFORD.includes(ch)) return null;
  return cleaned;
}
