# Coding standards

Base: [TypeScript handbook](https://www.typescriptlang.org/docs/handbook/) under `strict`, and the [Bun docs](https://bun.sh/docs) for runtime APIs. Where this file is silent, they apply. Design decisions and principles live in [docs/architecture.md](docs/architecture.md); this file does not copy them.

## Check

`bun install --frozen-lockfile && bun run test` — typechecks `src`, `test` and `public/js` with `tsc --noEmit`, then runs `bun test`. Must pass before a change is done.

## Measure

`git log --since=3.months --name-only --format= | sort | uniq -c | sort -rn | head -20` — hotspots.
`(cd /tmp && bunx jscpd@4.0.5 --min-lines 8 --reporters console --silent "$OLDPWD/src" "$OLDPWD/public/js")` — duplication. Run from `/tmp` so nothing lands in the repo.
Gap: no complexity, mutation or flakiness command yet.

## TypeScript

### Structure
- Server code in `src/`, client code in `public/js/`, bundled by `bun build` into `public/dist/`.
- `src/db/*.ts` holds one table's queries each, as plain functions that take `db: Database` first. SQL lives only there and in `db/schema.ts`.
- Dependencies are passed in through `ServerDeps` (`src/deps.ts`), built once in `src/index.ts`. Modules do not open their own database or registry.
- `src/fog/` and `src/board.ts` do not import the HTTP or WebSocket layers.
- Every wire message is a member of `ClientMessage` or `ServerMessage` in `src/ws/messages.ts`. The client imports those types with `import type`; it never restates a payload.

### Naming
- Files and functions in camelCase; database columns and row fields in snake_case, as SQLite returns them.
- Wire message types are `noun:verb` (`token:move`, `declaration:open`); the server's reply uses the past tense (`token:moved`).

### Errors
- A WebSocket handler answers a refused message with `{ type: "error", message }` to the sender and `break`s. It does not throw.
- An HTTP route answers with `{ error }` JSON and a status code.
- A swallowed error carries a comment that says why it is safe to ignore.

### Tests
- `bun test` against real SQLite in memory and real servers on a free port (`test/helpers.ts`). No mocks of the database.
- A bug fix comes with a test that failed before it, named after the behaviour, often citing the issue number.

### Dependencies
- No runtime dependencies. `package.json` holds dev types and TypeScript only. Adding one is a decision for `docs/architecture.md`.

## Overrides

- Comments may carry the issue number and the history that produced a rule — the repo uses them as its decision trail, beside `docs/architecture.md`.
