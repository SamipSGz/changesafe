/**
 * SQLite connection management.
 *
 * Two separate connections to the SAME file, on purpose:
 *
 *   - `writeDb()`  -- normal read/write handle. Only preview/commit/rollback
 *                     logic in db-mcp-server.ts touches this, and even then
 *                     preview_change always rolls back its transaction.
 *   - `readonlyDb()` -- opened with SQLite's own `readonly: true` flag, so
 *                     `query_readonly` physically cannot execute a write no
 *                     matter what SQL text it's given. This is a real
 *                     guarantee enforced by SQLite itself, not just a
 *                     string-matching guard on the input.
 *
 * We use SQLite instead of a "real" Postgres instance so this repo stays
 * true to the README's "a stranger can run it" bar: no Docker, no hosted
 * DB, no connection string to configure. The database is still a real SQL
 * engine with real transactions, foreign keys, and constraints -- the
 * blast-radius and rollback logic in db-mcp-server.ts is not a simulation.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
export const DB_PATH = join(DATA_DIR, "changesafe.db");
const SCHEMA_PATH = join(__dirname, "schema.sql");

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

let _writeDb: Database.Database | undefined;
let _readonlyDb: Database.Database | undefined;

export function writeDb(): Database.Database {
  if (!_writeDb) {
    ensureDataDir();
    _writeDb = new Database(DB_PATH);
    _writeDb.pragma("foreign_keys = ON");
    _writeDb.exec(readFileSync(SCHEMA_PATH, "utf-8"));
  }
  return _writeDb;
}

export function readonlyDb(): Database.Database {
  if (!_readonlyDb) {
    if (!existsSync(DB_PATH)) {
      // Force creation/migration via the write handle first.
      writeDb();
    }
    _readonlyDb = new Database(DB_PATH, { readonly: true });
  }
  return _readonlyDb;
}

export function closeAll(): void {
  _writeDb?.close();
  _readonlyDb?.close();
  _writeDb = undefined;
  _readonlyDb = undefined;
}
