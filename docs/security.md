# Security model

What the code trusts, where, and why. Every line describes the code as it is; facts outside the repo name where they were seen.

## Principals

- **Anonymous visitor**: reaches nothing. Caddy asks for HTTP basic auth on every path before a request reaches the app (see Deployment).
- **Group member**: holds the shared basic-auth login. Can create an adventure (`POST /api/adventures`, `src/routes.ts:110`) and so become a GM of their own.
- **Player**: a group member with an adventure's player link. Joins over the WebSocket, owns one token, moves it, declares and answers attacks, pings the map.
- **GM**: holds an adventure's GM password. Full control of that adventure over REST and WebSocket.
- **Owner**: Danilo. Shell on the host, the database, the deploy config.

## Assets

- Each adventure's hidden state: unrevealed fog, pages not yet presented, monsters on them, start points. Players must not see these (`docs/architecture.md`, start point and preparation sections).
- GM passwords and player links (`adventures.gm_password`, `adventures.player_link`), both stored in plaintext.
- Uploaded map images in `DATA_DIR/uploads/`.
- The process itself: one Bun process serves every table, and the host runs other stacks (budget, trip, ghost).

## Entry surfaces

- **HTTP** `src/routes.ts:38` `handleRequest`. GM routes compare `X-GM-Password` to the stored password per request (`routes.ts:154` and seven siblings). `GET …/images` also accepts `X-Player-Link` (`routes.ts:257`). `POST /api/adventures` and `GET /api/adventures/join/:link` need no app credential.
- **Uploads** `POST /api/adventures/:id/images` (`routes.ts:192`), GM only. Accepts any `File.type` starting with `image/`; keeps an alphanumeric extension from the client's filename. Refuses a header that claims more than `MAX_PAGE_PIXELS` (`src/images.ts`); the fog layer refuses the same at load. No size limit beyond Bun's default request body cap.
- **Static uploads** `/uploads/*` (`routes.ts:35`), Bun `dir` route, no app check. Content type follows the file extension.
- **WebSocket upgrade** `src/ws/handler.ts:176`. Identity is bound once from query parameters: GM by password, player by player link plus name. No `Origin` check.
- **WebSocket messages** `src/ws/handler.ts:397`. Each case checks `conn.role` and scopes ids to `conn.adventureId`. `parseMessage` (`src/ws/messages.ts`) checks every field against `SHAPES` and caps ids, text and stroke batches. A throw inside a handler is caught and answered with an error (`handler.ts`, `message`).
- **CI**: none. No `.github/workflows`.

## Deployment

Seen in `~/Development/infrastructure/rivendell/config.yml` (stack `nebeltisch`) and `network.md`.

- Host `rivendell`, Hetzner CAX11, 4 GB RAM, shared with other stacks. Deployed by herald from `main`, domain `adventure.ctl.wtf`, behind caddy-docker-proxy with TLS.
- Caddy label `caddy.basic_auth: "*"` with one user: the whole site is behind one shared login.
- `compose.yml` runs read-only, `cap_drop: ALL`, `no-new-privileges`, `restart: unless-stopped`, no memory limit.
- `compose.yml` publishes `${PORT:-3000}:3000` on all host interfaces.

## Accepted risks

- **Plaintext GM password in the URL fragment and database** (`docs/architecture.md`, "Lightweight auth"). Adequate for a self-hosted group behind basic auth; replaced by GM accounts (#56).
- **A player link plus a name is the player's identity** (`ws/handler.ts:222`). Anyone with the link who types another player's name takes over that token. Intended: it is how a player rejoins from a bookmark.

## Unverified

- Does a Hetzner cloud firewall, or anything else, block port 3000 on rivendell? If not, `http://91.99.92.151:3000` reaches the app without basic auth, and every "Anonymous visitor" line above is wrong.
- Does Caddy write access logs for this site? If yes, the GM password from the WebSocket query string lands in them (#11).
