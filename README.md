# Nebeltisch

A collaborative tabletop tool for remote pen & paper RPGs. The GM uploads maps, controls fog of war with a brush, and switches the active scene. Players join via a share link, pick a name and color, and move their own token.

Opinionated toward German-language systems (e.g. *Das Schwarze Auge* / Aventuria), but system-agnostic at the data layer.

## Stack

- **Runtime:** Bun (raw `Bun.serve()` — no framework)
- **Database:** `bun:sqlite` (WAL mode)
- **Realtime:** Bun native WebSocket pub/sub
- **Frontend:** Vanilla TypeScript + HTML5 Canvas

## Develop

```sh
bun install
bun run dev
```

Server runs on `http://localhost:3000`. Data is persisted in `./data`.

## Test

```sh
bun test
```

## Deploy

```sh
docker compose up -d
```

The container exposes port `3000` and persists state in the `nebeltisch-data` volume. Configure via:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP listener |
| `DATA_DIR` | `/app/data` | SQLite + uploaded maps |

## License

MIT — see [LICENSE](LICENSE).
