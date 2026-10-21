# Security model

What the code trusts, where, and why. Every line describes the code as it is; facts outside the repo name where they were seen.

## Principals

- **Anonymous visitor**: reaches nothing. Caddy asks for HTTP basic auth on every path before a request reaches the app (see Deployment).
- **Group member**: holds the shared basic-auth login. Can sign up (`/api/auth/signup/*`, `src/auth/routes.ts`) and so become a GM of their own adventures.
- **Player**: a group member with an adventure's player link. Joins over the WebSocket, owns one token, moves it, declares and answers attacks, pings the map.
- **GM**: a signed-in account listed in `adventure_gms` for the adventure. Full control of it over REST and WebSocket — including deleting it and adding or removing other GMs — and of nothing it is not a GM of.
- **Owner**: Danilo. Shell on the host, the database, the deploy config.

## Assets

- Each adventure's hidden state: unrevealed fog, pages not yet presented, monsters on them, start points. Players must not see these (`docs/architecture.md`, start point and preparation sections).
- Account secrets: password and recovery-phrase hashes (argon2id), session-id hashes (SHA-256), passkey public keys. None signs anyone in on its own.
- Player links (`adventures.player_link`), stored in plaintext: each is an adventure's invite.
- Uploaded map images in `DATA_DIR/uploads/`, never served as a directory.
- The process itself: one Bun process serves every table, and the host runs other stacks (budget, trip, ghost).

## Entry surfaces

- **HTTP** `src/routes.ts` `handleRequest`. Any non-GET under `/api/` with a foreign `Origin` is refused first. GM routes go through `asGm()`: a session cookie whose user is one of the adventure's GMs. `GET …/images/:imageId/file` also accepts `X-Player-Link`, for the presented page only. `GET /api/adventures/join/:link` needs no app credential.
- **Accounts** `src/auth/routes.ts`, under `/api/auth/`. Sign-up, login (passkey or password) and recovery need no session; adding a passkey and setting a password do. Passkey challenges are single-use and expire after five minutes. No rate limit.
- **Uploads** `POST /api/adventures/:id/images` (`routes.ts:192`), GM only. Accepts any `File.type` starting with `image/`; keeps an alphanumeric extension from the client's filename. Refuses a header that claims more than `MAX_PAGE_PIXELS` (`src/images.ts`); the fog layer refuses the same at load. No size limit beyond Bun's default request body cap.
- **Map files** `GET /api/adventures/:id/images/:imageId/file`, the only way to an uploaded file. Any page to its GMs, the presented page to a holder of the invite link, 404 to anyone else. The file is found through its `images` row. Only png, jpeg, webp and gif go out as images; any other extension, `.svg` included, goes out as `application/octet-stream` with `nosniff`.
- **WebSocket upgrade** `src/ws/handler.ts` `handleWsUpgrade`. Identity is bound once: a GM by session cookie and ownership, after a foreign `Origin` is refused; a player by player link plus name from query parameters.
- **WebSocket messages** `src/ws/handler.ts:397`. Each case checks `conn.role` and scopes ids to `conn.adventureId`. `parseMessage` (`src/ws/messages.ts`) checks every field against `SHAPES` and caps ids, text and stroke batches. A throw inside a handler is caught and answered with an error (`handler.ts`, `message`).
- **CI**: none. No `.github/workflows`.

## Deployment

Seen in `~/Development/infrastructure/rivendell/config.yml` (stack `nebeltisch`) and `network.md`.

- Host `rivendell`, Hetzner CAX11, 4 GB RAM, shared with other stacks. Deployed by herald from `main`, domain `adventure.ctl.wtf`, behind caddy-docker-proxy with TLS.
- Caddy label `caddy.basic_auth: "*"` with one user: the whole site is behind one shared login.
- `compose.yml` runs read-only, `cap_drop: ALL`, `no-new-privileges`, `restart: unless-stopped`, no memory limit.
- `compose.yml` publishes `${PORT:-3000}:3000` on all host interfaces.

## Accepted risks

- **No rate limit on login or recovery.** Basic auth stands in front, and argon2 makes each guess cost about 90 ms. Real at public launch.
- **Plaintext GM passwords in backups** taken before the accounts release. The live database has none (`docs/architecture.md`, migrations).
- **A player link plus a name is the player's identity** (`ws/handler.ts:222`). Anyone with the link who types another player's name takes over that token. Intended: it is how a player rejoins from a bookmark.

## Unverified

- Does a Hetzner cloud firewall, or anything else, block port 3000 on rivendell? If not, `http://91.99.92.151:3000` reaches the app without basic auth, and every "Anonymous visitor" line above is wrong.
