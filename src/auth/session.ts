import type { Database } from "bun:sqlite";
import type { User } from "../types";
import type { ServerDeps } from "../deps";
import { SESSION_DAYS, getSessionUser } from "../db/sessions";

/**
 * How a request proves who sent it: one session cookie, nothing in a URL (#54, #56).
 *
 * `HttpOnly` keeps page scripts away from it, `SameSite=Strict` keeps other sites from sending it,
 * and `Secure` is added whenever the site is served over HTTPS.
 */
const COOKIE = "nebeltisch_session";

export function sessionIdOf(req: Request): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=") || null;
  }
  return null;
}

export function currentUser(req: Request, db: Database): User | null {
  const id = sessionIdOf(req);
  return id ? getSessionUser(db, id) : null;
}

export function sessionCookie(req: Request, deps: ServerDeps, sessionId: string): string {
  return `${COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secureFlag(req, deps)}`;
}

export function clearedCookie(req: Request, deps: ServerDeps): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureFlag(req, deps)}`;
}

function secureFlag(req: Request, deps: ServerDeps): string {
  return publicOrigin(req, deps).startsWith("https:") ? "; Secure" : "";
}

/**
 * The origin the site is served from, e.g. `https://adventure.ctl.wtf`.
 *
 * `PUBLIC_ORIGIN` when it is configured. Otherwise the request's own host, with the scheme the proxy
 * reports — so a deployment behind Caddy works without configuration, and the checks below still
 * compare a browser's `Origin` against the site it asked.
 */
export function publicOrigin(req: Request, deps: ServerDeps): string {
  if (deps.publicOrigin) return deps.publicOrigin;
  const url = new URL(req.url);
  const scheme = req.headers.get("X-Forwarded-Proto") ?? url.protocol.slice(0, -1);
  return `${scheme}://${req.headers.get("Host") ?? url.host}`;
}

/** The passkey "relying party": the host name a passkey is bound to. */
export function rpIdOf(req: Request, deps: ServerDeps): string {
  return new URL(publicOrigin(req, deps)).hostname;
}

/**
 * False when a browser on another site sent this request.
 *
 * `SameSite=Strict` already keeps the cookie off cross-site requests, but a sibling subdomain of
 * the same site is "same-site" and would still carry it. Browsers always send `Origin` on a write
 * and on a WebSocket upgrade, so a missing header is a non-browser client, which has no victim's
 * cookie to ride on.
 */
export function fromOwnSite(req: Request, deps: ServerDeps): boolean {
  const origin = req.headers.get("Origin");
  return origin === null || origin === publicOrigin(req, deps);
}
