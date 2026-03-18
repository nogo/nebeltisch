import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { createSchema } from "./schema";

export function initDatabase(path: string = `${process.env.DATA_DIR || "./data"}/fogofwar.db`): Database {
  if (path !== ":memory:") {
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) mkdirSync(dir, { recursive: true });
  }
  const db = new Database(path);
  createSchema(db);
  return db;
}
