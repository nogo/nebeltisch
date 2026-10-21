/**
 * One-time WebAuthn challenges, held in memory between the two steps of a passkey ceremony.
 *
 * Memory rather than a table: a challenge lives for minutes, and a restart only means "try again".
 * One store per process, built in `index.ts` and passed through `ServerDeps`.
 */

/** What the ceremony was started for, and the account it concerns. */
export type ChallengePurpose =
  | { kind: "signup"; userId: string; name: string }
  | { kind: "add"; userId: string }
  | { kind: "login" };

export interface ChallengeStore {
  issue(purpose: ChallengePurpose): string;
  /** The purpose, once: a challenge is consumed by the first attempt, right or wrong. */
  take(challenge: string): ChallengePurpose | null;
}

const LIFETIME_MS = 5 * 60 * 1000;

export function createChallengeStore(now: () => number = Date.now): ChallengeStore {
  const pending = new Map<string, { purpose: ChallengePurpose; expires: number }>();
  return {
    issue(purpose) {
      for (const [key, entry] of pending) if (entry.expires <= now()) pending.delete(key);
      const challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      pending.set(challenge, { purpose, expires: now() + LIFETIME_MS });
      return challenge;
    },
    take(challenge) {
      const entry = pending.get(challenge);
      if (!entry) return null;
      pending.delete(challenge);
      return entry.expires > now() ? entry.purpose : null;
    },
  };
}
