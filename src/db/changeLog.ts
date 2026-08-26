import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface ChangeLogRow {
  id: string;
  operation: string;
  status: "previewed" | "committed" | "rolled_back";
  params: string;
  manifest: string;
  undo_snapshot: string | null;
  created_at: string;
  committed_at: string | null;
  rolled_back_at: string | null;
}

export function insertPreview(
  db: Database.Database,
  operation: string,
  params: unknown,
  manifest: unknown,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO change_log (id, operation, status, params, manifest, created_at)
     VALUES (?, ?, 'previewed', ?, ?, ?)`,
  ).run(id, operation, JSON.stringify(params), JSON.stringify(manifest), new Date().toISOString());
  return id;
}

export function getChange(db: Database.Database, id: string): ChangeLogRow | undefined {
  return db.prepare("SELECT * FROM change_log WHERE id = ?").get(id) as ChangeLogRow | undefined;
}

export function markCommitted(db: Database.Database, id: string, undoSnapshot: unknown): void {
  db.prepare(
    "UPDATE change_log SET status = 'committed', undo_snapshot = ?, committed_at = ? WHERE id = ?",
  ).run(JSON.stringify(undoSnapshot), new Date().toISOString(), id);
}

export function markRolledBack(db: Database.Database, id: string): void {
  db.prepare("UPDATE change_log SET status = 'rolled_back', rolled_back_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id,
  );
}
