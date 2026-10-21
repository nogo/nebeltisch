import { describe, it, expect } from "bun:test";
import { newRecoveryPhrase, normalizePhrase, verifySecret, hashSecret, cleanName } from "../../src/auth/secrets";
import { derToRaw } from "../../src/auth/webauthn";
import { rawToDer } from "../authenticator";

describe("recovery phrase", () => {
  it("is six groups of four Crockford characters, different every time", () => {
    const a = newRecoveryPhrase();
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
    expect(newRecoveryPhrase()).not.toBe(a);
  });

  it("reads back however it was copied off paper", () => {
    expect(normalizePhrase("k7qf-m2xa-0000-1111-zzzz-abcd")).toBe("K7QFM2XA00001111ZZZZABCD");
    expect(normalizePhrase("K7QF M2XA OOOO IIII ZZZZ ABCD")).toBe("K7QFM2XA00001111ZZZZABCD");
    expect(normalizePhrase("K7QFM2XA0000LLLLZZZZABCD")).toBe("K7QFM2XA00001111ZZZZABCD");
  });

  it("refuses what cannot be a phrase", () => {
    expect(normalizePhrase("too-short")).toBeNull();
    expect(normalizePhrase("UUUU-UUUU-UUUU-UUUU-UUUU-UUUU")).toBeNull();
    expect(normalizePhrase(42)).toBeNull();
  });
});

describe("verifySecret", () => {
  it("is false without a hash, after the same work as a real check", async () => {
    const hash = await hashSecret("secret phrase");
    expect(await verifySecret("secret phrase", hash)).toBe(true);
    expect(await verifySecret("wrong", hash)).toBe(false);
    expect(await verifySecret("no account has this secret", null)).toBe(false);
  });
});

describe("cleanName", () => {
  it("trims, and refuses empty, long and control-character names", () => {
    expect(cleanName("  Mira ")).toBe("Mira");
    expect(cleanName("   ")).toBeNull();
    expect(cleanName("x".repeat(41))).toBeNull();
    expect(cleanName("Mi\u0000ra")).toBeNull();
  });
});

describe("derToRaw", () => {
  it("undoes DER for values with and without a leading zero", () => {
    for (const first of [0x00, 0x7f, 0x80, 0xff]) {
      const raw = new Uint8Array(64).map((_, i) => (i * 7 + 3) & 0xff);
      raw[0] = first;
      raw[32] = 0xff - first;
      expect(derToRaw(rawToDer(raw))).toEqual(raw);
    }
  });
});
